import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { makePrismaMock, mockPrismaModule } from "./helpers/prisma-mock";

/**
 * Phase 5 — analytics API contract tests (mocked Prisma + auth boundary).
 * Proves RBAC, window validation, deterministic response shapes, privacy
 * boundaries, and honest empty-dataset behavior. LIVE DATABASE AGGREGATION
 * NOT TESTED (no PostgreSQL) — SQL-side grouping behavior remains unverified.
 */

const prisma = makePrismaMock();
mockPrismaModule(prisma);

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireRole: vi.fn() };
});

const routes = {
  overview: (await import("@/app/api/official/analytics/overview/route")).GET,
  trends: (await import("@/app/api/official/analytics/trends/route")).GET,
  categories: (await import("@/app/api/official/analytics/categories/route")).GET,
  departments: (await import("@/app/api/official/analytics/departments/route")).GET,
  workers: (await import("@/app/api/official/analytics/workers/route")).GET,
  hotspots: (await import("@/app/api/official/analytics/hotspots/route")).GET,
  verification: (await import("@/app/api/official/analytics/verification/route")).GET,
  location: (await import("@/app/api/official/analytics/location/route")).GET,
};

const { requireRole, ApiError } = await import("@/lib/auth");

const OFFICIAL = { id: "u_o", email: "o@example.com", name: "Official", role: "OFFICIAL", departmentId: null };
const url = (path: string, query = "") => new Request(`http://localhost${path}${query}`, { method: "GET" });

/** Empty-database defaults: every mock returns "nothing". */
function emptyDb() {
  prisma.complaint.count.mockResolvedValue(0);
  prisma.complaint.findMany.mockResolvedValue([]);
  prisma.complaint.groupBy.mockResolvedValue([]);
  prisma.department.findMany.mockResolvedValue([]);
  prisma.assignment.count.mockResolvedValue(0);
  prisma.assignment.findMany.mockResolvedValue([]);
  prisma.assignment.groupBy.mockResolvedValue([]);
  prisma.workerProfile.findMany.mockResolvedValue([]);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.agentActivity.count.mockResolvedValue(0);
}

describe("analytics routes — RBAC (spec §19-F)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emptyDb();
  });

  it("CITIZEN and WORKER are rejected (403) on every analytics endpoint", async () => {
    (requireRole as Mock).mockImplementation(() => {
      throw new ApiError(403, "Insufficient permissions");
    });
    for (const GET of Object.values(routes)) {
      const res = await GET(url("/api/official/analytics/x"));
      expect([401, 403]).toContain(res.status);
    }
    expect(requireRole).toHaveBeenCalledWith(expect.anything(), "OFFICIAL");
  });

  it("OFFICIAL passes the guard and receives a payload", async () => {
    (requireRole as Mock).mockResolvedValue(OFFICIAL);
    const res = await routes.overview(url("/api/official/analytics/overview?window=7d"));
    expect(res.status).toBe(200);
  });

  it("requireRole is enforced on every endpoint", async () => {
    (requireRole as Mock).mockResolvedValue(OFFICIAL);
    for (const GET of Object.values(routes)) {
      await GET(url("/api/official/analytics/x?window=7d"));
    }
    expect(requireRole).toHaveBeenCalledTimes(Object.keys(routes).length);
  });
});

describe("analytics routes — window validation (spec §5/§12)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireRole as Mock).mockResolvedValue(OFFICIAL);
    emptyDb();
  });

  it("malformed windows return 400 with a helpful message", async () => {
    const res = await routes.overview(url("/api/official/analytics/overview?window=13h"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/24h, 7d, 30d, 90d/);
  });

  it("reversed and half-specified custom ranges return 400", async () => {
    const bad1 = await routes.trends(
      url("/api/official/analytics/trends", "?from=2026-09-30T02:00:00Z&to=2026-09-30T01:00:00Z")
    );
    const bad2 = await routes.trends(url("/api/official/analytics/trends", "?from=2026-09-30T00:00:00Z"));
    expect(bad1.status).toBe(400);
    expect(bad2.status).toBe(400);
  });

  it("invalid thresholds on categories/hotspots return 400", async () => {
    const r1 = await routes.categories(url("/api/official/analytics/categories?minCategory=0"));
    const r2 = await routes.hotspots(url("/api/official/analytics/hotspots?minCount=abc"));
    expect(r1.status).toBe(400);
    expect(r2.status).toBe(400);
  });
});

describe("analytics routes — empty datasets & shapes (spec §13/§17)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireRole as Mock).mockResolvedValue(OFFICIAL);
    emptyDb();
  });

  it("an empty database yields honest NO_DATA statuses, not fabricated zeros-as-data", async () => {
    const res = await routes.overview(url("/api/official/analytics/overview?window=7d"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.envelope.window.preset).toBe("7d");
    expect(body.complaints.totals.total).toMatchObject({ value: 0, status: "OK" }); // a true zero
    expect(body.resolution.resolutionRate.status).toBe("NO_DATA"); // 0/0 is NOT 0%
    expect(body.sla.complianceRate.status).toBe("NO_DATA");
    expect(body.assignments.acceptanceRate.status).toBe("NO_DATA");
    expect(body.verification.successRate.status).toBe("NO_DATA");
    expect(body.location.coordinateCoverage.status).toBe("NO_DATA");
    expect(body.trends.trends[0].direction).toBe("INSUFFICIENT_DATA");
  });

  it("every endpoint returns deterministic JSON with an envelope where defined", async () => {
    for (const [name, GET] of Object.entries(routes)) {
      const res = await GET(url("/api/official/analytics/x?window=24h"));
      expect(res.status).toBe(200);
      const body = await res.json();
      if (name === "trends") {
        expect(body.currentWindow.from).toBeTruthy(); // trends carry their dual window
      } else {
        expect(body.envelope.window.preset).toBe("24h");
        expect(new Date(body.envelope.generatedAt).toISOString()).toBe(body.envelope.generatedAt);
      }
    }
  });

  it("workers payload carries no emails or contact data (privacy, spec §14)", async () => {
    prisma.workerProfile.findMany.mockResolvedValue([
      {
        userId: "u1", employeeId: "PWD-001", availability: "AVAILABLE", maxActiveAssignments: 3,
        department: { code: "PWD", id: "d1", name: "Public Works", slaNote: null, complaints: [], workers: [], workerProfiles: [], workerApplications: [] },
      },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: "u1", name: "Worker A", email: "secret@x.com", phone: "123" }]);
    const res = await routes.workers(url("/api/official/analytics/workers?window=30d"));
    const body = await res.json();
    const json = JSON.stringify(body);
    expect(json).not.toContain("secret@x.com");
    expect(json).not.toContain("123");
    expect(body.workers[0].employeeId).toBe("PWD-001");
  });

  it("hotspot payloads expose explainable fields (no opaque scores)", async () => {
    const res = await routes.hotspots(url("/api/official/analytics/hotspots?window=30d"));
    const body = await res.json();
    expect(body.hotspots).toEqual([]); // empty db
    expect(body.minCount).toBe(3);
    expect(body.cellMeters).toBe(250);
    expect(typeof body.note).toBe("string");
  });
});
