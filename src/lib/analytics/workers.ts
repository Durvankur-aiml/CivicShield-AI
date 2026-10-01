import { prisma } from "../db";
import type { TimeWindow } from "./timeWindow";
import { envelope, durationMetric, countMetric, type Envelope, type MetricResult } from "./metricStatus";

/**
 * Worker analytics (Phase 5) — RAW operational measurements per worker.
 * Deliberately NO performance score, NO best/worst ranking: raw counts and
 * durations only, per spec §10. Identity is the minimum officials need
 * (employeeId + display name); no emails, no contact data, no citizen data.
 */

export type WorkerAnalyticsRow = {
  userId: string;
  employeeId: string | null;
  name: string;
  department: string | null;
  availability: string;
  maxActiveAssignments: number;
  currentActive: number; // assignments in ACCEPTED/IN_PROGRESS
  completedInWindow: number;
  rejectedInWindow: number;
  reassignmentsInvolving: number; // this worker's assignments closed REASSIGNED in the window
  avgCompletionHours: MetricResult<number>; // startedAt → completedAt, per completed assignment
};

export type WorkerAnalytics = {
  envelope: Envelope;
  workers: WorkerAnalyticsRow[];
  summary: {
    activeWorkers: MetricResult<number>; // availability AVAILABLE
    totalWorkload: MetricResult<number>; // sum of currentActive
  };
};

export async function workerAnalytics(window: TimeWindow): Promise<WorkerAnalytics> {
  const inWindow = { createdAt: { gte: window.from, lt: window.to } };

  const [profiles, names, activeGroups, completedGroups, rejectedGroups, reassignedGroups, completionRows] =
    await Promise.all([
      prisma.workerProfile.findMany({
        select: {
          userId: true,
          employeeId: true,
          availability: true,
          maxActiveAssignments: true,
          department: { select: { code: true } },
        },
      }),
      prisma.user.findMany({ where: { role: "WORKER" }, select: { id: true, name: true } }),
      prisma.assignment.groupBy({
        by: ["workerId"],
        where: { status: { in: ["ACCEPTED", "IN_PROGRESS"] } },
        _count: { _all: true },
      }),
      prisma.assignment.groupBy({
        by: ["workerId"],
        where: { ...inWindow, status: "COMPLETED" },
        _count: { _all: true },
      }),
      prisma.assignment.groupBy({
        by: ["workerId"],
        where: { ...inWindow, status: "REJECTED" },
        _count: { _all: true },
      }),
      prisma.assignment.groupBy({
        by: ["workerId"],
        where: { ...inWindow, status: "REASSIGNED" },
        _count: { _all: true },
      }),
      prisma.assignment.findMany({
        where: { ...inWindow, status: "COMPLETED", startedAt: { not: null }, completedAt: { not: null } },
        select: { workerId: true, startedAt: true, completedAt: true },
        take: 2000, // bounded — per-row duration source
      }),
    ]);

  return buildWorkerAnalytics(window, {
    profiles: profiles.map((p) => ({
      userId: p.userId,
      employeeId: p.employeeId,
      name: names.find((n) => n.id === p.userId)?.name ?? "Unknown worker",
      department: p.department?.code ?? null,
      availability: p.availability,
      maxActiveAssignments: p.maxActiveAssignments,
    })),
    activeGroups,
    completedGroups,
    rejectedGroups,
    reassignedGroups,
    completionRows: completionRows.map((r) => ({
      workerId: r.workerId,
      startedAt: r.startedAt as Date,
      completedAt: r.completedAt as Date,
    })),
  });
}

export function buildWorkerAnalytics(
  window: TimeWindow,
  data: {
    profiles: Array<{
      userId: string;
      employeeId: string | null;
      name: string;
      department: string | null;
      availability: string;
      maxActiveAssignments: number;
    }>;
    activeGroups: Array<{ workerId: string; _count: { _all: number } }>;
    completedGroups: Array<{ workerId: string; _count: { _all: number } }>;
    rejectedGroups: Array<{ workerId: string; _count: { _all: number } }>;
    reassignedGroups: Array<{ workerId: string; _count: { _all: number } }>;
    completionRows: Array<{ workerId: string; startedAt: Date; completedAt: Date }>;
  }
): WorkerAnalytics {
  const countFor = (groups: Array<{ workerId: string; _count: { _all: number } }>, workerId: string) =>
    groups.find((g) => g.workerId === workerId)?._count._all ?? 0;

  const workers: WorkerAnalyticsRow[] = data.profiles.map((p) => {
    const durationsH = data.completionRows
      .filter((r) => r.workerId === p.userId)
      .map((r) => (r.completedAt.getTime() - r.startedAt.getTime()) / 3_600_000);
    const d = durationMetric(durationsH);
    return {
      userId: p.userId,
      employeeId: p.employeeId,
      name: p.name,
      department: p.department,
      availability: p.availability,
      maxActiveAssignments: p.maxActiveAssignments,
      currentActive: countFor(data.activeGroups, p.userId),
      completedInWindow: countFor(data.completedGroups, p.userId),
      rejectedInWindow: countFor(data.rejectedGroups, p.userId),
      reassignmentsInvolving: countFor(data.reassignedGroups, p.userId),
      avgCompletionHours: d.avg,
    };
  });

  return {
    envelope: envelope(window),
    workers,
    summary: {
      activeWorkers: countMetric(workers.filter((w) => w.availability === "AVAILABLE").length),
      totalWorkload: countMetric(workers.reduce((a, w) => a + w.currentActive, 0)),
    },
  };
}
