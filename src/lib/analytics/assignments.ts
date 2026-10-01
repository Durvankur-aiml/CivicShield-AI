import { prisma } from "../db";
import type { TimeWindow } from "./timeWindow";
import { envelope, countMetric, rateMetric, metricOk, metricNoData, metricInsufficient, safeMean, safeMedian, type Envelope, type MetricResult } from "./metricStatus";

/**
 * Assignment analytics (Phase 5) — derived entirely from Assignment rows and
 * the AgentActivity audit trail. Assignment SUCCESS RATE uses the operational
 * definition: accepted offers / offered assignments in the window (documented
 * in docs/CIVIC_INTELLIGENCE.md). NO-eligible-worker cases are counted from
 * the engine's own audit records (agent ActivityAgent, action
 * NO_ELIGIBLE_WORKER) — the engine writes them only there, which is the
 * source of truth for that outcome.
 */

export type AssignmentAnalytics = {
  envelope: Envelope;
  totals: {
    offered: MetricResult<number>;
    accepted: MetricResult<number>;
    completed: MetricResult<number>;
    rejected: MetricResult<number>;
    cancelled: MetricResult<number>;
    reassigned: MetricResult<number>;
  };
  modes: {
    auto: MetricResult<number>;
    manual: MetricResult<number>;
    override: MetricResult<number>;
  };
  rejectionDrivenReassignments: MetricResult<number>;
  noEligibleWorkerCases: MetricResult<number>;
  acceptanceRate: MetricResult<number>;
  overrideRate: MetricResult<number>;
  distance: {
    avgMeters: MetricResult<number>;
    medianMeters: MetricResult<number>;
    sampleSize: number;
  };
};

export async function assignmentAnalytics(window: TimeWindow): Promise<AssignmentAnalytics> {
  const inWindow = { createdAt: { gte: window.from, lt: window.to } };
  const byStatus = (status: string) =>
    prisma.assignment.count({ where: { ...inWindow, status } });

  const [offered, accepted, completed, rejected, cancelled, reassigned, auto, manual, override, rejectionReassign, noEligible, scored] =
    await Promise.all([
      prisma.assignment.count({ where: inWindow }),
      byStatus("ACCEPTED"),
      byStatus("COMPLETED"),
      byStatus("REJECTED"),
      byStatus("CANCELLED"),
      byStatus("REASSIGNED"),
      prisma.assignment.count({ where: { ...inWindow, mode: "AUTO" } }),
      prisma.assignment.count({ where: { ...inWindow, mode: "MANUAL" } }),
      prisma.assignment.count({ where: { ...inWindow, mode: "OVERRIDE" } }),
      prisma.assignment.count({
        where: { ...inWindow, status: "REASSIGNED", previousAssignment: { status: "REJECTED" } },
      }),
      prisma.agentActivity.count({
        where: { agent: "AssignmentAgent", action: "NO_ELIGIBLE_WORKER", createdAt: { gte: window.from, lt: window.to } },
      }),
      prisma.assignment.findMany({
        where: {
          ...inWindow,
          mode: "AUTO",
          status: { in: ["ACCEPTED", "IN_PROGRESS", "COMPLETED"] },
          decision: { not: null },
        },
        select: { decision: true },
        take: 1000, // bounded sample for distance statistics
      }),
    ]);

  return buildAssignmentAnalytics(window, {
    offered, accepted, completed, rejected, cancelled, reassigned,
    auto, manual, override, rejectionReassign, noEligible, scored,
  });
}

export function buildAssignmentAnalytics(
  window: TimeWindow,
  data: {
    offered: number;
    accepted: number;
    completed: number;
    rejected: number;
    cancelled: number;
    reassigned: number;
    auto: number;
    manual: number;
    override: number;
    rejectionReassign: number;
    noEligible: number;
    scored: Array<{ decision: string | null }>;
  }
): AssignmentAnalytics {
  // Distance from the engine's own decision records — one deterministic
  // calculation (the repo's single haversine implementation). Malformed or
  // incomplete decision JSON is skipped, never guessed.
  const distances: number[] = [];
  for (const row of data.scored) {
    try {
      const d = JSON.parse(row.decision ?? "") as {
        selected?: { distanceM?: number | null };
      };
      const dist = d.selected?.distanceM;
      if (typeof dist === "number" && Number.isFinite(dist) && dist >= 0) distances.push(dist);
    } catch {
      // unreadable decision record — excluded, not invented
    }
  }
  const avgD = safeMean(distances);
  const medD = safeMedian(distances);
  const distNone: MetricResult<number> =
    distances.length === 0 ? metricNoData<number>("meters") : metricInsufficient<number>(distances.length as 0 | 1, "meters");

  return {
    envelope: envelope(window),
    totals: {
      offered: countMetric(data.offered),
      accepted: countMetric(data.accepted),
      completed: countMetric(data.completed),
      rejected: countMetric(data.rejected),
      cancelled: countMetric(data.cancelled),
      reassigned: countMetric(data.reassigned),
    },
    modes: {
      auto: countMetric(data.auto),
      manual: countMetric(data.manual),
      override: countMetric(data.override),
    },
    rejectionDrivenReassignments: countMetric(data.rejectionReassign),
    noEligibleWorkerCases: countMetric(data.noEligible),
    acceptanceRate: rateMetric(data.accepted, data.offered),
    overrideRate: rateMetric(data.override, data.offered),
    distance: {
      avgMeters: avgD == null ? distNone : metricOk(Math.round(avgD), distances.length, "meters"),
      medianMeters: medD == null ? distNone : metricOk(Math.round(medD), distances.length, "meters"),
      sampleSize: distances.length,
    },
  };
}
