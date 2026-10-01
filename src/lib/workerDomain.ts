import { prisma } from "./db";
import { ApiError, type SessionUser } from "./auth";
import type { WorkerApplicationInput } from "./constants";
import { APPLICATION_STATUS } from "./constants";
import type { WorkerApplication, WorkerProfile } from "@prisma/client";

/**
 * Worker domain service (Phase 2A) — worker applications, official
 * verification, and verified worker profiles.
 *
 * Identity rules:
 *  - The applicant is ALWAYS the authenticated session user (never a
 *    client-supplied id).
 *  - The reviewer is ALWAYS the authenticated OFFICIAL session user.
 *  - Employee ID is the worker identity attribute; email/domain is never
 *    proof of worker identity (workEmail is optional contact data only).
 *
 * Uniqueness is enforced by DB constraints (schema @@unique([employeeId,
 * status]) / @@unique([applicantId, status]) covering PENDING + APPROVED
 * rows, plus WorkerProfile.employeeId @unique), with race-safe P2002
 * handling at this layer.
 */

export type ApplicationStatus = (typeof APPLICATION_STATUS)[number];

export type PublicWorkerApplication = {
  id: string;
  status: ApplicationStatus;
  employeeId: string;
  departmentCode: string;
  designation: string | null;
  skills: string[];
  equipment: string[];
  experience: string | null;
  serviceAreas: string[];
  phone: string | null;
  workEmail: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  applicantName?: string;
};

export type PublicWorkerProfile = {
  id: string;
  employeeId: string;
  departmentCode: string;
  departmentName: string;
  designation: string | null;
  skills: string[];
  equipment: string[];
  availability: string;
  serviceAreas: string[];
  phone: string | null;
  workEmail: string | null;
  approvedAt: Date;
};

const deptCode = { select: { code: true } } as const;

/** Shape an application row for API responses (no internal ids leaked). */
export function toPublicApplication(
  a: WorkerApplication & { department?: { code: string } | null; applicant?: { name: string } | null }
): PublicWorkerApplication {
  return {
    id: a.id,
    status: a.status as ApplicationStatus,
    employeeId: a.employeeId,
    departmentCode: a.department?.code ?? "",
    designation: a.designation,
    skills: a.skills,
    equipment: a.equipment,
    experience: a.experience,
    serviceAreas: a.serviceAreas,
    phone: a.phone,
    workEmail: a.workEmail,
    createdAt: a.createdAt,
    reviewedAt: a.reviewedAt,
    rejectionReason: a.rejectionReason,
    applicantName: a.applicant?.name,
  };
}

/** Shape a profile row for API responses. */
export function toPublicProfile(
  p: WorkerProfile & { department?: { code: string; name: string } | null }
): PublicWorkerProfile {
  return {
    id: p.id,
    employeeId: p.employeeId,
    departmentCode: p.department?.code ?? "",
    departmentName: p.department?.name ?? "",
    designation: p.designation,
    skills: p.skills,
    equipment: p.equipment,
    availability: p.availability,
    serviceAreas: p.serviceAreas,
    phone: p.phone,
    workEmail: p.workEmail,
    approvedAt: p.approvedAt,
  };
}

function isP2002(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "P2002" || /unique constraint|duplicate key/i.test(e?.message ?? "");
}

const VAGUE_ID_CONFLICT = "This employee ID is already registered or under review.";

/**
 * submitWorkerApplication — the authenticated user applies to become a
 * verified worker.
 *
 * Rules:
 *  - WORKER/OFFICIAL users cannot apply (they already hold privileges).
 *  - One live (PENDING or APPROVED) application per applicant.
 *  - One live (PENDING or APPROVED) application per employee ID.
 *  - A REJECTED applicant may reapply (a corrected resubmission reuses the ID).
 */
export async function submitWorkerApplication(
  user: SessionUser,
  input: WorkerApplicationInput
): Promise<PublicWorkerApplication> {
  if (user.role !== "CITIZEN") {
    throw new ApiError(409, `Only citizens can apply to become workers (you are ${user.role}).`);
  }

  const department = await prisma.department.findUnique({ where: { code: input.departmentCode } });
  if (!department) throw new ApiError(400, "Unknown department");

  const liveStatuses = ["PENDING", "APPROVED"] as const;

  const [ownLive, employeeLive] = await Promise.all([
    prisma.workerApplication.findFirst({
      where: { applicantId: user.id, status: { in: [...liveStatuses] } },
    }),
    prisma.workerApplication.findFirst({
      where: { employeeId: input.employeeId, status: { in: [...liveStatuses] } },
    }),
  ]);

  if (ownLive) {
    throw new ApiError(
      409,
      ownLive.status === "PENDING"
        ? "You already have a pending worker application."
        : "You are already an approved worker."
    );
  }
  if (employeeLive) {
    // Deliberately vague: never disclose whether another person holds the ID.
    throw new ApiError(409, VAGUE_ID_CONFLICT);
  }

  // WorkerProfile uniqueness is the final authority on the ID (covers seeded
  // workers created before the application flow existed).
  const profileClash = await prisma.workerProfile.findUnique({ where: { employeeId: input.employeeId } });
  if (profileClash) throw new ApiError(409, VAGUE_ID_CONFLICT);

  try {
    const created = await prisma.workerApplication.create({
      data: {
        applicantId: user.id,
        employeeId: input.employeeId,
        departmentId: department.id,
        designation: input.designation,
        skills: input.skills,
        equipment: input.equipment,
        experience: input.experience,
        serviceAreas: input.serviceAreas,
        phone: input.phone,
        workEmail: input.workEmail,
        status: "PENDING",
      },
      include: { department: deptCode, applicant: { select: { name: true } } },
    });
    return toPublicApplication(created);
  } catch (err) {
    // Race: two applications claimed the same employeeId simultaneously.
    if (isP2002(err)) throw new ApiError(409, VAGUE_ID_CONFLICT);
    throw err;
  }
}

/** Own latest application for the authenticated user. */
export async function getMyWorkerApplication(user: SessionUser): Promise<PublicWorkerApplication | null> {
  const app = await prisma.workerApplication.findFirst({
    where: { applicantId: user.id },
    orderBy: { createdAt: "desc" },
    include: { department: deptCode },
  });
  return app ? toPublicApplication(app) : null;
}

/** Official: pending applications, oldest first (fair review order). */
export async function listPendingWorkerApplications() {
  const apps = await prisma.workerApplication.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    include: {
      department: deptCode,
      applicant: { select: { id: true, name: true, email: true, image: true } },
    },
  });
  return apps.map((a) => ({
    ...toPublicApplication(a),
    applicant: { id: a.applicant.id, name: a.applicant.name, email: a.applicant.email, image: a.applicant.image },
  }));
}

/**
 * reviewWorkerApplication — official decision. APPROVE runs in ONE
 * transaction: WorkerProfile creation + User.role=WORKER + application
 * status, so no partial state can ever persist. Re-reviewing an already
 * approved application is idempotent (returns the existing profile); a
 * concurrent duplicate-employeeId approval loses cleanly with a 409.
 */
export async function reviewWorkerApplication(
  reviewer: SessionUser,
  applicationId: string,
  decision: "APPROVE" | "REJECT",
  rejectionReason?: string
): Promise<{ application: PublicWorkerApplication; profile?: PublicWorkerProfile }> {
  if (reviewer.role !== "OFFICIAL") throw new ApiError(403, "Only officials can review worker applications");
  if (decision === "REJECT" && !rejectionReason) {
    throw new ApiError(400, "A rejection reason is required");
  }

  const app = await prisma.workerApplication.findUnique({
    where: { id: applicationId },
    include: { department: deptCode },
  });
  if (!app) throw new ApiError(404, "Application not found");

  if (app.status === "APPROVED") {
    // Idempotent re-approval: return the existing verified state untouched.
    const existing = await prisma.workerProfile.findUnique({
      where: { userId: app.applicantId },
      include: { department: { select: { code: true, name: true } } },
    });
    return {
      application: toPublicApplication(app),
      profile: existing ? toPublicProfile(existing) : undefined,
    };
  }
  if (app.status === "REJECTED") {
    throw new ApiError(409, "Application was already rejected");
  }

  if (decision === "REJECT") {
    const rejected = await prisma.workerApplication.update({
      where: { id: app.id },
      data: { status: "REJECTED", reviewedById: reviewer.id, reviewedAt: new Date(), rejectionReason },
      include: { department: deptCode, applicant: { select: { name: true } } },
    });
    await auditWorkerDecision(reviewer, "reject_worker_application", app, {
      applicationId: app.id,
      employeeId: app.employeeId,
      departmentCode: app.department.code,
      reason: rejectionReason,
    });
    return { application: toPublicApplication(rejected) };
  }

  // ── APPROVE — single atomic transaction ─────────────────────────────────
  try {
    const result = await prisma.$transaction(async (tx) => {
      const profile = await tx.workerProfile.create({
        data: {
          userId: app.applicantId,
          employeeId: app.employeeId,
          departmentId: app.departmentId,
          designation: app.designation,
          skills: app.skills,
          equipment: app.equipment,
          availability: "AVAILABLE",
          serviceAreas: app.serviceAreas,
          phone: app.phone,
          workEmail: app.workEmail,
          approvedById: reviewer.id,
        },
      });
      await tx.user.update({
        where: { id: app.applicantId },
        data: { role: "WORKER", departmentId: app.departmentId, phone: app.phone ?? undefined },
      });
      const application = await tx.workerApplication.update({
        where: { id: app.id },
        data: { status: "APPROVED", reviewedById: reviewer.id, reviewedAt: new Date() },
      });
      return { profile, application };
    });

    await auditWorkerDecision(reviewer, "approve_worker_application", app, {
      applicationId: app.id,
      employeeId: app.employeeId,
      departmentCode: app.department.code,
      approvedUserId: app.applicantId,
    });

    const approved = await prisma.workerProfile.findUnique({
      where: { userId: app.applicantId },
      include: { department: { select: { code: true, name: true } } },
    });
    return {
      application: toPublicApplication(result.application),
      profile: approved ? toPublicProfile(approved) : undefined,
    };
  } catch (err) {
    if (isP2002(err)) {
      // Concurrent approval raced on the employeeId — nothing persisted.
      throw new ApiError(409, VAGUE_ID_CONFLICT);
    }
    throw err;
  }
}

/** Worker: own verified profile (404 when absent — no existence oracle). */
export async function getMyWorkerProfile(user: SessionUser): Promise<PublicWorkerProfile> {
  const profile = await prisma.workerProfile.findUnique({
    where: { userId: user.id },
    include: { department: { select: { code: true, name: true } } },
  });
  if (!profile) throw new ApiError(404, "No verified worker profile for this account");
  return toPublicProfile(profile);
}

/** Official: verified worker registry with profile data (Phase 2A read model). */
export async function listWorkerProfiles() {
  const profiles = await prisma.workerProfile.findMany({
    include: {
      department: { select: { code: true, name: true } },
      user: { select: { id: true, name: true } },
    },
    orderBy: { employeeId: "asc" },
  });
  return profiles.map((p) => ({ ...toPublicProfile(p), userId: p.userId, userName: p.user.name }));
}

/**
 * Audit trail for review decisions — reuses the established AgentActivity
 * mechanism (agent:"WorkerReview", action, summary, JSON detail). Contains
 * only ids/codes/reason — never contact data.
 */
async function auditWorkerDecision(
  reviewer: SessionUser,
  action: string,
  app: WorkerApplication & { department?: { code: string } | null },
  detail: Record<string, unknown>
) {
  await prisma.agentActivity.create({
    data: {
      agent: "WorkerReview",
      action,
      summary: `Application ${app.employeeId} ${action === "approve_worker_application" ? "APPROVED" : "REJECTED"} by ${reviewer.email}`,
      detail: JSON.stringify(detail),
    },
  });
}
