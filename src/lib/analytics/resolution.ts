import { prisma } from "../db";
import type { TimeWindow } from "./timeWindow";
import {
  envelope,
  countMetric,
  rateMetric,
  durationMetric,
  type Envelope,
  type MetricResult,
} from "./metricStatus";

/**
 * Resolution analytics (Phase 5) — derived from Complaint lifecycle
 * timestamps. Resolution time = resolvedAt − createdAt, computed only for
 * complaints that actually resolved inside the window (resolvedAt present and
 * in [from, to)). Non-negative filter rejects clock anomalies; zero
 * denominators yield NO_DATA, never a fake 0.
 */

export type ResolutionAnalytics = {
  envelope: Envelope;
  resolved: MetricResult<number>;
  unresolved: MetricResult<number>;
  reopened: MetricResult<number>;
  resolutionRate: MetricResult<number>;
  avgResolutionTime: MetricResult<number>; // hours
  medianResolutionTime: MetricResult<number>; // hours
};

export async function resolutionAnalytics(window: TimeWindow): Promise<ResolutionAnalytics> {
  const createdIn = { createdAt: { gte: window.from, lt: window.to } };
  const resolvedIn = { resolvedAt: { gte: window.from, lt: window.to } };

  const [resolved, total, reopened, rows] = await Promise.all([
    prisma.complaint.count({ where: resolvedIn }),
    prisma.complaint.count({ where: createdIn }),
    prisma.complaint.count({ where: { ...createdIn, status: "REOPENED" } }),
    prisma.complaint.findMany({
      where: { ...resolvedIn, status: { in: ["RESOLVED", "CLOSED"] } },
      select: { createdAt: true, resolvedAt: true },
    }),
  ]);

  return buildResolutionAnalytics(window, {
    resolved,
    total,
    reopened,
    // resolvedAt is guaranteed non-null by the where clause; narrowing maps it.
    rows: rows.map((r) => ({ createdAt: r.createdAt, resolvedAt: r.resolvedAt as Date })),
  });
}

export function buildResolutionAnalytics(
  window: TimeWindow,
  data: {
    resolved: number;
    total: number;
    reopened: number;
    rows: Array<{ createdAt: Date; resolvedAt: Date }>;
  }
): ResolutionAnalytics {
  const durationsH = data.rows.map((r) => (r.resolvedAt.getTime() - r.createdAt.getTime()) / 3_600_000);
  const unresolved = Math.max(0, data.total - data.resolved);
  const durations = durationMetric(durationsH);

  return {
    envelope: envelope(window),
    resolved: countMetric(data.resolved),
    unresolved: countMetric(unresolved),
    reopened: countMetric(data.reopened),
    resolutionRate: rateMetric(data.resolved, data.total),
    avgResolutionTime: durations.avg,
    medianResolutionTime: durations.median,
  };
}
