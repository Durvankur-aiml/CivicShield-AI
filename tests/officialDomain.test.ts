import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePrismaMock, mockPrismaModule, uniqueViolationError } from "./helpers/prisma-mock";

/**
 * Phase 2 — OfficialApplication / OfficialProfile domain tests (service layer).
 * Real service logic runs with the Prisma boundary mocked (same approach as
 * workerApplication/workerReview tests). Physical transaction atomicity is
 * only provable against a live database; these tests verify orchestration,
 * ordering, failure propagation, ID generation, and the audit write.
 */

const prisma = makePrismaMock();
mockPrismaModule(prisma);

const officialDomain = await import("@/lib/officialDomain");
const { officialApplicationInput } = await import("@/lib/constants");

const CITIZEN = { id: "u_citizen", email: "citizen@example.com", name: "Citizen", role: "CITIZEN" as const, departmentId: null };
const WORKER = { ...CITIZEN, id: "u_worker", role: "WORKER" as const };
const OFFICIAL = { ...CITIZEN, id: "u_official", role: "OFFICIAL" as const };
const ADMIN = { ...CITIZEN, id: "u_admin", email: "admin@example.com", role: "ADMIN" as const };

const departmentRow = { id: "dept_pwd", code: "PWD", name: "Public Works Department" };

const validInput = {
  employeeId: "PWD-777",
  departmentCode: "PWD",
  designation: "Assistant Engineer",
  municipality: "Pune Municipal Corporation",
  officialEmail: "ae777@example.gov.in",
  phone: "+91 90000 00456",
  serviceAreas: ["Ward 3"],
  experience: "6 years municipal works",
  applicationDetails: "Handles road maintenance contracts.",
};

const appRow = (over: Record<string, unknown> = {}) => ({
  id: "oa1",
  applicantId: CITIZEN.id,
  employeeId: "PWD-777",
  departmentId: departmentRow.id,
  designation: validInput.designation,
  municipality: validInput.municipality,
  officialEmail: validInput.officialEmail,
  phone: validInput.phone,
  serviceAreas: validInput.serviceAreas,
  experience: validInput.experience,
  applicationDetails: validInput.applicationDetails,
  status: "PENDING",
  reviewedById: null,
  reviewedAt: null,
  rejectionReason: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  department: { code: "PWD" },
  applicant: { id: CITIZEN.id, name: "Citizen", email: "citizen@example.com", image: null },
  ...over,
});

const profileRow = (over: Record<string, unknown> = {}) => ({
  id: "op1",
  userId: CITIZEN.id,
  officialId: "CS-OFF-0001",
  departmentId: departmentRow.id,
  designation: validInput.designation,
  municipality: validInput.municipality,
  serviceAreas: validInput.serviceAreas,
  applicationId: "oa1",
  phone: validInput.phone,
  workEmail: validInput.officialEmail,
  approvedById: ADMIN.id,
  approvedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  department: { code: "PWD", name: "Public Works Department" },
  user: { id: CITIZEN.id, name: "Citizen", email: "citizen@example.com" },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.department.findUnique.mockResolvedValue(departmentRow);
  // notificationDomain.send() reads the created row's id (P2002-safe dedupe).
  prisma.notification.create.mockResolvedValue({ id: "n1" });
});

describe("submitOfficialApplication — role rules", () => {
  it("citizen can submit a valid application", async () => {
    prisma.officialApplication.findFirst.mockResolvedValue(null);
    prisma.workerProfile.findUnique.mockResolvedValue(null);
    prisma.officialApplication.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      appRow({ ...data })
    );
    prisma.user.findMany.mockResolvedValue([{ id: ADMIN.id }]);

    const parsed = officialApplicationInput.parse(validInput);
    const result = await officialDomain.submitOfficialApplication(CITIZEN, parsed);

    expect(result.status).toBe("PENDING");
    expect(prisma.officialApplication.create).toHaveBeenCalledTimes(1);
    expect(prisma.officialApplication.create.mock.calls[0][0].data.applicantId).toBe(CITIZEN.id);
    // Admin notification fan-out: one send per admin, deduped by event key.
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
  });

  it("admins cannot apply (409)", async () => {
    await expect(
      officialDomain.submitOfficialApplication(ADMIN, officialApplicationInput.parse(validInput))
    ).rejects.toMatchObject({ status: 409 });
    expect(prisma.officialApplication.create).not.toHaveBeenCalled();
  });

  it("officials cannot apply again (409)", async () => {
    await expect(
      officialDomain.submitOfficialApplication(OFFICIAL, officialApplicationInput.parse(validInput))
    ).rejects.toMatchObject({ status: 409 });
  });

  it("worker may apply (eligible role)", async () => {
    prisma.officialApplication.findFirst.mockResolvedValue(null);
    prisma.workerProfile.findUnique.mockResolvedValue(null);
    prisma.officialApplication.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      appRow({ applicantId: WORKER.id, ...data })
    );
    prisma.user.findMany.mockResolvedValue([{ id: ADMIN.id }]);

    const result = await officialDomain.submitOfficialApplication(WORKER, officialApplicationInput.parse(validInput));
    expect(result.status).toBe("PENDING");
    expect(prisma.officialApplication.create.mock.calls[0][0].data.applicantId).toBe(WORKER.id);
  });
});

describe("submitOfficialApplication — duplicate/clash guards", () => {
  it("rejects when the applicant already has a PENDING application (409)", async () => {
    prisma.officialApplication.findFirst.mockResolvedValueOnce(appRow()).mockResolvedValueOnce(null);
    await expect(
      officialDomain.submitOfficialApplication(CITIZEN, officialApplicationInput.parse(validInput))
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects when the applicant is already an APPROVED official (409)", async () => {
    prisma.officialApplication.findFirst.mockResolvedValueOnce(appRow({ status: "APPROVED" })).mockResolvedValueOnce(null);
    await expect(
      officialDomain.submitOfficialApplication(CITIZEN, officialApplicationInput.parse(validInput))
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects a live application on the same employee ID (409, vague message)", async () => {
    prisma.officialApplication.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(appRow());
    await expect(
      officialDomain.submitOfficialApplication(CITIZEN, officialApplicationInput.parse(validInput))
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects an employee ID already verified as a worker (409)", async () => {
    prisma.officialApplication.findFirst.mockResolvedValue(null);
    prisma.workerProfile.findUnique.mockResolvedValue({ id: "wp1", employeeId: "PWD-777" });
    await expect(
      officialDomain.submitOfficialApplication(CITIZEN, officialApplicationInput.parse(validInput))
    ).rejects.toMatchObject({ status: 409 });
  });

  it("maps a create-time P2002 race to 409", async () => {
    prisma.officialApplication.findFirst.mockResolvedValue(null);
    prisma.workerProfile.findUnique.mockResolvedValue(null);
    prisma.officialApplication.create.mockRejectedValue(uniqueViolationError("OfficialApplication_employeeId_status_key"));
    await expect(
      officialDomain.submitOfficialApplication(CITIZEN, officialApplicationInput.parse(validInput))
    ).rejects.toMatchObject({ status: 409 });
  });

  it("lets non-conflict errors propagate", async () => {
    prisma.officialApplication.findFirst.mockResolvedValue(null);
    prisma.workerProfile.findUnique.mockResolvedValue(null);
    prisma.officialApplication.create.mockRejectedValue(new Error("connection refused"));
    await expect(
      officialDomain.submitOfficialApplication(CITIZEN, officialApplicationInput.parse(validInput))
    ).rejects.toThrow("connection refused");
  });

  it("allows reapplication after REJECTION (no live application)", async () => {
    prisma.officialApplication.findFirst.mockResolvedValue(null);
    prisma.workerProfile.findUnique.mockResolvedValue(null);
    prisma.officialApplication.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      appRow({ ...data })
    );
    prisma.user.findMany.mockResolvedValue([]);

    const result = await officialDomain.submitOfficialApplication(CITIZEN, officialApplicationInput.parse(validInput));
    expect(result.status).toBe("PENDING");
  });
});

describe("reviewOfficialApplication — authorization", () => {
  beforeEach(() => {
    prisma.officialApplication.findUnique.mockResolvedValue(appRow());
  });

  it("citizen, worker, and official cannot review (403)", async () => {
    await expect(officialDomain.reviewOfficialApplication(CITIZEN, "oa1", "APPROVE")).rejects.toMatchObject({ status: 403 });
    await expect(officialDomain.reviewOfficialApplication(WORKER, "oa1", "APPROVE")).rejects.toMatchObject({ status: 403 });
    await expect(officialDomain.reviewOfficialApplication(OFFICIAL, "oa1", "REJECT", "not convincing")).rejects.toMatchObject({ status: 403 });
    expect(prisma.officialApplication.update).not.toHaveBeenCalled();
  });

  it("rejection without a reason is a 400 (service-level guard)", async () => {
    await expect(officialDomain.reviewOfficialApplication(ADMIN, "oa1", "REJECT")).rejects.toMatchObject({ status: 400 });
    await expect(officialDomain.reviewOfficialApplication(ADMIN, "oa1", "REJECT", "")).rejects.toMatchObject({ status: 400 });
    expect(prisma.officialApplication.update).not.toHaveBeenCalled();
  });

  it("unknown application is a 404", async () => {
    prisma.officialApplication.findUnique.mockResolvedValue(null);
    await expect(officialDomain.reviewOfficialApplication(ADMIN, "missing", "APPROVE")).rejects.toMatchObject({ status: 404 });
  });
});

describe("reviewOfficialApplication — REJECT path", () => {
  it("records reviewer, timestamp, reason; notifies the applicant; audits", async () => {
    prisma.officialApplication.findUnique.mockResolvedValue(appRow());
    prisma.officialApplication.update.mockResolvedValue(
      appRow({ status: "REJECTED", reviewedById: ADMIN.id, reviewedAt: new Date(), rejectionReason: "ID not verifiable with HR" })
    );

    const result = await officialDomain.reviewOfficialApplication(ADMIN, "oa1", "REJECT", "ID not verifiable with HR");

    expect(result.application.status).toBe("REJECTED");
    expect(prisma.officialApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "oa1" },
        data: expect.objectContaining({
          status: "REJECTED",
          reviewedById: ADMIN.id,
          rejectionReason: "ID not verifiable with HR",
        }),
      })
    );
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ recipientId: CITIZEN.id, type: "OFFICIAL_APPLICATION_REJECTED" }),
      })
    );
    expect(prisma.agentActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ agent: "OfficialReview" }) })
    );
  });
});

describe("reviewOfficialApplication — APPROVE transaction", () => {
  it("creates OfficialProfile + flips role in one transaction; officialId CS-OFF-0001 for first approval", async () => {
    prisma.officialApplication.findUnique.mockResolvedValue(appRow());
    prisma.officialProfile.aggregate.mockResolvedValue({ _max: { officialId: null } });
    prisma.officialProfile.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      profileRow({ ...data })
    );
    prisma.officialApplication.update.mockResolvedValue(appRow({ status: "APPROVED" }));
    prisma.officialProfile.findUnique.mockResolvedValue(profileRow());

    const result = await officialDomain.reviewOfficialApplication(ADMIN, "oa1", "APPROVE");

    expect(result.profile?.officialId).toBe("CS-OFF-0001");
    // Profile + user role + application status all inside the $transaction callback.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.officialProfile.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ officialId: "CS-OFF-0001", userId: CITIZEN.id }) })
    );
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CITIZEN.id },
        data: expect.objectContaining({ role: "OFFICIAL" }),
      })
    );
    expect(prisma.officialApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "APPROVED", reviewedById: ADMIN.id }) })
    );
    // Post-commit: audit + applicant notification.
    expect(prisma.agentActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ agent: "OfficialReview" }) })
    );
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ recipientId: CITIZEN.id, type: "OFFICIAL_APPLICATION_APPROVED" }),
      })
    );
  });

  it("continues the official-ID sequence from the current high-water mark", async () => {
    prisma.officialApplication.findUnique.mockResolvedValue(appRow());
    prisma.officialProfile.aggregate.mockResolvedValue({ _max: { officialId: "CS-OFF-0041" } });
    prisma.officialProfile.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      profileRow({ ...data })
    );
    prisma.officialApplication.update.mockResolvedValue(appRow({ status: "APPROVED" }));
    prisma.officialProfile.findUnique.mockResolvedValue(profileRow({ officialId: "CS-OFF-0042" }));

    const result = await officialDomain.reviewOfficialApplication(ADMIN, "oa1", "APPROVE");
    expect(result.profile?.officialId).toBe("CS-OFF-0042");
  });

  it("re-review of an APPROVED application is idempotent (no second profile, no duplicate notification)", async () => {
    prisma.officialApplication.findUnique.mockResolvedValue(appRow({ status: "APPROVED" }));
    prisma.officialProfile.findUnique.mockResolvedValue(profileRow());

    const result = await officialDomain.reviewOfficialApplication(ADMIN, "oa1", "APPROVE");

    expect(result.profile?.officialId).toBe("CS-OFF-0001");
    expect(prisma.officialProfile.create).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it("re-review of a REJECTED application is a 409", async () => {
    prisma.officialApplication.findUnique.mockResolvedValue(appRow({ status: "REJECTED", rejectionReason: "dup" }));
    await expect(officialDomain.reviewOfficialApplication(ADMIN, "oa1", "APPROVE")).rejects.toMatchObject({ status: 409 });
  });

  it("maps a P2002 race on approval to 409 (nothing persisted)", async () => {
    prisma.officialApplication.findUnique.mockResolvedValue(appRow());
    prisma.$transaction.mockRejectedValue(uniqueViolationError("OfficialProfile_officialId_key"));

    await expect(officialDomain.reviewOfficialApplication(ADMIN, "oa1", "APPROVE")).rejects.toMatchObject({ status: 409 });
    expect(prisma.agentActivity.create).not.toHaveBeenCalled();
  });
});

describe("list functions", () => {
  it("listPendingOfficialApplications returns applicant blocks", async () => {
    prisma.officialApplication.findMany.mockResolvedValue([appRow()]);
    const apps = await officialDomain.listPendingOfficialApplications();
    expect(apps).toHaveLength(1);
    expect(apps[0].applicant?.email).toBe("citizen@example.com");
    expect(apps[0].status).toBe("PENDING");
  });

  it("listOfficialProfiles returns account linkage", async () => {
    prisma.officialProfile.findMany.mockResolvedValue([profileRow()]);
    const profiles = await officialDomain.listOfficialProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].userName).toBe("Citizen");
    expect(profiles[0].officialId).toBe("CS-OFF-0001");
  });

  it("getMyOfficialApplication returns null when none exist", async () => {
    prisma.officialApplication.findFirst.mockResolvedValue(null);
    expect(await officialDomain.getMyOfficialApplication(CITIZEN)).toBeNull();
  });
});

describe("contact-data hygiene", () => {
  it("audit trail contains ids/codes/reason — never phone or email of the applicant", async () => {
    prisma.officialApplication.findUnique.mockResolvedValue(appRow());
    prisma.officialApplication.update.mockResolvedValue(appRow({ status: "REJECTED", rejectionReason: "unverified" }));

    await officialDomain.reviewOfficialApplication(ADMIN, "oa1", "REJECT", "unverified");

    const auditArg = prisma.agentActivity.create.mock.calls[0][0];
    const detail = JSON.parse(auditArg.data.detail as string);
    expect(detail).not.toHaveProperty("phone");
    expect(detail).not.toHaveProperty("officialEmail");
    expect(JSON.stringify(detail)).not.toContain("ae777@example.gov.in");
    expect(JSON.stringify(detail)).not.toContain("+91 90000 00456");
  });
});
