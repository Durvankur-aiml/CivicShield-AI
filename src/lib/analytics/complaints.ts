import { prisma } from "../db";
import type { TimeWindow } from "./timeWindow";
import { envelope, metricOk, countMetric, type Envelope, type MetricResult } from "./metricStatus";

/**
 * Complaint volume analytics (Phase 5) — every figure derives from Complaint
 * rows via database aggregation (Prisma count/groupBy). Nothing is stored
 * separately: all values are reproducible from source records.
 */

export type GroupCount = { key: string; count: number };

export type ComplaintAnalytics = {
  envelope: Envelope;
  totals: {
    total: MetricResult<number>;
    byStatus: MetricResult<GroupCount[]>;
    byCategory: MetricResult<GroupCount[]>;
    byDepartment: MetricResult<GroupCount[]>;
  };
  series: {
    bucket: "day";
    points: Array<{ bucketStart: string; count: number }>;
  };
};

const BUCKET_MS = 86_400_000;

/** Floor a UTC instant to the start of its UTC day (bucket key, not display). */
function utcDayFloor(d: Date): Date {
  return new Date(Math.floor(d.getTime() / BUCKET_MS) * BUCKET_MS);
}

/**
 * Fetches only createdAt values within the window and buckets them by UTC day.
 * WHY application-side bucketing: Prisma 6 groupBy cannot truncate dates; the
 * fetch is bounded to the window (max 366 days) and selects the single indexed
 * createdAt column — documented per spec §15.
 */
export async function complaintVolume(window: TimeWindow): Promise<ComplaintAnalytics> {
  const inWindow = { createdAt: { gte: window.from, lt: window.to } };

  const [total, byStatus, byCategory, byDepartment, createdAts, departments] = await Promise.all([
    prisma.complaint.count({ where: inWindow }),
    prisma.complaint.groupBy({ by: ["status"], where: inWindow, _count: { _all: true } }),
    prisma.complaint.groupBy({ by: ["category"], where: inWindow, _count: { _all: true } }),
    prisma.complaint.groupBy({
      by: ["departmentId"],
      where: { ...inWindow, departmentId: { not: null } },
      _count: { _all: true },
    }),
    prisma.complaint.findMany({ where: inWindow, select: { createdAt: true }, orderBy: { createdAt: "asc" } }),
    prisma.department.findMany({ select: { id: true, code: true } }),
  ]);

  return buildComplaintAnalytics(window, total, byStatus, byCategory, byDepartment, createdAts, departments);
}

/** Pure assembly, separated from I/O so tests can use deterministic fixtures. */
export function buildComplaintAnalytics(
  window: TimeWindow,
  total: number,
  byStatus: Array<{ status: string; _count: { _all: number } }>,
  byCategory: Array<{ category: string; _count: { _all: number } }>,
  byDepartment: Array<{ departmentId: string | null; _count: { _all: number } }>,
  createdAts: Array<{ createdAt: Date }>,
  departments: Array<{ id: string; code: string }>
): ComplaintAnalytics {
  return {
    envelope: envelope(window),
    totals: {
      total: countMetric(total),
      byStatus: metricOk(
        byStatus.map((g) => ({ key: g.status, count: g._count._all })),
        total
      ),
      byCategory: metricOk(
        byCategory.map((g) => ({ key: g.category, count: g._count._all })),
        total
      ),
      byDepartment: metricOk(
        byDepartment.map((g) => ({
          key: departments.find((d) => d.id === g.departmentId)?.code ?? "UNKNOWN",
          count: g._count._all,
        })),
        total
      ),
    },
    series: { bucket: "day", points: buildDailySeries(createdAts.map((r) => r.createdAt)) },
  };
}

/**
 * Pure, deterministic UTC-day bucketing. Empty buckets are NOT padded —
 * a missing day means "no complaints that day", which is a legitimate zero
 * rendered client-side; padding 366 empty points adds noise, not information.
 */
export function buildDailySeries(createdAts: Date[]): Array<{ bucketStart: string; count: number }> {
  const counts = new Map<string, number>();
  for (const t of createdAts) {
    counts.set(utcDayFloor(t).toISOString(), (counts.get(utcDayFloor(t).toISOString()) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([bucketStart, count]) => ({ bucketStart, count }))
    .sort((a, b) => a.bucketStart.localeCompare(b.bucketStart));
}
