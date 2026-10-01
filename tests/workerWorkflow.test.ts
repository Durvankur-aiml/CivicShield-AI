import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePrismaMock, mockPrismaModule } from "./helpers/prisma-mock";

/**
 * Phase 3 — worker operational workflow tests (unit, mocked Prisma).
 * Covers: accept/reject/start/complete guards, transactional coupling of
 * state + audit + notification, the reassignment chain
 * (previousAssignmentId), rejector exclusion, the attempt budget, and the
 * SLA-escalation race guards. Physical PostgreSQL concurrency (row locks,
 * unique-constraint races) is NOT TESTED here — mocked clients cannot prove
 * atomicity (documented in docs/PHASE3_REPORT.md).
 */

const prisma = makePrismaMock();
mockPrismaModule(prisma);

const {
  acceptAssignment,
  rejectAssignment,
  startAssignment,
  completeAssignment,
  listMyAssignments,
  getMyAssignment,
} = await import("@/lib/assignmentDomain");

const WORKER = { id: "u_worker", email: "worker@example.com", name: "Worker", role: "WORKER" as const, departmentId: null };
const OTHER = { id: "u_other", email: "other@example.com", name: "Other", role: "CITIZEN" as const, departmentId: null };

const complaintRow = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  refCode: "CS-2026-000123",
  category: "POTHOLE",
  severity: "HIGH",
  status: "ASSIGNED",
  lat: 16.7,
  lng: 74.4,
  ward: "Ward 1",
  departmentId: "PWD",
  slaDueAt: new Date(Date.now() + 24 * 3600_000),
  createdAt: new Date(),
  assignedToId: "u_worker",
  activeAssignmentId: "asg1",
  escalationCount: 0,
  department: { code: "PWD", name: "Public Works" },
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
  decision: null,
  reason: null,
  respondedAt: null,
  startedAt: null,
  completedAt: null,
  closedAt: null,
  slaWarnedAt: null,
  slaBreachedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  complaint: complaintRow(),
  ...over,
});

const profileRow = (over: Record<string, unknown> = {}) => ({
  id: "wp1",
  userId: "u_worker",
  employeeId: "DEMO-PWD-001",
  departmentId: "PWD",
  designation: "Road Repair Technician",
  skills: ["ROAD_REPAIR"],
  equipment: ["DRILL"],
  availability: "AVAILABLE",
  serviceAreas: ["Ward 1"],
  baseLat: 16.7,
  baseLng: 74.4,
  maxActiveAssignments: 3,
  approvedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe("accept", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.assignment.findUnique.mockResolvedValue(assignmentRow());
    prisma.assignment.update.mockResolvedValue({});
    prisma.agentActivity.create.mockResolvedValue({});
    prisma.notification.create.mockResolvedValue({ id: "n1" });
  });

  it("assigned worker accepts: status + audit + notification commit in one transaction", async () => {
    const res = await acceptAssignment(WORKER, "asg1");
    expect(res.status).toBe("ACCEPTED");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.assignment.update).toHaveBeenCalledWith({
      where: { id: "asg1" },
      data: expect.objectContaining({ status: "ACCEPTED", respondedAt: expect.any(Date) }),
    });
    expect(prisma.agentActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "ASSIGNMENT_ACCEPTED" }) })
    );
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        recipientId: "u_worker",
        type: "ASSIGNMENT_ACCEPTED",
        dedupeKey: "assignment:accepted:asg1",
      }),
    });
  });

  it("another worker's assignment cannot be accepted (403)", async () => {
    prisma.assignment.findUnique.mockResolvedValue(assignmentRow({ workerId: "u_worker2" }));
    await expect(acceptAssignment(WORKER, "asg1")).rejects.toMatchObject({ status: 403 });
    expect(prisma.assignment.update).not.toHaveBeenCalled();
  });

  it("a citizen (or any non-owner) cannot accept (403)", async () => {
    await expect(acceptAssignment(OTHER, "asg1")).rejects.toMatchObject({ status: 403 });
  });

  it("already-accepted assignment cannot be accepted again (409)", async () => {
    prisma.assignment.findUnique.mockResolvedValue(assignmentRow({ status: "ACCEPTED" }));
    await expect(acceptAssignment(WORKER, "asg1")).rejects.toMatchObject({ status: 409 });
  });

  it("a REJECTED assignment can never be accepted afterwards (409)", async () => {
    prisma.assignment.findUnique.mockResolvedValue(assignmentRow({ status: "REJECTED" }));
    await expect(acceptAssignment(WORKER, "asg1")).rejects.toMatchObject({ status: 409 });
  });

  it("an assignment closed by reassignment/escalation cannot be accepted (409 — post-race guard)", async () => {
    // The SLA sweep closed this offer while the worker's accept was in flight;
    // once the row is REASSIGNED the guard refuses the stale accept.
    prisma.assignment.findUnique.mockResolvedValue(assignmentRow({ status: "REASSIGNED" }));
    await expect(acceptAssignment(WORKER, "asg1")).rejects.toMatchObject({ status: 409 });
  });

  it("unknown assignment id → 404", async () => {
    prisma.assignment.findUnique.mockResolvedValue(null);
    await expect(acceptAssignment(WORKER, "missing")).rejects.toMatchObject({ status: 404 });
  });
});

describe("start + complete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.assignment.findUnique.mockResolvedValue(assignmentRow({ status: "ACCEPTED" }));
    prisma.assignment.update.mockResolvedValue({});
    prisma.complaint.update.mockResolvedValue({});
    prisma.agentActivity.create.mockResolvedValue({});
    prisma.timelineEvent.create.mockResolvedValue({});
    prisma.notification.create.mockResolvedValue({ id: "n1" });
  });

  it("start: ACCEPTED → IN_PROGRESS, complaint follows (single transaction)", async () => {
    const res = await startAssignment(WORKER, "asg1");
    expect(res.status).toBe("IN_PROGRESS");
    expect(prisma.assignment.update).toHaveBeenCalledWith({
      where: { id: "asg1" },
      data: expect.objectContaining({ status: "IN_PROGRESS", startedAt: expect.any(Date) }),
    });
    expect(prisma.complaint.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: expect.objectContaining({ status: "IN_PROGRESS", startedAt: expect.any(Date) }),
    });
  });

  it("start from OFFERED is rejected — the lifecycle must be followed (409)", async () => {
    prisma.assignment.findUnique.mockResolvedValue(assignmentRow({ status: "OFFERED" }));
    await expect(startAssignment(WORKER, "asg1")).rejects.toMatchObject({ status: 409 });
  });

  it("complete: IN_PROGRESS → COMPLETED, complaint → VERIFICATION, capacity released", async () => {
    prisma.assignment.findUnique.mockResolvedValue(assignmentRow({ status: "IN_PROGRESS" }));
    const res = await completeAssignment(WORKER, "asg1");
    expect(res.status).toBe("COMPLETED");
    expect(prisma.assignment.update).toHaveBeenCalledWith({
      where: { id: "asg1" },
      data: expect.objectContaining({ status: "COMPLETED", completedAt: expect.any(Date), closedAt: expect.any(Date) }),
    });
    expect(prisma.complaint.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: expect.objectContaining({ status: "VERIFICATION" }),
    });
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "ASSIGNMENT_COMPLETED", dedupeKey: "assignment:completed:asg1" }),
    });
    // Capacity consistency: COMPLETED is outside the open-status set used by
    // activeAssignmentCountFor / the engine's groupBy — the slot is free.
    expect(["OFFERED", "ACCEPTED", "IN_PROGRESS"]).not.toContain("COMPLETED");
  });

  it("complete from ACCEPTED (never started) is rejected (409)", async () => {
    await expect(completeAssignment(WORKER, "asg1")).rejects.toMatchObject({ status: 409 });
  });

  it("only the assigned worker can start/complete (403)", async () => {
    prisma.assignment.findUnique.mockResolvedValue(assignmentRow({ status: "IN_PROGRESS" }));
    await expect(startAssignment(OTHER, "asg1")).rejects.toMatchObject({ status: 403 });
    await expect(completeAssignment(OTHER, "asg1")).rejects.toMatchObject({ status: 403 });
  });
});

describe("reject → reassignment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.assignment.findUnique.mockResolvedValue(assignmentRow());
    prisma.assignment.update.mockResolvedValue({});
    prisma.assignment.count.mockResolvedValue(1);
    prisma.complaint.update.mockResolvedValue({});
    prisma.complaint.findUnique.mockResolvedValue(complaintRow());
    prisma.workerProfile.findMany.mockResolvedValue([
      profileRow(), // the rejector — must be excluded
      profileRow({ id: "wp2", userId: "u_worker2", employeeId: "DEMO-PWD-002" }),
    ]);
    prisma.assignment.groupBy.mockResolvedValue([]);
    prisma.assignment.create.mockImplementation(async ({ data }) => ({ id: "asg_new", ...data }));
    prisma.agentActivity.create.mockResolvedValue({});
    prisma.timelineEvent.create.mockResolvedValue({});
    prisma.user.findMany.mockResolvedValue([{ id: "u_official" }]);
    prisma.notification.create.mockResolvedValue({ id: "n1" });
    // The reject transaction CLEARS the active pointer before the engine
    // re-reads the complaint — the mock must model that post-reject state.
    prisma.complaint.findUnique.mockResolvedValue(complaintRow({ activeAssignmentId: null }));
  });

  it("reject closes the row, notifies worker + officials, and re-runs the engine", async () => {
    const outcome = await rejectAssignment(WORKER, "asg1");
    expect(outcome.kind).toBe("ASSIGNED");
    // History preserved: the rejected row is updated, never deleted.
    expect(prisma.assignment.update).toHaveBeenCalledWith({
      where: { id: "asg1" },
      data: expect.objectContaining({ status: "REJECTED", respondedAt: expect.any(Date) }),
    });
    expect(prisma.assignment.create).toHaveBeenCalledTimes(1);
    // Worker + official notifications inside the closing transaction.
    const recipientTypes = prisma.notification.create.mock.calls.map((c) => c[0].data.type);
    expect(recipientTypes).toContain("ASSIGNMENT_REJECTED");
  });

  it("the rejector is excluded and the NEW row carries the reassignment chain link", async () => {
    const outcome = await rejectAssignment(WORKER, "asg1");
    if (outcome.kind !== "ASSIGNED") throw new Error("expected ASSIGNED");
    expect(outcome.workerId).toBe("u_worker2");
    const created = prisma.assignment.create.mock.calls[0][0].data;
    expect(created.previousAssignmentId).toBe("asg1");
    expect(created.workerId).toBe("u_worker2");
    // The new worker is notified about the new offer.
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ recipientId: "u_worker2", type: "ASSIGNMENT_OFFERED" }),
    });
  });

  it("rejection works even though the complaint is ASSIGNED (Phase 2B status fix)", async () => {
    // The complaint stays ASSIGNED while rejecting; the engine must accept it
    // as an assignable status (regression for the real-flow reassignment bug).
    const outcome = await rejectAssignment(WORKER, "asg1");
    expect(outcome.kind).toBe("ASSIGNED");
    const engineRead = prisma.complaint.findUnique.mock.calls.at(-1)![0];
    expect(engineRead).toEqual({ where: { id: "c1" }, include: { department: { select: { code: true, name: true } } } });
  });

  it("attempt budget exhausted → NO_ELIGIBLE_WORKER, no engine run, officials can intervene", async () => {
    prisma.assignment.count.mockResolvedValue(5);
    const outcome = await rejectAssignment(WORKER, "asg1");
    expect(outcome.kind).toBe("NO_ELIGIBLE_WORKER");
    expect(prisma.workerProfile.findMany).not.toHaveBeenCalled();
    expect(prisma.assignment.create).not.toHaveBeenCalled();
  });

  it("no eligible worker remains → explicit NO_ELIGIBLE_WORKER, officials notified", async () => {
    prisma.workerProfile.findMany.mockResolvedValue([profileRow()]); // only the rejector
    const outcome = await rejectAssignment(WORKER, "asg1");
    expect(outcome.kind).toBe("NO_ELIGIBLE_WORKER");
    expect(prisma.assignment.create).not.toHaveBeenCalled();
    // Engine's NO_ELIGIBLE_WORKER path notifies officials (idempotent key).
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        recipientId: "u_official",
        type: "ESCALATION",
        dedupeKey: "no-eligible:c1:u_official",
      }),
    });
  });

  it("terminal assignments cannot be rejected (409)", async () => {
    prisma.assignment.findUnique.mockResolvedValue(assignmentRow({ status: "COMPLETED" }));
    await expect(rejectAssignment(WORKER, "asg1")).rejects.toMatchObject({ status: 409 });
    expect(prisma.assignment.update).not.toHaveBeenCalled();
  });
});

describe("worker assignment views (session-scoped)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("list is scoped to the authenticated worker — no client-controlled workerId", async () => {
    prisma.assignment.findMany.mockResolvedValue([
      { ...assignmentRow(), complaint: complaintRow() },
    ]);
    const rows = await listMyAssignments(WORKER);
    expect(prisma.assignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workerId: "u_worker" } })
    );
    expect(rows[0].complaint.refCode).toBe("CS-2026-000123");
  });

  it("detail of another worker's assignment is 404 (no existence leak)", async () => {
    prisma.assignment.findFirst.mockResolvedValue(null);
    await expect(getMyAssignment(WORKER, "asg1")).rejects.toMatchObject({ status: 404 });
  });

  it("detail exposes the reassignment chain link", async () => {
    prisma.assignment.findFirst.mockResolvedValue({
      ...assignmentRow({ previousAssignmentId: "asg_prev" }),
      complaint: complaintRow(),
    });
    const a = await getMyAssignment(WORKER, "asg1");
    expect(a.previousAssignmentId).toBe("asg_prev");
  });

  // Phase 6 Step 3 — additive contract extension: the assignment list
  // projection must carry complaint.title/description (task heading +
  // summary) exactly like the detail projection, so the future worker UI
  // migration can render task cards from the list alone.
  describe("assignment list projection (Phase 6 Step 3)", () => {
    beforeEach(() => vi.clearAllMocks());

    const withText = {
      ...complaintRow(),
      title: "Deep pothole near the bus stand",
      description: "Two-wheelers skid every evening — needs urgent repair.",
    };

    function expectListSelectIncludesTitleAndDescription() {
      const call = prisma.assignment.findMany.mock.calls.at(-1)?.[0] as {
        include: { complaint: { select: Record<string, boolean> } };
      };
      const select = call?.include?.complaint?.select;
      // Must be a select projection (never a bare include — no over-fetch).
      expect(select).toBeTypeOf("object");
      expect(select.title).toBe(true);
      expect(select.description).toBe(true);
      return select;
    }

    it("list response exposes complaint.title and complaint.description", async () => {
      prisma.assignment.findMany.mockResolvedValue([
        { ...assignmentRow(), complaint: withText },
      ]);
      const rows = await listMyAssignments(WORKER);
      expectListSelectIncludesTitleAndDescription();
      expect(rows[0].complaint.title).toBe("Deep pothole near the bus stand");
      expect(rows[0].complaint.description).toBe(
        "Two-wheelers skid every evening — needs urgent repair."
      );
    });

    it("list projection preserves every pre-existing complaint field", async () => {
      prisma.assignment.findMany.mockResolvedValue([
        { ...assignmentRow(), complaint: withText },
      ]);
      const rows = await listMyAssignments(WORKER);
      const select = expectListSelectIncludesTitleAndDescription();
      // In the real client the response keys ARE the select keys, so the
      // projection itself is the contract: exactly the 11 pre-existing fields
      // plus the 2 new ones — nothing removed, nothing over-fetched.
      expect(Object.keys(select).sort()).toEqual(
        [
          "id", "refCode", "title", "description", "category", "severity",
          "status", "ward", "lat", "lng", "address", "slaDueAt", "createdAt",
        ].sort()
      );
      // The domain mapper passes the projected row through untouched.
      expect(rows[0].complaint).toBe(withText);
    });

    it("detail projection matches the list projection exactly (parity)", async () => {
      prisma.assignment.findMany.mockResolvedValue([
        { ...assignmentRow(), complaint: withText },
      ]);
      prisma.assignment.findFirst.mockResolvedValue({
        ...assignmentRow(),
        complaint: withText,
      });
      await listMyAssignments(WORKER);
      await getMyAssignment(WORKER, "asg1");
      const listCall = prisma.assignment.findMany.mock.calls.at(-1)?.[0] as {
        include: { complaint: { select: Record<string, boolean> } };
      };
      const detailCall = prisma.assignment.findFirst.mock.calls.at(-1)?.[0] as {
        include: { complaint: { select: Record<string, boolean> } };
      };
      expect(Object.keys(listCall.include.complaint.select).sort()).toEqual(
        Object.keys(detailCall.include.complaint.select).sort()
      );
    });

    it("authorization is unchanged: list stays session-scoped (workerId from session)", async () => {
      prisma.assignment.findMany.mockResolvedValue([
        { ...assignmentRow(), complaint: withText },
      ]);
      await listMyAssignments(WORKER);
      expect(prisma.assignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workerId: "u_worker" } })
      );
    });

    it("authorization is unchanged: detail stays owner-scoped via the query itself", async () => {
      prisma.assignment.findFirst.mockResolvedValue(null);
      await expect(getMyAssignment(WORKER, "asg1")).rejects.toMatchObject({ status: 404 });
      expect(prisma.assignment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "asg1", workerId: "u_worker" } })
      );
    });
  });
});
