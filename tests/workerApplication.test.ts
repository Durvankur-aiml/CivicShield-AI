import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePrismaMock, mockPrismaModule, uniqueViolationError } from "./helpers/prisma-mock";

/**
 * Phase 2A — WorkerApplication domain tests (service layer).
 * Real service logic runs with the Prisma boundary mocked; transactional
 * DB behavior itself is only provable against a live database (see report).
 */

const prisma = makePrismaMock();
mockPrismaModule(prisma);

const { submitWorkerApplication, getMyWorkerApplication } = await import("@/lib/workerDomain");
const { workerApplicationInput } = await import("@/lib/constants");

const CITIZEN = { id: "u_citizen", email: "citizen@example.com", name: "Citizen", role: "CITIZEN" as const, departmentId: null };
const WORKER = { ...CITIZEN, id: "u_worker", role: "WORKER" as const };
const OFFICIAL = { ...CITIZEN, id: "u_official", role: "OFFICIAL" as const };

const validInput = {
  employeeId: "pwd-014",
  departmentCode: "PWD",
  designation: "Road Repair Technician",
  skills: ["ROAD_REPAIR", "ASPHALT_LAYING"],
  equipment: ["DRILL"],
  experience: "3 years municipal road crew",
  serviceAreas: ["Ward 1", "Ward 5"],
  phone: "+91 90000 00123",
  workEmail: "w014@example.gov.in",
};

const departmentRow = { id: "dept_pwd", code: "PWD", name: "Public Works Department" };
const appRow = (over: Record<string, unknown> = {}) => ({
  id: "wa1",
  applicantId: CITIZEN.id,
  employeeId: "PWD-014",
  departmentId: departmentRow.id,
  designation: validInput.designation,
  skills: validInput.skills,
  equipment: validInput.equipment,
  experience: validInput.experience,
  serviceAreas: validInput.serviceAreas,
  phone: validInput.phone,
  workEmail: validInput.workEmail,
  status: "PENDING",
  reviewedById: null,
  reviewedAt: null,
  rejectionReason: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  department: { code: "PWD" },
  applicant: { name: "Citizen" },
  ...over,
});

describe("workerApplicationInput validation", () => {
  it("accepts a valid application and normalizes the employee ID", () => {
    const parsed = workerApplicationInput.parse(validInput);
    expect(parsed.employeeId).toBe("PWD-014");
    expect(parsed.skills).toEqual(["ROAD_REPAIR", "ASPHALT_LAYING"]);
  });

  it("rejects malformed employee IDs", () => {
    for (const bad of ["P", "pwd 014", "TOOLONGID-123456789", "!!", ""]) {
      expect(() => workerApplicationInput.parse({ ...validInput, employeeId: bad })).toThrow();
    }
  });

  it("rejects unknown skills/equipment/department values", () => {
    expect(() => workerApplicationInput.parse({ ...validInput, skills: ["WELDING"] })).toThrow();
    expect(() => workerApplicationInput.parse({ ...validInput, equipment: ["HELICOPTER"] })).toThrow();
    expect(() => workerApplicationInput.parse({ ...validInput, departmentCode: "SPACE" })).toThrow();
  });

  it("rejects invalid phone/workEmail and over-long lists", () => {
    expect(() => workerApplicationInput.parse({ ...validInput, phone: "call-me" })).toThrow();
    expect(() => workerApplicationInput.parse({ ...validInput, workEmail: "not-an-email" })).toThrow();
    expect(() => workerApplicationInput.parse({ ...validInput, skills: new Array(9).fill("ROAD_REPAIR") })).toThrow();
  });
});

describe("submitWorkerApplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.department.findUnique.mockResolvedValue(departmentRow);
    prisma.workerApplication.findFirst.mockResolvedValue(null);
    prisma.workerProfile.findUnique.mockResolvedValue(null);
    prisma.workerApplication.create.mockImplementation(async ({ data }) => appRow({ ...data }));
  });

  it("creates a PENDING application for a citizen (normalized employee ID)", async () => {
    // The route layer parses input through workerApplicationInput first
    // (normalizing the employee ID); the service receives the parsed value.
    const parsed = workerApplicationInput.parse(validInput);
    const app = await submitWorkerApplication(CITIZEN, parsed);
    expect(app.status).toBe("PENDING");
    expect(app.employeeId).toBe("PWD-014");
    expect(prisma.workerApplication.create).toHaveBeenCalledTimes(1);
  });

  it("rejects non-citizen roles (service contract; routes enforce 401 first)", async () => {
    const parsed = workerApplicationInput.parse(validInput);
    await expect(submitWorkerApplication(WORKER, parsed)).rejects.toMatchObject({ status: 409 });
    await expect(submitWorkerApplication(OFFICIAL, parsed)).rejects.toMatchObject({ status: 409 });
  });

  it("rejects a second live application by the same applicant (409)", async () => {
    prisma.workerApplication.findFirst.mockResolvedValueOnce(appRow()).mockResolvedValueOnce(null);
    await expect(submitWorkerApplication(CITIZEN, workerApplicationInput.parse(validInput))).rejects.toMatchObject({ status: 409 });
  });

  it("rejects when the employee ID is already live (vague message, no ID-owner disclosure)", async () => {
    prisma.workerApplication.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(appRow());
    await expect(submitWorkerApplication(CITIZEN, workerApplicationInput.parse(validInput))).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("already registered or under review"),
    });
  });

  it("rejects when the employee ID exists on a verified WorkerProfile (409)", async () => {
    prisma.workerProfile.findUnique.mockResolvedValue({ id: "wp1", employeeId: "PWD-014" });
    await expect(submitWorkerApplication(CITIZEN, workerApplicationInput.parse(validInput))).rejects.toMatchObject({ status: 409 });
  });

  it("handles a concurrent duplicate-employeeId race via P2002 → 409", async () => {
    prisma.workerApplication.create.mockRejectedValue(uniqueViolationError("WorkerApplication_employeeId_status_key"));
    await expect(submitWorkerApplication(CITIZEN, workerApplicationInput.parse(validInput))).rejects.toMatchObject({ status: 409 });
  });

  it("allows reapplication after rejection (no live rows)", async () => {
    const app = await submitWorkerApplication(CITIZEN, workerApplicationInput.parse(validInput));
    expect(app.status).toBe("PENDING");
  });

  it("propagates non-conflict errors (no swallowing)", async () => {
    prisma.workerApplication.create.mockRejectedValue(new Error("connection refused"));
    await expect(submitWorkerApplication(CITIZEN, workerApplicationInput.parse(validInput))).rejects.toThrow("connection refused");
  });
});

describe("getMyWorkerApplication", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the applicant's latest application", async () => {
    prisma.workerApplication.findFirst.mockResolvedValue(appRow());
    const app = await getMyWorkerApplication(CITIZEN);
    expect(app?.employeeId).toBe("PWD-014");
    expect(prisma.workerApplication.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { applicantId: CITIZEN.id } })
    );
  });

  it("returns null when the user never applied", async () => {
    prisma.workerApplication.findFirst.mockResolvedValue(null);
    await expect(getMyWorkerApplication(CITIZEN)).resolves.toBeNull();
  });
});
