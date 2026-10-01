import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePrismaMock, mockPrismaModule } from "./helpers/prisma-mock";

/**
 * Phase 2B — assignment engine tests (service layer, mocked Prisma).
 * Verifies selection, explanation payloads, NO_ELIGIBLE_WORKER safety,
 * the concurrency guard, rejection/reassignment flow, and official override.
 * Physical transaction atomicity remains provable only against a live
 * PostgreSQL (documented in docs/PHASE2B_REPORT.md).
 */

const prisma = makePrismaMock();
mockPrismaModule(prisma);

const {
  assignComplaintAutomatically,
  rejectAssignment,
  overrideAssignment,
  acceptAssignment,
  startAssignment,
} = await import("@/lib/assignmentDomain");

const OFFICIAL = { id: "u_official", email: "official@example.com", name: "Official", role: "OFFICIAL" as const, departmentId: null };
const WORKER = { id: "u_worker", email: "worker@example.com", name: "Worker", role: "WORKER" as const, departmentId: null };
const OTHER = { id: "u_other", email: "other@example.com", name: "Other", role: "CITIZEN" as const, departmentId: null };

const profileRow = (over: Record<string, unknown> = {}) => ({
  id: "wp1",
  userId: "u_worker",
  employeeId: "DEMO-PWD-001",
  departmentId: "PWD",
  designation: "Road Repair Technician",
  skills: ["ROAD_REPAIR", "ASPHALT_LAYING"],
  equipment: ["DRILL"],
  availability: "AVAILABLE",
  serviceAreas: ["Ward 1", "Ward 5"],
  baseLat: 16.6952,
  baseLng: 74.4574,
  maxActiveAssignments: 3,
  phone: null,
  workEmail: null,
  approvedById: "official",
  approvedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const complaintRow = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  refCode: "CS-2026-000123",
  category: "POTHOLE",
  severity: "HIGH",
  status: "RECEIVED",
  lat: 16.6952,
  lng: 74.4574,
  ward: "Ward 1",
  departmentId: "PWD",
  slaDueAt: new Date(Date.now() + 24 * 3600_000),
  createdAt: new Date(),
  assignedToId: null,
  activeAssignmentId: null,
  assignedAt: null,
  startedAt: null,
  department: { code: "PWD", name: "Public Works Department" },
  ...over,
});

const assignmentRow = (over: Record<string, unknown> = {}) => ({
  id: "asg1",
  complaintId: "c1",
  workerId: "u_worker",
  status: "OFFERED",
  mode: "AUTO",
  policyVersion: "test",
  decision: null,
  reason: null,
  respondedAt: null,
  startedAt: null,
  completedAt: null,
  closedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  complaint: complaintRow(),
  ...over,
});

function happyEngine() {
  prisma.complaint.findUnique.mockResolvedValue(complaintRow());
  prisma.workerProfile.findMany.mockResolvedValue([profileRow()]);
  prisma.assignment.groupBy.mockResolvedValue([]);
  prisma.assignment.create.mockImplementation(async ({ data }) => ({ id: "asg_new", ...data }));
  prisma.complaint.update.mockResolvedValue({});
  prisma.agentActivity.create.mockResolvedValue({});
  prisma.timelineEvent.create.mockResolvedValue({});
  prisma.notification.create.mockResolvedValue({ id: "n1" });
}

describe("assignComplaintAutomatically — selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    happyEngine();
  });

  it("selects the best eligible worker and writes assignment + audit + timeline in one transaction", async () => {
    const outcome = await assignComplaintAutomatically("c1", { trigger: "INTAKE" });
    expect(outcome.kind).toBe("ASSIGNED");
    if (outcome.kind !== "ASSIGNED") return;

    expect(outcome.employeeId).toBe("DEMO-PWD-001");
    expect(outcome.score).toBeGreaterThan(85);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.assignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          complaintId: "c1",
          workerId: "u_worker",
          status: "OFFERED",
          mode: "AUTO",
          policyVersion: expect.any(String),
        }),
      })
    );
    expect(prisma.complaint.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "c1" },
        data: expect.objectContaining({ activeAssignmentId: "asg_new", assignedToId: "u_worker", status: "ASSIGNED" }),
      })
    );
    expect(prisma.agentActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ agent: "AssignmentAgent", action: "ASSIGN" }),
      })
    );
  });

  it("decision detail carries requirements, ranked candidates, and a full score breakdown", async () => {
    prisma.workerProfile.findMany.mockResolvedValue([
      profileRow(),
      profileRow({ id: "wp2", userId: "u2", employeeId: "DEMO-PWD-002", skills: ["ROAD_REPAIR"], baseLat: 16.71, baseLng: 74.47 }),
    ]);
    const outcome = await assignComplaintAutomatically("c1", { trigger: "INTAKE" });
    if (outcome.kind !== "ASSIGNED") throw new Error("expected ASSIGNED");

    const d = outcome.detail;
    expect(d.policyVersion).toBeTruthy();
    expect(d.requirements.departmentCode).toBe("PWD");
    expect(d.requirements.requiredSkills).toContain("ROAD_REPAIR");
    expect(d.candidates).toHaveLength(2);
    expect(d.candidates[0].employeeId).toBe("DEMO-PWD-001"); // closer/stronger candidate first
    expect(d.selected?.employeeId).toBe("DEMO-PWD-001");
    expect(d.selected?.breakdown.map((b) => b.factor)).toEqual(
      expect.arrayContaining(["skills", "equipment", "serviceArea", "workload", "capacity", "distance", "urgency"])
    );
    // Full audit payload persisted as structured JSON.
    const audit = prisma.agentActivity.create.mock.calls[0][0].data;
    const parsed = JSON.parse(audit.detail);
    expect(parsed.selected.breakdown).toHaveLength(7);
  });

  it("complaint with no eligible capabilities (OTHER) assigns a general worker without demands", async () => {
    prisma.complaint.findUnique.mockResolvedValue(
      complaintRow({ category: "OTHER", department: { code: "GEN", name: "General" }, departmentId: "GEN" })
    );
    prisma.workerProfile.findMany.mockResolvedValue([
      profileRow({ departmentId: "GEN", employeeId: "DEMO-GEN-001", skills: ["ROAD_REPAIR"] }),
    ]);
    const outcome = await assignComplaintAutomatically("c1", { trigger: "INTAKE" });
    expect(outcome.kind).toBe("ASSIGNED");
  });
});

describe("NO_ELIGIBLE_WORKER safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.complaint.findUnique.mockResolvedValue(complaintRow());
    prisma.workerProfile.findMany.mockResolvedValue([]);
    prisma.agentActivity.create.mockResolvedValue({});
    prisma.timelineEvent.create.mockResolvedValue({});
  });

  it("empty candidate pool → explicit result, complaint stays unassigned, audited", async () => {
    const outcome = await assignComplaintAutomatically("c1", { trigger: "INTAKE" });
    expect(outcome.kind).toBe("NO_ELIGIBLE_WORKER");
    if (outcome.kind !== "NO_ELIGIBLE_WORKER") return;
    expect(outcome.detail.noEligibleWorker).toBe(true);
    expect(prisma.assignment.create).not.toHaveBeenCalled();
    expect(prisma.complaint.update).not.toHaveBeenCalled();
    expect(prisma.agentActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ agent: "AssignmentAgent", action: "NO_ELIGIBLE_WORKER" }),
      })
    );
  });

  it("every worker ineligible (dept/availability/skill/capacity) → all reasons recorded, none assigned", async () => {
    prisma.workerProfile.findMany.mockResolvedValue([
      profileRow({ userId: "uA", employeeId: "A", skills: ["WASTE_COLLECTION"] }), // missing skill
      profileRow({ userId: "uB", employeeId: "B", equipment: [] }), // missing equipment
      profileRow({ userId: "uC", employeeId: "C", serviceAreas: ["Ward 9"] }), // outside area
      profileRow({ userId: "uD", employeeId: "D", maxActiveAssignments: 0 }), // at capacity
    ]);
    const outcome = await assignComplaintAutomatically("c1", { trigger: "INTAKE" });
    if (outcome.kind !== "NO_ELIGIBLE_WORKER") throw new Error("expected NO_ELIGIBLE_WORKER");
    expect(outcome.detail.ineligible).toHaveLength(4);
    expect(outcome.detail.ineligible.map((i) => i.employeeId)).toEqual(["A", "B", "C", "D"]);
    expect(prisma.assignment.create).not.toHaveBeenCalled();
  });

  it("non-assignable complaint status → NOT_ASSIGNABLE, no engine run", async () => {
    prisma.complaint.findUnique.mockResolvedValue(complaintRow({ status: "IN_PROGRESS" }));
    const outcome = await assignComplaintAutomatically("c1", { trigger: "INTAKE" });
    expect(outcome).toEqual({ kind: "NOT_ASSIGNABLE", reason: "status is IN_PROGRESS" });
    expect(prisma.workerProfile.findMany).not.toHaveBeenCalled();
  });

  it("already-assigned complaint → ALREADY_ASSIGNED without touching candidates", async () => {
    prisma.complaint.findUnique.mockResolvedValue(complaintRow({ activeAssignmentId: "asg_existing" }));
    const outcome = await assignComplaintAutomatically("c1", { trigger: "INTAKE" });
    expect(outcome).toEqual({ kind: "ALREADY_ASSIGNED", assignmentId: "asg_existing" });
    expect(prisma.workerProfile.findMany).not.toHaveBeenCalled();
  });

  it("unknown complaint → 404", async () => {
    prisma.complaint.findUnique.mockResolvedValue(null);
    await expect(assignComplaintAutomatically("missing", { trigger: "INTAKE" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("rejection → automatic reassignment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.assignment.findUnique.mockResolvedValue(assignmentRow());
    prisma.assignment.update.mockResolvedValue({});
    prisma.agentActivity.create.mockResolvedValue({});
    prisma.timelineEvent.create.mockResolvedValue({});
    prisma.complaint.update.mockResolvedValue({});
    prisma.assignment.count.mockResolvedValue(1);
    prisma.notification.create.mockResolvedValue({ id: "n1" });
  });

  it("another worker's assignment cannot be rejected by this user (403)", async () => {
    await expect(rejectAssignment(OTHER, "asg1")).rejects.toMatchObject({ status: 403 });
  });

  it("terminal assignments cannot be rejected (409)", async () => {
    prisma.assignment.findUnique.mockResolvedValue(assignmentRow({ status: "COMPLETED" }));
    await expect(rejectAssignment(WORKER, "asg1")).rejects.toMatchObject({ status: 409 });
  });

  it("reject → close assignment (history preserved) → engine re-runs EXCLUDING the rejector", async () => {
    happyEngine();
    // Pool holds the rejector AND a second eligible worker — the engine must
    // select the second one, proving the rejector was excluded.
    prisma.workerProfile.findMany.mockResolvedValue([
      profileRow(),
      profileRow({ id: "wp2", userId: "u2", employeeId: "DEMO-PWD-002" }),
    ]);
    const outcome = await rejectAssignment(WORKER, "asg1");
    expect(outcome.kind).toBe("ASSIGNED");
    if (outcome.kind !== "ASSIGNED") return;
    expect(outcome.workerId).toBe("u2");
    expect(prisma.assignment.create.mock.calls.at(-1)![0].data.workerId).toBe("u2");

    // The rejected assignment is closed as REJECTED with a timestamp — not deleted.
    expect(prisma.assignment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "asg1" }, data: expect.objectContaining({ status: "REJECTED", respondedAt: expect.any(Date) }) })
    );
    // Both records persist: update (history) + create (new offer).
    expect(prisma.assignment.create).toHaveBeenCalledTimes(1);
    // Engine ran with the rejecting worker excluded.
    const poolArg = prisma.workerProfile.findMany.mock.calls.at(-1)![0];
    expect(poolArg.where).toMatchObject({ departmentId: "PWD" });
    // Reassignment is audited.
    const actions = prisma.agentActivity.create.mock.calls.map((c) => c[0].data.action);
    expect(actions).toContain("REJECT");
    expect(actions).toContain("ASSIGN");
  });

  it("attempt budget exhausted → NO_ELIGIBLE_WORKER without running the engine", async () => {
    prisma.assignment.count.mockResolvedValue(5);
    const outcome = await rejectAssignment(WORKER, "asg1");
    expect(outcome.kind).toBe("NO_ELIGIBLE_WORKER");
    expect(prisma.workerProfile.findMany).not.toHaveBeenCalled();
    expect(prisma.assignment.create).not.toHaveBeenCalled();
  });

  it("worker can accept then start (assignment lifecycle follows complaint)", async () => {
    prisma.assignment.findUnique.mockResolvedValue(assignmentRow());
    prisma.assignment.update.mockResolvedValue({});
    prisma.complaint.update.mockResolvedValue({});

    const accepted = await acceptAssignment(WORKER, "asg1");
    expect(accepted.status).toBe("ACCEPTED");
    expect(prisma.assignment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "ACCEPTED", respondedAt: expect.any(Date) }) })
    );

    prisma.assignment.findUnique.mockResolvedValue(assignmentRow({ status: "ACCEPTED" }));
    const started = await startAssignment(WORKER, "asg1");
    expect(started.status).toBe("IN_PROGRESS");
    expect(prisma.complaint.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "c1" }, data: expect.objectContaining({ status: "IN_PROGRESS" }) })
    );
  });

  it("only the assigned worker can accept/start (403)", async () => {
    prisma.assignment.findUnique.mockResolvedValue(assignmentRow());
    await expect(acceptAssignment(OTHER, "asg1")).rejects.toMatchObject({ status: 403 });
    await expect(startAssignment(OTHER, "asg1")).rejects.toMatchObject({ status: 403 });
  });
});

describe("official override", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.complaint.findUnique.mockResolvedValue(
      complaintRow({ activeAssignment: assignmentRow(), activeAssignmentId: "asg1" })
    );
    prisma.user.findUnique.mockResolvedValue({ id: "u_worker", role: "WORKER", workerProfile: profileRow() });
    prisma.assignment.update.mockResolvedValue({});
    prisma.assignment.create.mockResolvedValue(assignmentRow({ id: "asg_override", mode: "OVERRIDE" }));
    prisma.complaint.update.mockResolvedValue({});
    prisma.agentActivity.create.mockResolvedValue({});
    prisma.timelineEvent.create.mockResolvedValue({});
    prisma.notification.create.mockResolvedValue({ id: "n1" });
  });

  it("official overrides: previous row closed (not deleted), OVERRIDE row created with reason, audited", async () => {
    const result = await overrideAssignment(OFFICIAL, "c1", "u_worker", "Engine pick unavailable in the field");
    expect(result.kind).toBe("OVERRIDE");

    expect(prisma.assignment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "asg1" }, data: expect.objectContaining({ status: "REASSIGNED", closedAt: expect.any(Date) }) })
    );
    expect(prisma.assignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ mode: "OVERRIDE", policyVersion: "manual", reason: "Engine pick unavailable in the field" }),
      })
    );
    const audit = prisma.agentActivity.create.mock.calls[0][0].data;
    expect(audit.action).toBe("OVERRIDE");
    expect(JSON.parse(audit.detail)).toMatchObject({ previousAssignmentId: "asg1", overriddenBy: OFFICIAL.email });
  });

  it("unauthorized users cannot override (403)", async () => {
    await expect(overrideAssignment(WORKER, "c1", "u_worker", "self-promote")).rejects.toMatchObject({ status: 403 });
    await expect(overrideAssignment(OTHER, "c1", "u_worker", "citizen override")).rejects.toMatchObject({ status: 403 });
  });

  it("override requires an existing verified worker (404)", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: "u_x", role: "CITIZEN", workerProfile: null });
    await expect(overrideAssignment(OFFICIAL, "c1", "u_x", "not a worker")).rejects.toMatchObject({ status: 404 });
  });

  it("resolved complaints cannot be overridden (409)", async () => {
    prisma.complaint.findUnique.mockResolvedValue(complaintRow({ status: "RESOLVED", activeAssignment: null, activeAssignmentId: null }));
    await expect(overrideAssignment(OFFICIAL, "c1", "u_worker", "late override")).rejects.toMatchObject({ status: 409 });
  });

  it("the original automatic decision remains intact in its own row (no overwrite)", async () => {
    await overrideAssignment(OFFICIAL, "c1", "u_worker", "reason");
    // Exactly one update (closing the previous) and one create (new row) —
    // the previous row's decision/decision fields are never modified.
    const updateArg = prisma.assignment.update.mock.calls[0][0];
    expect(Object.keys(updateArg.data)).toEqual(expect.arrayContaining(["status", "closedAt"]));
    expect(updateArg.data.decision).toBeUndefined();
  });
});

describe("concurrency guard (transaction serialization point)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    happyEngine();
  });

  it("re-reads the complaint INSIDE the transaction and refuses a double assignment", async () => {
    // Race: by the time the engine's IN-TRANSACTION read runs, a concurrent
    // request has already won and set the active pointer. Even though an
    // earlier read outside the transaction may have seen the complaint free,
    // the engine must trust only the tx-internal read — and refuse to add a
    // second active assignment.
    const order: string[] = [];
    prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      order.push("tx:begin");
      return cb(prisma);
    });
    prisma.complaint.findUnique.mockImplementation(async () => {
      order.push("complaint.findUnique");
      return complaintRow({ activeAssignmentId: "asg_winner" });
    });
    const outcome = await assignComplaintAutomatically("c1", { trigger: "INTAKE" });
    expect(outcome).toEqual({ kind: "ALREADY_ASSIGNED", assignmentId: "asg_winner" });
    // The decisive read was issued after the transaction was entered.
    expect(order).toEqual(["tx:begin", "complaint.findUnique"]);
    expect(prisma.assignment.create).not.toHaveBeenCalled();
    expect(prisma.complaint.update).not.toHaveBeenCalled();
  });

  it("assignment creation + complaint pointer update commit in the same transaction", async () => {
    await assignComplaintAutomatically("c1", { trigger: "INTAKE" });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Both writes issued against the transaction client (same mock here, but
    // call order proves create → pointer update inside one callback).
    const createIdx = prisma.assignment.create.mock.invocationCallOrder[0];
    const updateIdx = prisma.complaint.update.mock.invocationCallOrder[0];
    expect(createIdx).toBeLessThan(updateIdx);
  });
});
