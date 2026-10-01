import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePrismaMock, mockPrismaModule } from "./helpers/prisma-mock";

/**
 * Phase 2A — official review + approval transaction tests (service layer).
 * The mock $transaction executes the callback against the same client, so
 * these tests verify orchestration, ordering, failure propagation, and the
 * audit write. Physical atomicity/rollback is only provable against a live
 * PostgreSQL database (documented in docs/PHASE2A_REPORT.md).
 */

const prisma = makePrismaMock();
mockPrismaModule(prisma);

const { reviewWorkerApplication, listPendingWorkerApplications, getMyWorkerProfile, listWorkerProfiles } =
  await import("@/lib/workerDomain");

const CITIZEN = { id: "u_citizen", email: "citizen@example.com", name: "Citizen", role: "CITIZEN" as const, departmentId: null };
const WORKER = { ...CITIZEN, id: "u_worker", role: "WORKER" as const };
const OFFICIAL = { ...CITIZEN, id: "u_official", email: "official@example.com", role: "OFFICIAL" as const };

const application = (over: Record<string, unknown> = {}) => ({
  id: "wa1",
  applicantId: "u_applicant",
  employeeId: "PWD-014",
  departmentId: "dept_pwd",
  designation: "Road Repair Technician",
  skills: ["ROAD_REPAIR"],
  equipment: ["DRILL"],
  experience: null,
  serviceAreas: ["Ward 1"],
  phone: "+91 90000 00123",
  workEmail: null,
  status: "PENDING",
  reviewedById: null,
  reviewedAt: null,
  rejectionReason: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  department: { code: "PWD" },
  // Relation shape returned by the service's findMany include (officials' list).
  applicant: { id: "u_applicant", name: "Applicant Name", email: "applicant@example.com", image: null },
  ...over,
});

const profileRow = (over: Record<string, unknown> = {}) => ({
  id: "wp1",
  userId: "u_applicant",
  employeeId: "PWD-014",
  departmentId: "dept_pwd",
  designation: "Road Repair Technician",
  skills: ["ROAD_REPAIR"],
  equipment: ["DRILL"],
  availability: "AVAILABLE",
  serviceAreas: ["Ward 1"],
  baseLat: null,
  baseLng: null,
  maxActiveAssignments: 3,
  phone: "+91 90000 00123",
  workEmail: null,
  approvedById: OFFICIAL.id,
  approvedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  department: { code: "PWD", name: "Public Works Department" },
  user: { id: "u_applicant", name: "Applicant Name" },
  ...over,
});

describe("authorization (RBAC)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.workerApplication.findUnique.mockResolvedValue(application());
  });

  it("citizen cannot review applications (403)", async () => {
    await expect(reviewWorkerApplication(CITIZEN, "wa1", "APPROVE")).rejects.toMatchObject({ status: 403 });
    await expect(reviewWorkerApplication(CITIZEN, "wa1", "REJECT", "not convinced")).rejects.toMatchObject({ status: 403 });
  });

  it("worker cannot review applications (403)", async () => {
    await expect(reviewWorkerApplication(WORKER, "wa1", "APPROVE")).rejects.toMatchObject({ status: 403 });
  });

  it("official can review; unknown application is 404", async () => {
    prisma.workerApplication.findUnique.mockResolvedValue(null);
    await expect(reviewWorkerApplication(OFFICIAL, "wa_missing", "APPROVE")).rejects.toMatchObject({ status: 404 });
  });

  it("rejection without a reason is refused (400) before any state change", async () => {
    await expect(reviewWorkerApplication(OFFICIAL, "wa1", "REJECT")).rejects.toMatchObject({ status: 400 });
    expect(prisma.workerApplication.update).not.toHaveBeenCalled();
  });
});

describe("rejection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.workerApplication.findUnique.mockResolvedValue(application());
    prisma.workerApplication.update.mockResolvedValue(application({ status: "REJECTED", rejectionReason: "ID not verifiable with HR" }));
    prisma.agentActivity.create.mockResolvedValue({});
  });

  it("records reviewer, timestamp, reason, and an audit row — no profile, no role change", async () => {
    const result = await reviewWorkerApplication(OFFICIAL, "wa1", "REJECT", "ID not verifiable with HR");
    expect(result.application.status).toBe("REJECTED");
    expect(result.profile).toBeUndefined();

    expect(prisma.workerApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "wa1" },
        data: expect.objectContaining({
          status: "REJECTED",
          reviewedById: OFFICIAL.id,
          reviewedAt: expect.any(Date),
          rejectionReason: "ID not verifiable with HR",
        }),
      })
    );
    expect(prisma.workerProfile.create).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.agentActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ agent: "WorkerReview", action: "reject_worker_application" }),
      })
    );
    // The audit summary must not leak contact data.
    const auditArg = prisma.agentActivity.create.mock.calls[0][0];
    expect(JSON.stringify(auditArg)).not.toContain("+91 90000 00123");
  });

  it("does not re-review a REJECTED application (409)", async () => {
    prisma.workerApplication.findUnique.mockResolvedValue(application({ status: "REJECTED" }));
    await expect(reviewWorkerApplication(OFFICIAL, "wa1", "APPROVE")).rejects.toMatchObject({ status: 409 });
  });
});

describe("approval transaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.workerApplication.findUnique.mockResolvedValue(application());
    prisma.workerProfile.create.mockResolvedValue(profileRow());
    prisma.user.update.mockResolvedValue({ id: "u_applicant", role: "WORKER" });
    prisma.workerApplication.update.mockResolvedValue(application({ status: "APPROVED" }));
    prisma.workerProfile.findUnique.mockResolvedValue(profileRow());
    prisma.agentActivity.create.mockResolvedValue({});
  });

  it("creates profile, transitions role, marks approved, records reviewer, and audits — in one transaction", async () => {
    const result = await reviewWorkerApplication(OFFICIAL, "wa1", "APPROVE");
    expect(result.profile?.employeeId).toBe("PWD-014");
    expect(result.profile?.availability).toBe("AVAILABLE");
    expect(result.application.status).toBe("APPROVED");

    // All three writes happened inside the SAME $transaction call.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.workerProfile.create).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u_applicant" }, data: expect.objectContaining({ role: "WORKER" }) })
    );
    expect(prisma.workerApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "wa1" },
        data: expect.objectContaining({ status: "APPROVED", reviewedById: OFFICIAL.id }),
      })
    );
    expect(prisma.agentActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ agent: "WorkerReview", action: "approve_worker_application" }),
      })
    );
  });

  it("profile creation carries the application's capability data and approver", async () => {
    await reviewWorkerApplication(OFFICIAL, "wa1", "APPROVE");
    const createArg = prisma.workerProfile.create.mock.calls[0][0];
    expect(createArg.data).toMatchObject({
      userId: "u_applicant",
      employeeId: "PWD-014",
      departmentId: "dept_pwd",
      skills: ["ROAD_REPAIR"],
      equipment: ["DRILL"],
      serviceAreas: ["Ward 1"],
      availability: "AVAILABLE",
      approvedById: OFFICIAL.id,
    });
  });

  it("idempotent re-approval returns the existing verified state without new writes", async () => {
    prisma.workerApplication.findUnique.mockResolvedValue(application({ status: "APPROVED" }));
    const result = await reviewWorkerApplication(OFFICIAL, "wa1", "APPROVE");
    expect(result.application.status).toBe("APPROVED");
    expect(result.profile?.employeeId).toBe("PWD-014");
    expect(prisma.workerProfile.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("duplicate-employeeId race during approval → 409 and NO state change", async () => {
    prisma.workerProfile.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
    );
    await expect(reviewWorkerApplication(OFFICIAL, "wa1", "APPROVE")).rejects.toMatchObject({ status: 409 });
    // Audit must NOT be written for a failed approval.
    expect(prisma.agentActivity.create).not.toHaveBeenCalled();
  });

  it("non-conflict transaction failure propagates (no swallowing, no audit)", async () => {
    prisma.workerProfile.create.mockRejectedValue(new Error("deadlock detected"));
    await expect(reviewWorkerApplication(OFFICIAL, "wa1", "APPROVE")).rejects.toThrow("deadlock detected");
    expect(prisma.agentActivity.create).not.toHaveBeenCalled();
  });
});

describe("profile access + official registry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("worker reads own profile; missing profile is a 404 (no oracle)", async () => {
    prisma.workerProfile.findUnique.mockResolvedValue(profileRow());
    const profile = await getMyWorkerProfile(WORKER);
    expect(profile.employeeId).toBe("PWD-014");

    prisma.workerProfile.findUnique.mockResolvedValue(null);
    await expect(getMyWorkerProfile(CITIZEN)).rejects.toMatchObject({ status: 404 });
  });

  it("official registry lists profiles with user linkage", async () => {
    prisma.workerProfile.findMany.mockResolvedValue([profileRow(), profileRow({ id: "wp2", employeeId: "SWM-001" })]);
    const registry = await listWorkerProfiles();
    expect(registry).toHaveLength(2);
    expect(registry[0]).toMatchObject({ employeeId: "PWD-014", userName: "Applicant Name" });
  });

  it("pending list exposes applicant identity only to officials (via service used by RBAC-guarded route)", async () => {
    prisma.workerApplication.findMany.mockResolvedValue([application()]);
    const apps = await listPendingWorkerApplications();
    expect(apps[0]).toMatchObject({ employeeId: "PWD-014", applicant: { email: "applicant@example.com" } });
    expect(prisma.workerApplication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" } })
    );
  });
});
