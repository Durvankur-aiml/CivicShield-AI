import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePrismaMock, mockPrismaModule } from "./helpers/prisma-mock";

/**
 * Phase 3 — official override authorization + notification tests (unit,
 * mocked Prisma). Identity always comes from the authenticated session;
 * guards: 403 non-official, 404 unverified target, 409 terminal complaint.
 * Override remains fully audited and both affected workers are notified.
 */

const prisma = makePrismaMock();
mockPrismaModule(prisma);

const { overrideAssignment } = await import("@/lib/assignmentDomain");

const OFFICIAL = { id: "u_official", email: "official@example.com", name: "Official", role: "OFFICIAL" as const, departmentId: null };
const WORKER = { id: "u_worker", email: "worker@example.com", name: "Worker", role: "WORKER" as const, departmentId: null };
const CITIZEN = { id: "u_citizen", email: "c@example.com", name: "C", role: "CITIZEN" as const, departmentId: null };

const complaintRow = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  refCode: "CS-2026-000123",
  category: "POTHOLE",
  severity: "HIGH",
  status: "ASSIGNED",
  ward: "Ward 1",
  slaDueAt: new Date(),
  createdAt: new Date(),
  assignedAt: new Date(),
  assignedToId: "u_worker",
  activeAssignmentId: "asg1",
  activeAssignment: {
    id: "asg1", complaintId: "c1", workerId: "u_worker", status: "OFFERED", mode: "AUTO",
    policyVersion: "test", decision: null, reason: null, respondedAt: null, startedAt: null,
    completedAt: null, closedAt: null, slaWarnedAt: null, slaBreachedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
  },
  ...over,
});

describe("official override — authorization and audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.complaint.findUnique.mockResolvedValue(complaintRow());
    prisma.user.findUnique.mockResolvedValue({ id: "u_worker2", role: "WORKER", workerProfile: { id: "wp2", userId: "u_worker2", employeeId: "DEMO-PWD-002" } });
    prisma.assignment.update.mockResolvedValue({});
    prisma.assignment.create.mockResolvedValue({ id: "asg_override" });
    prisma.complaint.update.mockResolvedValue({});
    prisma.agentActivity.create.mockResolvedValue({});
    prisma.timelineEvent.create.mockResolvedValue({});
    prisma.notification.create.mockResolvedValue({ id: "n1" });
  });

  it("OFFICIAL can override: previous row closed, OVERRIDE row created, chain link set", async () => {
    const res = await overrideAssignment(OFFICIAL, "c1", "u_worker2", "Engine pick unavailable in the field");
    expect(res.kind).toBe("OVERRIDE");
    expect(prisma.assignment.update).toHaveBeenCalledWith({
      where: { id: "asg1" },
      data: expect.objectContaining({ status: "REASSIGNED", closedAt: expect.any(Date) }),
    });
    const created = prisma.assignment.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ mode: "OVERRIDE", policyVersion: "manual", previousAssignmentId: "asg1", reason: "Engine pick unavailable in the field" });
  });

  it("a WORKER cannot override (403) — role comes from the session, not the client", async () => {
    await expect(overrideAssignment(WORKER, "c1", "u_worker2", "self-promote")).rejects.toMatchObject({ status: 403 });
    expect(prisma.assignment.create).not.toHaveBeenCalled();
  });

  it("a CITIZEN cannot override (403)", async () => {
    await expect(overrideAssignment(CITIZEN, "c1", "u_worker2", "citizen override")).rejects.toMatchObject({ status: 403 });
  });

  it("override target must be a verified worker (404)", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: "u_x", role: "CITIZEN", workerProfile: null });
    await expect(overrideAssignment(OFFICIAL, "c1", "u_x", "not a worker")).rejects.toMatchObject({ status: 404 });
  });

  it("resolved complaints cannot be overridden (409)", async () => {
    prisma.complaint.findUnique.mockResolvedValue(complaintRow({ status: "RESOLVED", activeAssignment: null, activeAssignmentId: null }));
    await expect(overrideAssignment(OFFICIAL, "c1", "u_worker2", "late")).rejects.toMatchObject({ status: 409 });
  });

  it("the original automatic decision JSON is never modified (history preserved)", async () => {
    await overrideAssignment(OFFICIAL, "c1", "u_worker2", "reason");
    const updateArg = prisma.assignment.update.mock.calls[0][0];
    expect(Object.keys(updateArg.data)).toEqual(expect.arrayContaining(["status", "closedAt"]));
    expect(updateArg.data.decision).toBeUndefined();
  });

  it("override remains audited (AgentActivity with override detail)", async () => {
    await overrideAssignment(OFFICIAL, "c1", "u_worker2", "reason");
    const audit = prisma.agentActivity.create.mock.calls[0][0].data;
    expect(audit.action).toBe("OVERRIDE");
    const detail = JSON.parse(audit.detail);
    expect(detail).toMatchObject({ previousAssignmentId: "asg1", newWorkerId: "u_worker2", overriddenBy: OFFICIAL.email });
  });

  it("both affected workers are notified: new worker offered, previous worker informed", async () => {
    await overrideAssignment(OFFICIAL, "c1", "u_worker2", "reason");
    const calls = prisma.notification.create.mock.calls.map((c) => c[0].data);
    expect(calls).toContainEqual(expect.objectContaining({ recipientId: "u_worker2", type: "ASSIGNMENT_OFFERED" }));
    expect(calls).toContainEqual(expect.objectContaining({ recipientId: "u_worker", type: "OFFICIAL_OVERRIDE" }));
  });

  it("no previous-worker notification when the official re-picks the same worker", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: "u_worker", role: "WORKER", workerProfile: { id: "wp1", userId: "u_worker", employeeId: "DEMO-PWD-001" } });
    await overrideAssignment(OFFICIAL, "c1", "u_worker", "refresh offer");
    const calls = prisma.notification.create.mock.calls.map((c) => c[0].data);
    expect(calls).toContainEqual(expect.objectContaining({ recipientId: "u_worker", type: "ASSIGNMENT_OFFERED" }));
    expect(calls.some((d) => d.type === "OFFICIAL_OVERRIDE")).toBe(false);
  });
});
