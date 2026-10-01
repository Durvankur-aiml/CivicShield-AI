import { prisma } from "../db";
import { slaStateFor, type SlaState } from "../slaDomain";
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
 * SLA analytics (Phase 5). The operational state distribution REUSES the
 * Phase 3 derived-state function slaStateFor() — the same single source of
 * truth consumed by APIs and the UI. No second SLA derivation exists here,
 * so analytics can never drift from operational behavior. Phase 3 thresholds
 * (SLA_HOURS, SLA_WARNING_FRACTION) are untouched.
 */

export type SlaAnalytics = {
  envelope: Envelope;
  distribution: {
    onTrack: MetricResult<number>;
    warning: MetricResult<number>;
    breached: MetricResult<number>;
    escalated: MetricResult<number>;
    resolved: MetricResult<number>;
  };
  complianceRate: MetricResult<number>; // on-track + warning / all non-resolved
  avgTimeToAssignment: MetricResult<number>; // hours, complaint.assignedAt − createdAt
  avgTimeToAcceptance: MetricResult<number>; // hours, assignment.respondedAt − createdAt (ACCEPTED)
  avgTimeToCompletion: MetricResult<number>; // hours, assignment.completedAt − createdAt (COMPLETED)
};

const OPEN = ["RECEIVED", "ASSIGNED", "IN_PROGRESS", "VERIFICATION", "REOPENED", "ESCALATED"] as const;

export async function slaAnalytics(window: TimeWindow): Promise<SlaAnalytics> {
  // Distribution covers complaints CREATED in the window — the cohort whose
  // SLA behavior the window describes. Bounded select; state derivation is
  // in-process (pure function) over those rows.
  const complaints = await prisma.complaint.findMany({
    where: { createdAt: { gte: window.from, lt: window.to } },
    select: {
      id: true,
      status: true,
      slaDueAt: true,
      isOverdue: true,
      escalationCount: true,
      createdAt: true,
      resolvedAt: true,
      activeAssignment: { select: { slaWarnedAt: true, slaBreachedAt: true, completedAt: true } },
    },
  });

  const [assignedAts, acceptedResponses, completedRows] = await Promise.all([
    prisma.complaint.findMany({
      where: { status: { in: [...OPEN] }, createdAt: { gte: window.from, lt: window.to }, assignedAt: { not: null } },
      select: { createdAt: true, assignedAt: true },
    }),
    prisma.assignment.findMany({
      where: { status: "ACCEPTED", createdAt: { gte: window.from, lt: window.to }, respondedAt: { not: null } },
      select: { createdAt: true, respondedAt: true },
    }),
    prisma.assignment.findMany({
      where: { status: "COMPLETED", completedAt: { gte: window.from, lt: window.to }, startedAt: { not: null } },
      select: { startedAt: true, completedAt: true },
    }),
  ]);

  return buildSlaAnalytics(window, {
    complaints: complaints.map((c) => ({
      status: c.status,
      slaDueAt: c.slaDueAt,
      isOverdue: c.isOverdue,
      escalationCount: c.escalationCount,
      createdAt: c.createdAt,
      resolvedAt: c.resolvedAt,
      activeAssignment: c.activeAssignment ?? null,
    })),
    assignedAts: assignedAts.map((r) => ({ createdAt: r.createdAt, assignedAt: r.assignedAt as Date })),
    acceptances: acceptedResponses.map((r) => ({ createdAt: r.createdAt, respondedAt: r.respondedAt as Date })),
    completions: completedRows.map((r) => ({ startedAt: r.startedAt as Date, completedAt: r.completedAt as Date })),
  });
}

/** Complaint row shape consumed by buildSlaAnalytics: the slaStateFor input
 *  plus the Phase 3 active-assignment SLA markers. */
export type SlaComplaintRow = Parameters<typeof slaStateFor>[0] & {
  activeAssignment: { slaWarnedAt: Date | null; slaBreachedAt: Date | null; completedAt: Date | null } | null;
};

export function buildSlaAnalytics(
  window: TimeWindow,
  data: {
    complaints: SlaComplaintRow[];
    assignedAts: Array<{ createdAt: Date; assignedAt: Date }>;
    acceptances: Array<{ createdAt: Date; respondedAt: Date }>;
    completions: Array<{ startedAt: Date; completedAt: Date }>;
  },
  now: Date = new Date()
): SlaAnalytics {
  const counts: Record<SlaState, number> = { ON_TRACK: 0, WARNING: 0, BREACHED: 0, ESCALATED: 0, RESOLVED: 0 };
  for (const c of data.complaints) {
    counts[slaStateFor(c, c.activeAssignment ?? null, now)] += 1;
  }

  const nonResolved = counts.ON_TRACK + counts.WARNING + counts.BREACHED + counts.ESCALATED;
  const assignH = data.assignedAts.map((r) => (r.assignedAt.getTime() - r.createdAt.getTime()) / 3_600_000);
  const acceptH = data.acceptances.map((r) => (r.respondedAt.getTime() - r.createdAt.getTime()) / 3_600_000);
  const completeH = data.completions.map((r) => (r.completedAt.getTime() - r.startedAt.getTime()) / 3_600_000);
  const assignD = durationMetric(assignH);
  const acceptD = durationMetric(acceptH);
  const completeD = durationMetric(completeH);

  return {
    envelope: envelope(window),
    distribution: {
      onTrack: countMetric(counts.ON_TRACK),
      warning: countMetric(counts.WARNING),
      breached: countMetric(counts.BREACHED),
      escalated: countMetric(counts.ESCALATED),
      resolved: countMetric(counts.RESOLVED),
    },
    complianceRate: rateMetric(counts.ON_TRACK + counts.WARNING, nonResolved),
    avgTimeToAssignment: assignD.avg,
    avgTimeToAcceptance: acceptD.avg,
    avgTimeToCompletion: completeD.avg,
  };
}
