import { prisma } from "../db";
import { accuracyLevel } from "../location";
import type { TimeWindow } from "./timeWindow";
import { envelope, countMetric, rateMetric, type Envelope, type MetricResult } from "./metricStatus";

/**
 * Location-quality analytics (Phase 5) — describes how trustworthy the
 * physical-location data behind complaints is. The accuracy classification
 * REUSES the Phase 4 central policy (accuracyLevel in src/lib/location.ts);
 * there is no second threshold table.
 */

export type LocationAnalytics = {
  envelope: Envelope;
  withCoordinates: MetricResult<number>;
  withoutCoordinates: MetricResult<number>;
  coordinateCoverage: MetricResult<number>;
  accuracy: {
    good: MetricResult<number>;
    degraded: MetricResult<number>;
    poor: MetricResult<number>;
    unknown: MetricResult<number>;
  };
  bySource: MetricResult<Array<{ key: string; count: number }>>;
};

export async function locationAnalytics(window: TimeWindow): Promise<LocationAnalytics> {
  const inWindow = { createdAt: { gte: window.from, lt: window.to } };

  const [rows, total, bySource] = await Promise.all([
    prisma.complaint.findMany({
      where: inWindow,
      select: { lat: true, lng: true, accuracyMeters: true, locationSource: true },
    }),
    prisma.complaint.count({ where: inWindow }),
    prisma.complaint.groupBy({
      by: ["locationSource"],
      where: { ...inWindow, locationSource: { not: null } },
      _count: { _all: true },
    }),
  ]);

  return buildLocationAnalytics(window, { rows, total, bySource });
}

export function buildLocationAnalytics(
  window: TimeWindow,
  data: {
    rows: Array<{ lat: number | null; lng: number | null; accuracyMeters: number | null; locationSource: string | null }>;
    total: number;
    bySource: Array<{ locationSource: string | null; _count: { _all: number } }>;
  }
): LocationAnalytics {
  const withCoords = data.rows.filter((r) => r.lat != null && r.lng != null);
  const acc = { good: 0, degraded: 0, poor: 0, unknown: 0 };
  for (const r of withCoords) {
    // Single source of truth for accuracy classification (Phase 4 policy).
    const level = accuracyLevel(r.accuracyMeters);
    if (level === "GOOD") acc.good += 1;
    else if (level === "DEGRADED") acc.degraded += 1;
    else if (level === "POOR") acc.poor += 1;
    else acc.unknown += 1;
  }
  const count = (n: number) => countMetric(n);

  return {
    envelope: envelope(window),
    withCoordinates: count(withCoords.length),
    withoutCoordinates: count(data.total - withCoords.length),
    coordinateCoverage: rateMetric(withCoords.length, data.total),
    accuracy: { good: count(acc.good), degraded: count(acc.degraded), poor: count(acc.poor), unknown: count(acc.unknown) },
    bySource: {
      value: data.bySource.map((g) => ({ key: g.locationSource ?? "UNKNOWN", count: g._count._all })),
      sampleSize: data.bySource.reduce((a, g) => a + g._count._all, 0),
      status: data.bySource.length > 0 ? "OK" : "NO_DATA",
    },
  };
}
