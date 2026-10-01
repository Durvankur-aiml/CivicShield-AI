import { prisma } from "../db";
import type { TimeWindow } from "./timeWindow";
import { envelope, countMetric, rateMetric, safeMean, type Envelope, type MetricResult } from "./metricStatus";

/**
 * Verification analytics (Phase 5) — derived from the Phase 4 structured
 * verification states persisted on Complaint. Null verificationResult means
 * "never verified" (honest absence), not a failure and not a success.
 *
 * Definitions (documented in docs/CIVIC_INTELLIGENCE.md):
 * - successRate  = VERIFIED / (VERIFIED + FAILED)          — decidable outcomes only
 * - availabilityRate = (VERIFIED+FAILED+INCONCLUSIVE) / all verified  — how often the
 *   verification pipeline produced ANY decision instead of being unavailable
 */

export type VerificationAnalytics = {
  envelope: Envelope;
  byResult: MetricResult<Array<{ key: string; count: number }>>;
  neverVerified: MetricResult<number>;
  verificationRate: MetricResult<number>;
  successRate: MetricResult<number>;
  availabilityRate: MetricResult<number>;
  avgConfidenceByProvider: Array<{ provider: string; avgConfidence: number | null; sampleSize: number }>;
};

export async function verificationAnalytics(window: TimeWindow): Promise<VerificationAnalytics> {
  const inWindow = { createdAt: { gte: window.from, lt: window.to } };

  const [byResult, neverVerified, total, confidenceRows] = await Promise.all([
    prisma.complaint.groupBy({ by: ["verificationResult"], where: { ...inWindow, verificationResult: { not: null } }, _count: { _all: true } }),
    prisma.complaint.count({ where: { ...inWindow, verificationResult: null } }),
    prisma.complaint.count({ where: inWindow }),
    prisma.complaint.findMany({
      where: { ...inWindow, verificationResult: { in: ["VERIFIED", "FAILED"] } },
      select: { verificationProvider: true, verificationConfidence: true, verificationResult: true },
      take: 2000, // bounded
    }),
  ]);

  return buildVerificationAnalytics(window, { byResult, neverVerified, total, confidenceRows });
}

export function buildVerificationAnalytics(
  window: TimeWindow,
  data: {
    byResult: Array<{ verificationResult: string | null; _count: { _all: number } }>;
    neverVerified: number;
    total: number;
    confidenceRows: Array<{ verificationProvider: string | null; verificationConfidence: number | null; verificationResult: string | null }>;
  }
): VerificationAnalytics {
  const count = (key: string) => data.byResult.find((g) => g.verificationResult === key)?._count._all ?? 0;
  const verified = count("VERIFIED");
  const failed = count("FAILED");
  const inconclusive = count("INCONCLUSIVE");
  const unavailable = count("UNAVAILABLE");
  const anyVerification = verified + failed + inconclusive + unavailable;

  // Confidence transparency: split by provider so MODEL numbers (real
  // inference) are never averaged together with labeled HEURISTIC numbers.
  const byProvider = new Map<string, number[]>();
  for (const row of data.confidenceRows) {
    const c = row.verificationConfidence;
    if (typeof c !== "number" || !Number.isFinite(c)) continue;
    const key = row.verificationProvider ?? "unknown";
    if (!byProvider.has(key)) byProvider.set(key, []);
    byProvider.get(key)!.push(c);
  }

  return {
    envelope: envelope(window),
    byResult: {
      value: data.byResult.map((g) => ({ key: g.verificationResult ?? "NONE", count: g._count._all })),
      sampleSize: anyVerification,
      status: anyVerification > 0 ? "OK" : "NO_DATA",
    },
    neverVerified: countMetric(data.neverVerified),
    verificationRate: rateMetric(anyVerification, data.total),
    successRate: rateMetric(verified, verified + failed),
    availabilityRate: rateMetric(verified + failed + inconclusive, anyVerification),
    avgConfidenceByProvider: [...byProvider.entries()].map(([provider, values]) => ({
      provider,
      avgConfidence: safeMean(values) == null ? null : Number(safeMean(values)!.toFixed(3)),
      sampleSize: values.length,
    })),
  };
}
