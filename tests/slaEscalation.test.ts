import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePrismaMock, mockPrismaModule } from "./helpers/prisma-mock";

/**
 * Phase 3 — SLA states + scheduled escalation tests (unit, mocked Prisma).
 * Real slaDomain + real tools.escalateComplaint + real Phase 2B engine run
 * against the mocked Prisma boundary. Physical DB concurrency (row locks,
 * marker-update races, unique-constraint behavior) is NOT TESTED in this
 * environment — the marker-update + notification transaction is orchestrated
 * correctly, but physical atomicity is only provable against a live
 * PostgreSQL (documented in docs/PHASE3_REPORT.md).
 */

const prisma = makePrismaMock();
mockPrismaModule(prisma);

const { slaStateFor, processAssignmentSla } = await import("@/lib/slaDomain");

const HOUR = 3600_000;
const NOW = new Date("2026-09-29T12:00:00.000Z");

const complaintRow = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  refCode: "CS-2026-000001",
  severity: "HIGH",
  status: "ASSIGNED",
  slaDueAt: new Date(NOW.getTime() + 24 * HOUR),
  createdAt: new Date(NOW.getTime() - 12 * HOUR), // 50% of the window consumed
  isOverdue: false,
  escalationCount: 0,
  ...over,
});

const assignmentRow = (over: Record<string, unknown> = {}) => ({
  id: "asg1",
  complaintId: "c1",
  workerId: "u_worker",
  status: "OFFERED",
  mode: "AUTO",
  policyVersion: "test",
  previousAssignmentId: null,
  slaWarnedAt: null,
  slaBreachedAt: null,
  respondedAt: null,
  startedAt: null,
  completedAt: null,
  closedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  complaint: {
    id: "c1",
    refCode: "CS-2026-000001",
    slaDueAt: new Date(NOW.getTime() + 24 * HOUR),
    createdAt: new Date(NOW.getTime() - 12 * HOUR),
  },
  ...over,
});

function mockSweepDeps() {
  prisma.assignment.findMany.mockResolvedValue([assignmentRow()]);
  prisma.assignment.update.mockResolvedValue({});
  prisma.complaint.findUnique.mockResolvedValue(complaintRow({ escalationCount: 0 }));
  prisma.complaint.update.mockResolvedValue({});
  prisma.escalation.create.mockResolvedValue({});
  prisma.user.findMany.mockResolvedValue([{ id: "u_official" }]);
  prisma.notification.create.mockResolvedValue({ id: "n1" });
  prisma.workerProfile.findMany.mockResolvedValue([]);
  prisma.assignment.groupBy.mockResolvedValue([]);
  prisma.assignment.create.mockResolvedValue({ id: "asg_new" });
  prisma.agentActivity.create.mockResolvedValue({});
  prisma.timelineEvent.create.mockResolvedValue({});
}

describe("derived SLA states (slaStateFor)", () => {
  it("ON_TRACK — early in the window, no warning marker", () => {
    const c = complaintRow();
    expect(slaStateFor(c, assignmentRow(), NOW)).toBe("ON_TRACK");
  });

  it("WARNING — 75%+ of the window consumed (derived), or marker present", () => {
    // 20h of a 24h window consumed (createdAt −20h, due +4h) = 83%
    const c = complaintRow({
      createdAt: new Date(NOW.getTime() - 20 * HOUR),
      slaDueAt: new Date(NOW.getTime() + 4 * HOUR),
    });
    expect(slaStateFor(c, assignmentRow(), NOW)).toBe("WARNING");
    const warned = assignmentRow({ slaWarnedAt: new Date(NOW.getTime() - 1 * HOUR) });
    expect(slaStateFor(complaintRow(), warned, NOW)).toBe("WARNING");
  });

  it("BREACHED — due date passed or OVERDUE flag set (whichever is authoritative)", () => {
    const past = complaintRow({ slaDueAt: new Date(NOW.getTime() - HOUR) });
    expect(slaStateFor(past, assignmentRow(), NOW)).toBe("BREACHED");
    expect(slaStateFor(complaintRow({ isOverdue: true }), assignmentRow(), NOW)).toBe("BREACHED");
  });

  it("ESCALATED — complaint escalated and not yet resolved", () => {
    const esc = complaintRow({ status: "ESCALATED", escalationCount: 2 });
    expect(slaStateFor(esc, assignmentRow(), NOW)).toBe("ESCALATED");
  });

  it("RESOLVED — resolution/completion outranks everything else", () => {
    expect(slaStateFor(complaintRow({ status: "RESOLVED" }), assignmentRow(), NOW)).toBe("RESOLVED");
    expect(slaStateFor(complaintRow({ resolvedAt: NOW }), assignmentRow(), NOW)).toBe("RESOLVED");
    const done = assignmentRow({ completedAt: NOW });
    expect(slaStateFor(complaintRow(), done, NOW)).toBe("RESOLVED");
  });

  it("warning marker alone does NOT mask an actual breach", () => {
    const c = complaintRow({ slaDueAt: new Date(NOW.getTime() - HOUR) });
    const warned = assignmentRow({ slaWarnedAt: new Date(NOW.getTime() - 2 * HOUR) });
    expect(slaStateFor(c, warned, NOW)).toBe("BREACHED");
  });
});

describe("scheduled assignment SLA pass (processAssignmentSla)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSweepDeps();
  });

  it("fires SLA_WARNING once at 75% of the window (L1)", async () => {
    prisma.assignment.findMany.mockResolvedValue([
      assignmentRow(),
      // 75%+ consumed: window 24h starting 19h ago
      {
        ...assignmentRow(),
        id: "asg_warn",
        complaint: {
          ...assignmentRow().complaint,
          createdAt: new Date(NOW.getTime() - 19 * HOUR),
          slaDueAt: new Date(NOW.getTime() + 5 * HOUR),
        },
      },
    ]);
    const results = await processAssignmentSla(NOW);
    const warned = results.find((r) => r.assignmentId === "asg_warn");
    expect(warned?.action).toBe("warning");
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "SLA_WARNING", recipientId: "u_worker", dedupeKey: "sla:warning:asg_warn" }),
    });
    expect(prisma.assignment.update).toHaveBeenCalledWith({
      where: { id: "asg_warn", slaWarnedAt: null },
      data: { slaWarnedAt: NOW },
    });
  });

  it("does NOT re-warn an assignment that already has its warning marker (cron idempotency)", async () => {
    prisma.assignment.findMany.mockResolvedValue([
      {
        ...assignmentRow(),
        id: "asg_warned",
        slaWarnedAt: new Date(NOW.getTime() - HOUR),
        complaint: {
          ...assignmentRow().complaint,
          createdAt: new Date(NOW.getTime() - 20 * HOUR),
          slaDueAt: new Date(NOW.getTime() + 4 * HOUR),
        },
      },
    ]);
    const results = await processAssignmentSla(NOW);
    expect(results[0].action).toBe("none");
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(prisma.assignment.update).not.toHaveBeenCalled();
  });

  it("fires SLA_BREACH once past the deadline (L2) — worker + officials notified", async () => {
    prisma.assignment.findMany.mockResolvedValue([
      {
        ...assignmentRow(),
        id: "asg_breach",
        status: "IN_PROGRESS",
        complaint: {
          id: "c1", refCode: "CS-2026-000001",
          createdAt: new Date(NOW.getTime() - 30 * HOUR),
          slaDueAt: new Date(NOW.getTime() - 6 * HOUR),
        },
      },
    ]);
    const results = await processAssignmentSla(NOW);
    expect(results[0].action).toBe("breach");
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "SLA_BREACH", recipientId: "u_worker", dedupeKey: "sla:breach:asg_breach" }),
    });
    // Officials notified with per-recipient keys.
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "SLA_BREACH", recipientId: "u_official", dedupeKey: "sla:breach:official:asg_breach:u_official" }),
    });
    // The complaint is NOT closed and the worker is NOT removed silently.
    expect(prisma.complaint.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "ESCALATED" }) })
    );
  });

  it("L3 — a breached OFFERED assignment (never accepted) is escalated and reassigned", async () => {
    prisma.assignment.findMany.mockResolvedValue([
      {
        ...assignmentRow(),
        id: "asg_l3",
        status: "OFFERED", // worker never responded for the whole window
        complaint: {
          id: "c1", refCode: "CS-2026-000001",
          createdAt: new Date(NOW.getTime() - 30 * HOUR),
          slaDueAt: new Date(NOW.getTime() - 6 * HOUR),
        },
      },
    ]);
    prisma.assignment.findUnique
      .mockResolvedValueOnce(assignmentRow({ id: "asg_l3", status: "OFFERED" })); // escalateAndReassign re-check
    // escalateComplaint re-reads, then update() returns the updated row
    // (escalationCount: 1) — exactly what Prisma returns on a real DB.
    prisma.complaint.findUnique.mockResolvedValue(complaintRow({ escalationCount: 0 }));
    prisma.complaint.update.mockResolvedValue({ escalationCount: 1 });
    const results = await processAssignmentSla(NOW);
    expect(results[0].action).toBe("escalated");
    // Complaint escalated via the existing machinery.
    expect(prisma.escalation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ complaintId: "c1", reason: expect.stringContaining("no worker response") }),
    });
    // Officials receive the ESCALATION notification (dedupeKey includes level).
    // The worker's SLA_BREACH fires first in the same sweep — scan all calls.
    const notifData = prisma.notification.create.mock.calls.map((c) => c[0].data);
    expect(notifData).toContainEqual(
      expect.objectContaining({ type: "ESCALATION", recipientId: "u_official", dedupeKey: "escalation:c1:1:u_official" })
    );
    // The stale offer is closed (history preserved) and the engine re-runs.
    expect(prisma.assignment.update).toHaveBeenCalledWith({
      where: { id: "asg_l3" },
      data: expect.objectContaining({ status: "REASSIGNED", closedAt: expect.any(Date) }),
    });
  });

  it("L3 skips ACCEPTED/IN_PROGRESS work — officials intervene instead of auto-reassign", async () => {
    prisma.assignment.findMany.mockResolvedValue([
      {
        ...assignmentRow(),
        id: "asg_ip",
        status: "IN_PROGRESS",
        complaint: {
          id: "c1", refCode: "CS-2026-000001",
          createdAt: new Date(NOW.getTime() - 30 * HOUR),
          slaDueAt: new Date(NOW.getTime() - 6 * HOUR),
        },
      },
    ]);
    const results = await processAssignmentSla(NOW);
    expect(results[0].action).toBe("breach");
    expect(prisma.escalation.create).not.toHaveBeenCalled();
    expect(prisma.assignment.create).not.toHaveBeenCalled();
  });

  it("breach fires exactly once across repeated sweeps (marker prevents re-notification)", async () => {
    prisma.assignment.findMany.mockResolvedValue([
      {
        ...assignmentRow(),
        id: "asg_b2",
        status: "IN_PROGRESS",
        slaBreachedAt: new Date(NOW.getTime() - HOUR), // already processed by an earlier cron
        complaint: {
          id: "c1", refCode: "CS-2026-000001",
          createdAt: new Date(NOW.getTime() - 30 * HOUR),
          slaDueAt: new Date(NOW.getTime() - 6 * HOUR),
        },
      },
    ]);
    const results = await processAssignmentSla(NOW);
    expect(results[0].action).toBe("breach"); // still reported as breached
    expect(prisma.notification.create).not.toHaveBeenCalled(); // but never re-notified
  });

  it("one failing assignment does not stop the sweep (failure isolation)", async () => {
    prisma.assignment.findMany.mockResolvedValue([
      {
        ...assignmentRow(),
        id: "asg_bad",
        complaint: {
          id: "c1", refCode: "CS-2026-000001",
          createdAt: new Date(NOW.getTime() - 30 * HOUR),
          slaDueAt: new Date(NOW.getTime() - 6 * HOUR),
        },
      },
      {
        ...assignmentRow(),
        id: "asg_good",
        workerId: "u_worker2",
        status: "IN_PROGRESS",
        complaint: {
          id: "c2", refCode: "CS-2026-000002",
          createdAt: new Date(NOW.getTime() - 30 * HOUR),
          slaDueAt: new Date(NOW.getTime() - 6 * HOUR),
        },
      },
    ]);
    prisma.assignment.update.mockRejectedValueOnce(new Error("row lock timeout"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const results = await processAssignmentSla(NOW);
    expect(results.find((r) => r.assignmentId === "asg_bad")?.error).toContain("row lock timeout");
    expect(results.find((r) => r.assignmentId === "asg_good")?.action).toBe("breach");
  });

  it("an assignment without an SLA clock is skipped entirely", async () => {
    prisma.assignment.findMany.mockResolvedValue([assignmentRow({ id: "asg_nosla" })]);
    const results = await processAssignmentSla(NOW);
    expect(results[0].action).toBe("none");
    expect(prisma.assignment.update).not.toHaveBeenCalled();
  });
});
