import { prisma } from "./db";
import { ApiError, type SessionUser } from "./auth";
import type { OfficialApplicationInput } from "./constants";
import { formatOfficialId, OFFICIAL_ID_WIDTH, departmentLabel } from "./constants";
import { send } from "./notificationDomain";
import type { OfficialApplication, OfficialProfile } from "@prisma/client";

/**
 * Official domain service — admin-reviewed official onboarding.
 *
 * Mirrors the proven workerDomain.ts lifecycle (application → review →
 * transactional approval), with ADMIN as the reviewer:
 *
 *   CITIZEN/WORKER applies (employeeId = real-world municipal staff ID)
 *     → PENDING
 *     → ADMIN reviews
 *     → APPROVED: ONE transaction creates OfficialProfile + generates the
 *       CivicShield Official ID (CS-OFF-0001…) + transitions User.role
 *     → or REJECTED (reason required; no privileges, role unchanged)
 *
 * Identity rules (same contract as the worker domain):
 *  - The applicant is ALWAYS the authenticated session user.
 *  - The reviewer is ALWAYS the authenticated ADMIN session user.
 *  - officialId is a PLATFORM identifier (not a government credential) and is
 *    generated server-side only — never accepted from, or influenced by, any
 *    client input. It is deliberately unrelated to email or Firebase UID.
 *  - Uniqueness is enforced by DB constraints (@@unique([employeeId, status]),
 *    @@unique([applicantId, status]), OfficialProfile.userId/officialId
 *    @unique) with race-safe P2002 handling here.
 */

export type PublicOfficialApplication = {
  id: string;
  status: string;
  employeeId: string;
  departmentCode: string;
  designation: string | null;
  municipality: string;
  officialEmail: string | null;
  phone: string | null;
  serviceAreas: string[];
  experience: string | null;
  applicationDetails: string | null;
  createdAt: string;
  reviewedAt: string | null;
  rejectionReason: string | null;
  applicantName?: string;
};

export type PublicOfficialProfile = {
  id: string;
  officialId: string;
  departmentCode: string;
  departmentName: string;
  designation: string | null;
  municipality: string;
  serviceAreas: string[];
  phone: string | null;
  workEmail: string | null;
  approvedAt: string;
};

const deptCode = { select: { code: true } } as const;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Shape an application row for API responses (dates → ISO strings). */
export function toPublicOfficialApplication(
  a: OfficialApplication & { department?: { code: string } | null; applicant?: { name: string } | null }
): PublicOfficialApplication {
  return {
    id: a.id,
    status: a.status,
    employeeId: a.employeeId,
    departmentCode: a.department?.code ?? "",
    designation: a.designation,
    municipality: a.municipality,
    officialEmail: a.officialEmail,
    phone: a.phone,
    serviceAreas: a.serviceAreas,
    experience: a.experience,
    applicationDetails: a.applicationDetails,
    createdAt: a.createdAt.toISOString(),
    reviewedAt: iso(a.reviewedAt),
    rejectionReason: a.rejectionReason,
    applicantName: a.applicant?.name,
  };
}

/** Shape a profile row for API responses. */
export function toPublicOfficialProfile(
  p: OfficialProfile & { department?: { code: string; name: string } | null }
): PublicOfficialProfile {
  return {
    id: p.id,
    officialId: p.officialId,
    departmentCode: p.department?.code ?? "",
    departmentName: p.department?.name ?? "",
    designation: p.designation,
    municipality: p.municipality,
    serviceAreas: p.serviceAreas,
    phone: p.phone,
    workEmail: p.workEmail,
    approvedAt: p.approvedAt.toISOString(),
  };
}

function isP2002(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "P2002" || /unique constraint|duplicate key/i.test(e?.message ?? "");
}

const VAGUE_ID_CONFLICT = "This employee ID is already registered or under review.";

/** Who may apply to become an official: citizens and workers. */
export const OFFICIAL_APPLY_ROLES = ["CITIZEN", "WORKER"] as const;

/**
 * submitOfficialApplication — the authenticated user applies for official
 * verification. Rules mirror the worker flow: one live (PENDING or APPROVED)
 * application per applicant; one live application per employee ID; a
 * REJECTED applicant may reapply (a corrected resubmission reuses the ID).
 */
export async function submitOfficialApplication(
  user: SessionUser,
  input: OfficialApplicationInput
): Promise<PublicOfficialApplication> {
  if (!(OFFICIAL_APPLY_ROLES as readonly string[]).includes(user.role)) {
    throw new ApiError(409, `Only citizens and workers can apply to become officials (you are ${user.role}).`);
  }

  const department = await prisma.department.findUnique({ where: { code: input.departmentCode } });
  if (!department) throw new ApiError(400, "Unknown department");

  const liveStatuses = ["PENDING", "APPROVED"] as const;

  const [ownLive, employeeLive] = await Promise.all([
    prisma.officialApplication.findFirst({
      where: { applicantId: user.id, status: { in: [...liveStatuses] } },
    }),
    prisma.officialApplication.findFirst({
      where: { employeeId: input.employeeId, status: { in: [...liveStatuses] } },
    }),
  ]);

  if (ownLive) {
    throw new ApiError(
      409,
      ownLive.status === "PENDING"
        ? "You already have a pending official application."
        : "You are already an approved official."
    );
  }
  if (employeeLive) {
    // Deliberately vague: never disclose whether another person holds the ID.
    throw new ApiError(409, VAGUE_ID_CONFLICT);
  }

  // WorkerProfile shares the municipal employee-ID namespace: an ID already
  // verified as a worker must not also become an official identity.
  const workerClash = await prisma.workerProfile.findUnique({ where: { employeeId: input.employeeId } });
  if (workerClash) throw new ApiError(409, VAGUE_ID_CONFLICT);

  try {
    const created = await prisma.officialApplication.create({
      data: {
        applicantId: user.id,
        employeeId: input.employeeId,
        departmentId: department.id,
        designation: input.designation,
        municipality: input.municipality,
        officialEmail: input.officialEmail,
        phone: input.phone,
        serviceAreas: input.serviceAreas,
        experience: input.experience,
        applicationDetails: input.applicationDetails,
        status: "PENDING",
      },
      include: { department: deptCode, applicant: { select: { name: true } } },
    });

    // Notify every admin that an application awaits review (best-effort after
    // the application exists; deduped by event key per recipient).
    const admins = await prisma.user.findMany({ where: { role: "ADMIN" }, select: { id: true } });
    await Promise.all(
      admins.map((a) =>
        send(prisma, {
          recipientId: a.id,
          type: "OFFICIAL_APPLICATION_SUBMITTED",
          title: "New official application",
          body: `${created.applicant.name} applied for official verification (${departmentLabel(input.departmentCode)}).`,
          dedupeKey: `official-application:submitted:${created.id}:${a.id}`,
          data: { applicationId: created.id },
        })
      )
    );

    return toPublicOfficialApplication(created);
  } catch (err) {
    // Race: two applications claimed the same employeeId simultaneously.
    if (isP2002(err)) throw new ApiError(409, VAGUE_ID_CONFLICT);
    throw err;
  }
}

/** Own latest application for the authenticated user. */
export async function getMyOfficialApplication(
  user: SessionUser
): Promise<PublicOfficialApplication | null> {
  const app = await prisma.officialApplication.findFirst({
    where: { applicantId: user.id },
    orderBy: { createdAt: "desc" },
    include: { department: deptCode },
  });
  return app ? toPublicOfficialApplication(app) : null;
}

/** Admin: pending applications, oldest first (fair review order). */
export async function listPendingOfficialApplications() {
  const apps = await prisma.officialApplication.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    include: {
      department: deptCode,
      applicant: { select: { id: true, name: true, email: true, image: true } },
    },
  });
  return apps.map((a) => ({
    ...toPublicOfficialApplication(a),
    applicant: { id: a.applicant.id, name: a.applicant.name, email: a.applicant.email, image: a.applicant.image },
  }));
}

/** Admin: verified official registry with account linkage. */
export async function listOfficialProfiles() {
  const profiles = await prisma.officialProfile.findMany({
    include: {
      department: { select: { code: true, name: true } },
      user: { select: { id: true, name: true, email: true } },
    },
    orderBy: { officialId: "asc" },
  });
  return profiles.map((p) => ({
    ...toPublicOfficialProfile(p),
    userId: p.userId,
    userName: p.user.name,
    userEmail: p.user.email,
  }));
}

/**
 * reviewOfficialApplication — ADMIN decision. APPROVE runs in ONE
 * transaction: OfficialProfile creation (with the generated CivicShield
 * Official ID) + User.role=OFFICIAL + application status. Re-reviewing an
 * approved application is idempotent (returns the existing profile); a
 * concurrent approval loses cleanly with a 409. REJECTED applications stay
 * rejected (no re-review) — the applicant may submit a fresh application.
 */
export async function reviewOfficialApplication(
  reviewer: SessionUser,
  applicationId: string,
  decision: "APPROVE" | "REJECT",
  rejectionReason?: string
): Promise<{ application: PublicOfficialApplication; profile?: PublicOfficialProfile }> {
  if (reviewer.role !== "ADMIN") throw new ApiError(403, "Only admins can review official applications");
  if (decision === "REJECT" && !rejectionReason) {
    throw new ApiError(400, "A rejection reason is required");
  }

  const app = await prisma.officialApplication.findUnique({
    where: { id: applicationId },
    include: { department: deptCode },
  });
  if (!app) throw new ApiError(404, "Application not found");

  if (app.status === "APPROVED") {
    // Idempotent re-approval: return the existing verified state untouched.
    const existing = await prisma.officialProfile.findUnique({
      where: { userId: app.applicantId },
      include: { department: { select: { code: true, name: true } } },
    });
    return {
      application: toPublicOfficialApplication(app),
      profile: existing ? toPublicOfficialProfile(existing) : undefined,
    };
  }
  if (app.status === "REJECTED") {
    throw new ApiError(409, "Application was already rejected");
  }

  if (decision === "REJECT") {
    const rejected = await prisma.officialApplication.update({
      where: { id: app.id },
      data: { status: "REJECTED", reviewedById: reviewer.id, reviewedAt: new Date(), rejectionReason },
      include: { department: deptCode, applicant: { select: { name: true } } },
    });
    await auditOfficialDecision(reviewer, "reject_official_application", app, {
      applicationId: app.id,
      employeeId: app.employeeId,
      departmentCode: app.department.code,
      reason: rejectionReason,
    });
    await send(prisma, {
      recipientId: app.applicantId,
      type: "OFFICIAL_APPLICATION_REJECTED",
      title: "Official application rejected",
      body: rejectionReason ?? "Contact the reviewing admin for details.",
      dedupeKey: `official-application:rejected:${app.id}`,
      data: { applicationId: app.id },
    });
    return { application: toPublicOfficialApplication(rejected) };
  }

  // ── APPROVE — single atomic transaction ─────────────────────────────────
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Official ID: high-water-mark over the profile table (fixed-width
      // lexicographic max === numeric max, same proven pattern as refCode).
      // The UNIQUE constraint on OfficialProfile.officialId arbitrates races;
      // a losing tx rolls back completely (application stays PENDING).
      const agg = await tx.officialProfile.aggregate({
        _max: { officialId: true },
        where: { officialId: { startsWith: "CS-OFF-" } },
      });
      const lastSeq = agg._max.officialId ? Number(agg._max.officialId.slice(-OFFICIAL_ID_WIDTH)) : 0;
      const officialId = formatOfficialId(lastSeq + 1);

      const profile = await tx.officialProfile.create({
        data: {
          userId: app.applicantId,
          officialId,
          departmentId: app.departmentId,
          designation: app.designation,
          municipality: app.municipality,
          serviceAreas: app.serviceAreas,
          applicationId: app.id,
          phone: app.phone,
          workEmail: app.officialEmail,
          approvedById: reviewer.id,
        },
      });
      await tx.user.update({
        where: { id: app.applicantId },
        data: { role: "OFFICIAL", departmentId: app.departmentId, phone: app.phone ?? undefined },
      });
      const application = await tx.officialApplication.update({
        where: { id: app.id },
        data: { status: "APPROVED", reviewedById: reviewer.id, reviewedAt: new Date() },
      });
      return { profile, application };
    });

    await auditOfficialDecision(reviewer, "approve_official_application", app, {
      applicationId: app.id,
      employeeId: app.employeeId,
      departmentCode: app.department.code,
      officialId: result.profile.officialId,
      approvedUserId: app.applicantId,
    });

    // Post-commit notifications (best-effort; deduped by event key).
    await send(prisma, {
      recipientId: app.applicantId,
      type: "OFFICIAL_APPLICATION_APPROVED",
      title: "Official access approved",
      body: `You are now a verified official (CivicShield ID ${result.profile.officialId}).`,
      dedupeKey: `official-application:approved:${app.id}`,
      data: { applicationId: app.id, officialId: result.profile.officialId },
    });

    const approved = await prisma.officialProfile.findUnique({
      where: { userId: app.applicantId },
      include: { department: { select: { code: true, name: true } } },
    });
    return {
      application: toPublicOfficialApplication(result.application),
      profile: approved ? toPublicOfficialProfile(approved) : undefined,
    };
  } catch (err) {
    if (isP2002(err)) {
      // Concurrent approval raced on officialId/userId — nothing persisted.
      throw new ApiError(409, "This application was just processed by another reviewer. Refresh and try again.");
    }
    throw err;
  }
}

/**
 * Audit trail for review decisions — reuses the established AgentActivity
 * mechanism (agent:"OfficialReview", action, summary, JSON detail). Contains
 * only ids/codes/reason — never contact data.
 */
async function auditOfficialDecision(
  reviewer: SessionUser,
  action: string,
  app: OfficialApplication & { department?: { code: string } | null },
  detail: Record<string, unknown>
) {
  await prisma.agentActivity.create({
    data: {
      agent: "OfficialReview",
      action,
      summary: `Official application ${app.employeeId} ${action === "approve_official_application" ? "APPROVED" : "REJECTED"} by ${reviewer.email}`,
      detail: JSON.stringify(detail),
    },
  });
}
