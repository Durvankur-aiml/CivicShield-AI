import { prisma } from "../db";
import type { TimeWindow } from "./timeWindow";
import { envelope, rateMetric, type Envelope, type MetricResult } from "./metricStatus";
import { buildDailySeries } from "./complaints";

/**
 * Department analytics (Phase 5) — descriptive operational measurements per
 * department. Deliberately NO "best/worst" ranking: the payload describes
 * what happened; judgments are left to officials, per spec §9.
 *
 * Assignment attribution uses the COMPLAINT's own departmentId (the routing
 * decision that created the case) — one bounded joined fetch, aggregated
 * in-process. No placeholder maps, no invented zeros.
 */

export type DepartmentAnalyticsRow = {
  code: string;
  name: string;
  complaintVolume: number; // created in window
  openWorkload: number; // open statuses, ALL TIME (operational backlog)
  resolvedInWindow: number;
  resolutionRate: MetricResult<number>;
  slaBreached: number; // overdue & non-terminal, all time
  slaCompliance: MetricResult<number>; // non-overdue open / all open
  avgResolutionHours: MetricResult<number>;
  assignmentsInWindow: number;
  acceptedInWindow: number;
  acceptanceRate: MetricResult<number>;
  reassignmentsInWindow: number;
  volumeSeries: Array<{ bucketStart: string; count: number }>;
};

export type DepartmentAnalytics = {
  envelope: Envelope;
  departments: DepartmentAnalyticsRow[];
};

const OPEN_STATUSES = ["RECEIVED", "ASSIGNED", "IN_PROGRESS", "VERIFICATION", "REOPENED", "ESCALATED"];

export async function departmentAnalytics(window: TimeWindow) {
  const inWindow = { createdAt: { gte: window.from, lt: window.to } };

  const [departments, volume, open, resolved, breach, durations, createdAts, assignmentRows] = await Promise.all([
    prisma.department.findMany({ select: { id: true, code: true, name: true } }),
    prisma.complaint.groupBy({ by: ["departmentId"], where: { ...inWindow, departmentId: { not: null } }, _count: { _all: true } }),
    prisma.complaint.groupBy({
      by: ["departmentId"],
      where: { departmentId: { not: null }, status: { in: OPEN_STATUSES } },
      _count: { _all: true },
    }),
    prisma.complaint.groupBy({
      by: ["departmentId"],
      where: { ...inWindow, departmentId: { not: null }, resolvedAt: { not: null } },
      _count: { _all: true },
    }),
    prisma.complaint.groupBy({
      by: ["departmentId"],
      where: { departmentId: { not: null }, isOverdue: true, status: { notIn: ["RESOLVED", "CLOSED"] } },
      _count: { _all: true },
    }),
    prisma.complaint.findMany({
      where: { ...inWindow, departmentId: { not: null }, resolvedAt: { not: null } },
      select: { departmentId: true, createdAt: true, resolvedAt: true },
      take: 2000, // bounded — per-row duration source
    }),    prisma.complaint.findMany({
      where: { ...inWindow, departmentId: { not: null } },
      select: { departmentId: true, createdAt: true },
    }),
    // Bounded joined fetch for per-department assignment outcomes.
    prisma.assignment.findMany({
      where: { ...inWindow, complaint: { departmentId: { not: null } } },
      select: { status: true, complaint: { select: { departmentId: true } } },
      take: 5000,
    }),
  ]);

  return buildDepartmentAnalytics(window, {
    departments,
    volume,
    open,
    resolved,
    breach,
    durations: durations.map((r) => ({ departmentId: r.departmentId, createdAt: r.createdAt, resolvedAt: r.resolvedAt as Date })),
    createdAts,
    assignmentRows: assignmentRows.map((a) => ({ status: a.status, departmentId: a.complaint.departmentId })),
  });
}
export function buildDepartmentAnalytics(
  window: TimeWindow,
  data: {
    departments: Array<{ id: string; code: string; name: string }>;
    volume: Array<{ departmentId: string | null; _count: { _all: number } }>;
    open: Array<{ departmentId: string | null; _count: { _all: number } }>;
    resolved: Array<{ departmentId: string | null; _count: { _all: number } }>;
    breach: Array<{ departmentId: string | null; _count: { _all: number } }>;
    durations: Array<{ departmentId: string | null; createdAt: Date; resolvedAt: Date }>;
    createdAts: Array<{ departmentId: string | null; createdAt: Date }>;
    assignmentRows: Array<{ status: string; departmentId: string | null }>;
  }
): DepartmentAnalytics {
  const sum = (groups: Array<{ departmentId: string | null; _count: { _all: number } }>, id: string) =>
    groups.filter((g) => g.departmentId === id).reduce((a, g) => a + g._count._all, 0);

  const departments: DepartmentAnalyticsRow[] = data.departments.map((dept) => {
    const vol = sum(data.volume, dept.id);
    const openN = sum(data.open, dept.id);
    const resolvedN = sum(data.resolved, dept.id);
    const breachN = sum(data.breach, dept.id);
    const durations = data.durations
      .filter((r) => r.departmentId === dept.id)
      .map((r) => (r.resolvedAt.getTime() - r.createdAt.getTime()) / 3_600_000)
      .filter((h) => Number.isFinite(h) && h >= 0);
    const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

    const deptAssignments = data.assignmentRows.filter((r) => r.departmentId === dept.id);
    const assignN = deptAssignments.length;
    const acceptN = deptAssignments.filter((r) => r.status === "ACCEPTED" || r.status === "IN_PROGRESS" || r.status === "COMPLETED").length;
    const reassignN = deptAssignments.filter((r) => r.status === "REASSIGNED").length;

    return {
      code: dept.code,
      name: dept.name,
      complaintVolume: vol,
      openWorkload: openN,
      resolvedInWindow: resolvedN,
      resolutionRate: rateMetric(resolvedN, vol),
      slaBreached: breachN,
      slaCompliance: rateMetric(openN - breachN, openN),
      avgResolutionHours:
        avg == null
          ? durations.length === 0
            ? { value: null, sampleSize: 0, status: "NO_DATA" as const, unit: "hours" }
            : { value: null, sampleSize: durations.length as 0 | 1, status: "INSUFFICIENT_DATA" as const, unit: "hours" }
          : { value: Number(avg.toFixed(2)), sampleSize: durations.length, status: "OK" as const, unit: "hours" },
      assignmentsInWindow: assignN,
      acceptedInWindow: acceptN,
      acceptanceRate: rateMetric(acceptN, assignN),
      reassignmentsInWindow: reassignN,
      volumeSeries: buildDailySeries(
        data.createdAts.filter((r) => r.departmentId === dept.id).map((r) => r.createdAt)
      ),
    };
  });

  return { envelope: envelope(window), departments };
}
