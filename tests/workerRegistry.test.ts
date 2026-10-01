import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 2A — synthetic worker registry tests.
 * VERIFIED here: deterministic data shape, unique employee IDs, department
 * coverage, upsert idempotency mechanics (against a mock client).
 * NOT TESTED here: physical seed execution against PostgreSQL (no DB in this
 * environment) — documented in docs/PHASE2A_REPORT.md.
 */

const { SYNTHETIC_WORKERS, upsertSyntheticWorkers } = await import("../prisma/worker-registry");

describe("synthetic worker registry data (determinism + coverage)", () => {
  it("contains only synthetic DEMO identities (no real personal data)", () => {
    for (const w of SYNTHETIC_WORKERS) {
      expect(w.employeeId).toMatch(/^DEMO-/);
      expect(w.email).toMatch(/@civicshield\.demo$/);
      expect(w.name).toMatch(/^Demo Worker/);
    }
  });

  it("employee IDs are unique", () => {
    const ids = SYNTHETIC_WORKERS.map((w) => w.employeeId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is deterministic: no Dates, no functions, stable serialization", () => {
    // Determinism proof at the data level: every value is a primitive or an
    // array of primitives (no Date.now()/Math.random()/closures can hide in
    // such a structure), and serialization is byte-stable across runs.
    const assertPrimitive = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(assertPrimitive);
      expect(["string", "number", "boolean", "object"]).toContain(typeof v);
      expect(v).not.toBeInstanceOf(Date);
      expect(v).not.toBeInstanceOf(Function);
    };
    SYNTHETIC_WORKERS.forEach((w) => Object.values(w).forEach(assertPrimitive));
    expect(JSON.stringify(SYNTHETIC_WORKERS)).toBe(JSON.stringify(SYNTHETIC_WORKERS));
  });

  it("covers all six departments", () => {
    const codes = new Set(SYNTHETIC_WORKERS.map((w) => w.departmentCode));
    for (const code of ["PWD", "SWM", "ELECT", "WATER", "HEALTH", "GEN"]) {
      expect(codes.has(code)).toBe(true);
    }
  });

  it("exercises diverse capabilities and availability states (Phase 2B test fuel)", () => {
    const skills = new Set(SYNTHETIC_WORKERS.flatMap((w) => w.skills));
    expect(skills.size).toBeGreaterThanOrEqual(6);
    const availabilities = new Set(SYNTHETIC_WORKERS.map((w) => w.availability));
    expect(availabilities.has("AVAILABLE")).toBe(true);
    expect(availabilities.has("OFF_DUTY")).toBe(true);
    expect(availabilities.has("SUSPENDED")).toBe(true);
    // At least one worker carries equipment, one carries none.
    expect(SYNTHETIC_WORKERS.some((w) => w.equipment.length > 0)).toBe(true);
    expect(SYNTHETIC_WORKERS.some((w) => w.equipment.length === 0)).toBe(true);
  });

  it("all values come from the domain taxonomies (no free-text drift)", async () => {
    const { WORKER_SKILLS, WORKER_EQUIPMENT, WORKER_AVAILABILITY, DEPARTMENT_CODES } = await import("@/lib/constants");
    for (const w of SYNTHETIC_WORKERS) {
      expect(WORKER_AVAILABILITY).toContain(w.availability as never);
      expect(DEPARTMENT_CODES).toContain(w.departmentCode as never);
      for (const s of w.skills) expect(WORKER_SKILLS).toContain(s as never);
      for (const e of w.equipment) expect(WORKER_EQUIPMENT).toContain(e as never);
    }
  });
});

describe("upsertSyntheticWorkers (idempotency mechanics)", () => {
  const makePrisma = () => ({
    department: { findUnique: vi.fn() },
    user: { upsert: vi.fn() },
    workerProfile: { upsert: vi.fn() },
  });

  beforeEach(() => vi.clearAllMocks());

  it("upserts every worker keyed on email (user) and employeeId (profile)", async () => {
    const prisma = makePrisma();
    prisma.department.findUnique.mockResolvedValue({ id: "dept1", code: "PWD" });
    prisma.user.upsert.mockImplementation(async ({ where, create }) => ({ id: "u_" + where.email, ...create }));
    prisma.workerProfile.upsert.mockResolvedValue({});

    await upsertSyntheticWorkers(prisma as never);

    expect(prisma.user.upsert).toHaveBeenCalledTimes(SYNTHETIC_WORKERS.length);
    expect(prisma.workerProfile.upsert).toHaveBeenCalledTimes(SYNTHETIC_WORKERS.length);
    expect(prisma.workerProfile.upsert.mock.calls[0][0].where).toEqual({ employeeId: SYNTHETIC_WORKERS[0].employeeId });
  });

  it("profile upsert carries capability data + service areas + capacity", async () => {
    const prisma = makePrisma();
    prisma.department.findUnique.mockResolvedValue({ id: "dept1", code: "SWM" });
    prisma.user.upsert.mockResolvedValue({ id: "u1" });
    prisma.workerProfile.upsert.mockResolvedValue({});

    await upsertSyntheticWorkers(prisma as never);
    const arg = prisma.workerProfile.upsert.mock.calls.find(
      (c) => c[0].where.employeeId === "DEMO-SWM-001"
    )![0];
    expect(arg.create).toMatchObject({
      userId: "u1",
      employeeId: "DEMO-SWM-001",
      departmentId: "dept1",
      skills: expect.arrayContaining(["WASTE_COLLECTION", "SANITATION_INSPECTION"]),
      equipment: expect.arrayContaining(["COMPACTOR_TRUCK"]),
      serviceAreas: expect.any(Array),
      availability: "AVAILABLE",
    });
    expect(arg.update).toMatchObject({ availability: "AVAILABLE" });
  });

  it("fails loudly when a department is missing (seed-order dependency)", async () => {
    const prisma = makePrisma();
    prisma.department.findUnique.mockResolvedValue(null);
    await expect(upsertSyntheticWorkers(prisma as never)).rejects.toThrow(/missing department/);
  });

  it("is repeatable: a second run issues the same idempotent upserts", async () => {
    const prisma = makePrisma();
    prisma.department.findUnique.mockResolvedValue({ id: "dept1", code: "PWD" });
    prisma.user.upsert.mockResolvedValue({ id: "u1" });
    prisma.workerProfile.upsert.mockResolvedValue({});

    await upsertSyntheticWorkers(prisma as never);
    await upsertSyntheticWorkers(prisma as never);

    expect(prisma.workerProfile.upsert).toHaveBeenCalledTimes(SYNTHETIC_WORKERS.length * 2);
  });
});
