import { prisma } from "../db";
import type { TimeWindow } from "./timeWindow";
import { MIN_SAMPLE, type MetricStatus } from "./metricStatus";

/**
 * Trend analytics (Phase 5, spec §6) — DESCRIPTIVE deltas between the
 * selected window and the immediately preceding window of equal length.
 * A trend here is a measured change ("+5 complaints vs the previous 7 days"),
 * never a prediction and never an extrapolation into the future.
 *
 * INSUFFICIENT_DATA semantics: a window with fewer than MIN_SAMPLE (2)
 * records cannot support a meaningful direction, so the trend is reported
 * as such instead of a misleading ±100%.
 */

export type TrendDirection = "UP" | "DOWN" | "FLAT" | "INSUFFICIENT_DATA";

export type Trend = {
  metric: string;
  current: number;
  previous: number;
  change: number | null; // absolute delta; null when insufficient data
  changePct: number | null; // relative to previous; null when previous = 0 or insufficient
  direction: TrendDirection;
  status: MetricStatus;
  note: string;
};

export type TrendAnalytics = {
  currentWindow: { from: string; to: string };
  previousWindow: { from: string; to: string };
  trends: Trend[];
};

/** Pure direction classifier — exported for deterministic tests. */
export function directionFor(current: number, previous: number, minSample = MIN_SAMPLE): TrendDirection {
  if (current < minSample || previous < minSample) return "INSUFFICIENT_DATA";
  if (current > previous) return "UP";
  if (current < previous) return "DOWN";
  return "FLAT";
}

/** Pure trend builder: both window counts are supplied; nothing is inferred. */
export function buildTrend(metric: string, current: number, previous: number): Trend {
  const direction = directionFor(current, previous);
  const insufficient = direction === "INSUFFICIENT_DATA";
  const change = insufficient ? null : current - previous;
  const changePct = insufficient || previous === 0 ? null : Number((((current - previous) / previous) * 100).toFixed(1));
  const note = insufficient
    ? `Only ${current} record(s) in the current window and ${previous} in the previous window — not enough data for a direction.`
    : `${current} in the selected window vs ${previous} in the previous window.`;
  return {
    metric,
    current,
    previous,
    change,
    changePct,
    direction,
    status: insufficient ? "INSUFFICIENT_DATA" : "OK",
    note,
  };
}

export async function trendAnalytics(window: TimeWindow): Promise<TrendAnalytics> {
  const len = window.to.getTime() - window.from.getTime();
  const prevFrom = new Date(window.from.getTime() - len);
  const prevTo = window.from; // half-open continuity: previous window ends where current begins

  const currentWhere = { createdAt: { gte: window.from, lt: window.to } };
  const previousWhere = { createdAt: { gte: prevFrom, lt: prevTo } };

  // One parallel batch — six bounded, indexed counts/groupBys, no N+1.
  const [current, previous, curResolved, prevResolved, curBreached, prevBreached, curCats, prevCats] =
    await Promise.all([
      prisma.complaint.count({ where: currentWhere }),
      prisma.complaint.count({ where: previousWhere }),
      prisma.complaint.count({ where: { resolvedAt: { gte: window.from, lt: window.to } } }),
      prisma.complaint.count({ where: { resolvedAt: { gte: prevFrom, lt: prevTo } } }),
      // Breach trend uses the complaint-level OVERDUE marker (operational
      // breach state) among complaints created in each window.
      prisma.complaint.count({ where: { ...currentWhere, isOverdue: true, status: { notIn: ["RESOLVED", "CLOSED"] } } }),
      prisma.complaint.count({ where: { ...previousWhere, isOverdue: true, status: { notIn: ["RESOLVED", "CLOSED"] } } }),
      prisma.complaint.groupBy({ by: ["category"], where: currentWhere, _count: { _all: true } }),
      prisma.complaint.groupBy({ by: ["category"], where: previousWhere, _count: { _all: true } }),
    ]);

  const trends: Trend[] = [
    buildTrend("complaint_volume", current, previous),
    buildTrend("resolutions", curResolved, prevResolved),
    buildTrend("open_sla_breaches", curBreached, prevBreached),
  ];

  // Per-category trends for categories present in either window.
  const categories = new Map<string, { current: number; previous: number }>();
  for (const row of prevCats) categories.set(row.category, { current: 0, previous: row._count._all });
  for (const row of curCats) {
    const entry = categories.get(row.category) ?? { current: 0, previous: 0 };
    entry.current = row._count._all;
    categories.set(row.category, entry);
  }
  for (const [category, c] of [...categories.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    trends.push(buildTrend(`category:${category}`, c.current, c.previous));
  }

  return {
    currentWindow: { from: window.from.toISOString(), to: window.to.toISOString() },
    previousWindow: { from: prevFrom.toISOString(), to: prevTo.toISOString() },
    trends,
  };
}
