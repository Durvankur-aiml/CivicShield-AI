import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePrismaMock, mockPrismaModule } from "./helpers/prisma-mock";

/**
 * Regression tests for Phase 1 P0-5/P0-6: SLA scheduler auth + sweep
 * robustness. The real route handlers and the real checkSla() implementation
 * run here with the Prisma boundary mocked (no DB in this environment).
 */

const prisma = makePrismaMock();
mockPrismaModule(prisma);

const { checkSla } = await import("@/lib/agent/tools");
const cronModule = await import("@/app/api/cron/sla/route");

const overdueComplaint = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  refCode: "CS-2026-000010",
  severity: "HIGH",
  status: "IN_PROGRESS",
  slaDueAt: new Date(Date.now() - 3600_000),
  department: null,
  ...over,
});

function reqWith(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/cron/sla", { headers });
}

// Next.js route modules only permit HTTP-method exports; the shared handler
// is exercised through GET (identical to POST by construction).
const run = cronModule.GET;

describe("SLA sweep (checkSla)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("marks overdue, writes an SLA timeline event, and escalates HIGH severity", async () => {
    prisma.complaint.findMany.mockResolvedValue([overdueComplaint()]);
    prisma.complaint.update.mockResolvedValue({});
    prisma.timelineEvent.create.mockResolvedValue({});
    prisma.escalation.create.mockResolvedValue({});
    // escalateComplaint re-reads the complaint
    prisma.complaint.findUnique = vi.fn().mockResolvedValue({ id: "c1", escalationCount: 0 });

    const results = await checkSla();
    expect(results).toEqual([{ refCode: "CS-2026-000010", escalated: true }]);
    expect(prisma.complaint.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "c1" }, data: { isOverdue: true } })
    );
    expect(prisma.timelineEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.escalation.create).toHaveBeenCalledTimes(1);
  });

  it("does not escalate LOW/MEDIUM complaints that are not in VERIFICATION", async () => {
    prisma.complaint.findMany.mockResolvedValue([overdueComplaint({ severity: "LOW", status: "RECEIVED" })]);
    prisma.complaint.update.mockResolvedValue({});
    prisma.timelineEvent.create.mockResolvedValue({});

    const results = await checkSla();
    expect(results).toEqual([{ refCode: "CS-2026-000010", escalated: false }]);
    expect(prisma.escalation.create).not.toHaveBeenCalled();
  });

  it("is idempotent: the query excludes already-overdue complaints", async () => {
    prisma.complaint.findMany.mockResolvedValue([]);
    const results = await checkSla();
    expect(results).toEqual([]);
    expect(prisma.complaint.update).not.toHaveBeenCalled();
    // The idempotency mechanism itself: the isOverdue:false filter.
    expect(prisma.complaint.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isOverdue: false }),
      })
    );
  });

  it("processes multiple complaints and escalates only by the existing rules", async () => {
    prisma.complaint.findMany.mockResolvedValue([
      overdueComplaint({ id: "c1", refCode: "CS-2026-000011", severity: "CRITICAL" }),
      overdueComplaint({ id: "c2", refCode: "CS-2026-000012", severity: "LOW", status: "RECEIVED" }),
      overdueComplaint({ id: "c3", refCode: "CS-2026-000013", severity: "MEDIUM", status: "VERIFICATION" }),
    ]);
    prisma.complaint.update.mockResolvedValue({});
    prisma.timelineEvent.create.mockResolvedValue({});
    prisma.escalation.create.mockResolvedValue({});
    prisma.complaint.findUnique = vi.fn().mockResolvedValue({ escalationCount: 0 });

    const results = await checkSla();
    expect(results.map((r) => r.escalated)).toEqual([true, false, true]);
    expect(prisma.escalation.create).toHaveBeenCalledTimes(2);
  });

  it("isolates a failing complaint instead of aborting the sweep (P0-6)", async () => {
    prisma.complaint.findMany.mockResolvedValue([
      overdueComplaint({ id: "bad", refCode: "CS-2026-000099" }),
      overdueComplaint({ id: "good", refCode: "CS-2026-000100", severity: "LOW", status: "RECEIVED" }),
    ]);
    prisma.complaint.update
      .mockRejectedValueOnce(new Error("db write failed"))
      .mockResolvedValue({});
    prisma.timelineEvent.create.mockResolvedValue({});

    const results = await checkSla();
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      refCode: "CS-2026-000099",
      escalated: false,
      error: "db write failed",
    });
    expect(results[1]).toEqual({ refCode: "CS-2026-000100", escalated: false });
    // Errors are logged (observable), not silently swallowed — and contain no secrets.
    expect(vi.mocked(console.error).mock.calls.some((c) => String(c[0]).includes("CS-2026-000099"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("propagates a total query failure so the scheduler can retry/alert", async () => {
    prisma.complaint.findMany.mockRejectedValue(new Error("database unreachable"));
    await expect(checkSla()).rejects.toThrow("database unreachable");
  });
});

describe("cron route authentication (P0-5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.complaint.findMany.mockResolvedValue([]);
    prisma.complaint.update.mockResolvedValue({});
    prisma.timelineEvent.create.mockResolvedValue({});
    // Phase 3: the route also runs the assignment-level sweep.
    prisma.assignment.findMany.mockResolvedValue([]);
  });

  it("accepts Authorization: Bearer $CRON_SECRET (Vercel Cron native format)", async () => {
    process.env.CRON_SECRET = "s3cret-value";
    const res = await run(reqWith({ authorization: "Bearer s3cret-value" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checked).toBe(0);
    expect(body.ok).toBe(true);
  });

  it("accepts x-cron-secret (external schedulers)", async () => {
    process.env.CRON_SECRET = "s3cret-value";
    const res = await run(reqWith({ "x-cron-secret": "s3cret-value" }));
    expect(res.status).toBe(200);
  });

  it("rejects a wrong secret (401)", async () => {
    process.env.CRON_SECRET = "s3cret-value";
    const res = await run(reqWith({ authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
  });

  it("rejects when CRON_SECRET is unset (fail closed) even with a header", async () => {
    delete process.env.CRON_SECRET;
    const res = await run(reqWith({ "x-cron-secret": "anything" }));
    expect(res.status).toBe(401);
  });

  it("rejects an empty Authorization header value", async () => {
    process.env.CRON_SECRET = "s3cret-value";
    const res = await run(reqWith({ authorization: "Bearer " }));
    expect(res.status).toBe(401);
  });

  it("never echoes the secret in responses", async () => {
    process.env.CRON_SECRET = "s3cret-value";
    const res = await run(reqWith({ authorization: "Bearer s3cret-value" }));
    expect(await res.text()).not.toContain("s3cret-value");
  });

  it("reports partial sweep failure via ok:false (route stays 200 for the scheduler)", async () => {
    process.env.CRON_SECRET = "s3cret-value";
    prisma.complaint.findMany.mockResolvedValue([overdueComplaint()]);
    prisma.complaint.update.mockRejectedValueOnce(new Error("row lock timeout"));
    prisma.timelineEvent.create.mockResolvedValue({});

    const res = await run(reqWith({ authorization: "Bearer s3cret-value" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.failed).toBe(1);
    expect(body.ok).toBe(false);
  });

  it("GET and POST share the same guarded handler", async () => {
    process.env.CRON_SECRET = "s3cret-value";
    expect(cronModule.POST).toBe(cronModule.GET);
  });
});
