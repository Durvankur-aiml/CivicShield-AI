import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePrismaMock, mockPrismaModule, uniqueViolationError } from "./helpers/prisma-mock";

/**
 * Regression tests for Phase 1 P0-3: concurrency-safe reference codes.
 *
 * The allocation logic (high-water-mark candidate + DB-unique-constraint
 * arbitration + bounded retry) is real application code; the database
 * boundary is mocked because this environment has no Postgres. Concurrent-
 * submission behavior is modeled as interleaved unique violations — exactly
 * the failure mode that produces duplicate codes under the old count()+1
 * scheme. True multi-connection concurrency remains covered by
 * scripts/smoke.mjs against a real database.
 */

const prisma = makePrismaMock();
mockPrismaModule(prisma);

const { formatRefCode, nextRefCodeCandidate, withUniqueRefCode } = await import("@/lib/refCode");
const { createComplaint } = await import("@/lib/agent/tools");

const baseInput = {
  title: "T",
  description: "D",
  category: "POTHOLE",
  severity: "HIGH",
  priority: 80,
  lat: 16.69,
  lng: 74.45,
  language: "en",
  departmentCode: "PWD",
  reporterId: "u1",
};

describe("formatRefCode", () => {
  it("formats the unchanged human-readable shape", () => {
    expect(formatRefCode(2026, 123)).toBe("CS-2026-000123");
    expect(formatRefCode(2026, 0)).toBe("CS-2026-000000");
  });
});

describe("nextRefCodeCandidate (high-water mark, not row count)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts at 1 when no complaints exist for the year", async () => {
    prisma.complaint.aggregate.mockResolvedValue({ _max: { refCode: null } });
    await expect(nextRefCodeCandidate(2026)).resolves.toBe("CS-2026-000001");
  });

  it("increments from the year's MAX code", async () => {
    prisma.complaint.aggregate.mockResolvedValue({ _max: { refCode: "CS-2026-000555" } });
    await expect(nextRefCodeCandidate(2026)).resolves.toBe("CS-2026-000556");
  });

  it("is unaffected by deleted rows (no count involved)", async () => {
    // count() is never called by the allocation strategy
    prisma.complaint.aggregate.mockResolvedValue({ _max: { refCode: "CS-2026-000042" } });
    await expect(nextRefCodeCandidate(2026)).resolves.toBe("CS-2026-000043");
    expect(prisma.complaint.count).not.toHaveBeenCalled();
  });

  it("sequences per-year (earlier years do not matter)", async () => {
    // Faithful mini-model of the real query: the aggregate filters
    // refCode by `startsWith: "CS-<year>-"`, so a 2025 code can never be
    // the MAX for 2026 even though it exists in the table.
    const table = ["CS-2025-999999"];
    prisma.complaint.aggregate.mockImplementation(async (args: { where?: { refCode?: { startsWith?: string } } }) => {
      const prefix = args?.where?.refCode?.startsWith ?? "";
      const matches = table.filter((c) => c.startsWith(prefix)).sort();
      return { _max: { refCode: matches.at(-1) ?? null } };
    });
    await expect(nextRefCodeCandidate(2026)).resolves.toBe("CS-2026-000001");
    // And the 2025 sequence continues from its own high-water mark:
    await expect(nextRefCodeCandidate(2025)).resolves.toBe("CS-2025-1000000");
  });

  it("rolls over the 6-digit width (999999 → 1000000)", async () => {
    prisma.complaint.aggregate.mockResolvedValue({ _max: { refCode: "CS-2026-999999" } });
    await expect(nextRefCodeCandidate(2026)).resolves.toBe("CS-2026-1000000");
  });
});

describe("withUniqueRefCode (concurrent-race retry)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.complaint.aggregate.mockResolvedValue({ _max: { refCode: null } });
  });

  it("returns on first success", async () => {
    const result = await withUniqueRefCode(async (code) => `created:${code}`);
    expect(result.refCode).toBe("CS-2026-000001");
    expect(result.attempts).toBe(1);
  });

  it("retries from a recomputed candidate when a concurrent submission wins the code", async () => {
    // Attempt 1: candidate 000001 collides (concurrent submission committed it
    // between our MAX read and our insert). Attempt 2: MAX now includes that
    // row, so the candidate moves to 000002 and succeeds.
    prisma.complaint.aggregate
      .mockResolvedValueOnce({ _max: { refCode: null } }) // attempt 1 → 000001
      .mockResolvedValueOnce({ _max: { refCode: "CS-2026-000001" } }); // attempt 2 → 000002

    const create = vi
      .fn<(code: string) => Promise<string>>()
      .mockRejectedValueOnce(uniqueViolationError())
      .mockResolvedValueOnce("ok");

    const result = await withUniqueRefCode(create, 2026);
    expect(result.refCode).toBe("CS-2026-000002");
    expect(result.attempts).toBe(2);
    expect(create.mock.calls.map((c) => c[0])).toEqual(["CS-2026-000001", "CS-2026-000002"]);
  });

  it("gives up with a clear error after the attempt budget", async () => {
    prisma.complaint.aggregate.mockResolvedValue({ _max: { refCode: "CS-2026-000009" } });
    const create = vi.fn(async () => {
      throw uniqueViolationError();
    });
    await expect(withUniqueRefCode(create, 2026)).rejects.toThrow(/after 5 attempts/);
    expect(create).toHaveBeenCalledTimes(5);
  });

  it("does NOT swallow non-unique violations", async () => {
    prisma.complaint.aggregate.mockResolvedValue({ _max: { refCode: null } });
    const boom = new Error("connection refused");
    const create = vi.fn(async () => {
      throw boom;
    });
    await expect(withUniqueRefCode(create, 2026)).rejects.toBe(boom);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("createComplaint refCode allocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.complaint.aggregate.mockResolvedValue({ _max: { refCode: null } });
    prisma.department.findUnique.mockResolvedValue({ id: "dept1", code: "PWD" });
    prisma.complaint.create.mockImplementation(async ({ data }) => ({ id: "c_new", ...data }));
  });

  it("allocates a code when none is provided", async () => {
    const created = await createComplaint({ ...baseInput } as never);
    expect(created.refCode).toBe("CS-2026-000001");
    expect(created.status).toBe("RECEIVED");
  });

  it("honors an explicit refCode (demo seeds keep their stable codes)", async () => {
    const created = await createComplaint({ ...baseInput, refCode: "CS-2026-000001" } as never);
    expect(created.refCode).toBe("CS-2026-000001");
    expect(prisma.complaint.aggregate).not.toHaveBeenCalled();
  });

  it("starts a 24h SLA clock for HIGH severity", async () => {
    const created = await createComplaint({ ...baseInput } as never);
    const due = (created as { slaDueAt: Date }).slaDueAt.getTime() - Date.now();
    expect((created as { slaHours: number }).slaHours).toBe(24);
    expect(due).toBeGreaterThan(23.9 * 3600_000);
    expect(due).toBeLessThanOrEqual(24 * 3600_000);
  });
});
