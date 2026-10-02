import type { TimeWindow } from "./timeWindow";
import { complaintVolume, buildComplaintAnalytics, buildDailySeries, type ComplaintAnalytics } from "./complaints";
import { resolutionAnalytics, buildResolutionAnalytics, type ResolutionAnalytics } from "./resolution";
import { slaAnalytics, buildSlaAnalytics, type SlaAnalytics } from "./sla";
import { workerAnalytics, buildWorkerAnalytics, type WorkerAnalytics } from "./workers";
import { assignmentAnalytics, buildAssignmentAnalytics, type AssignmentAnalytics } from "./assignments";
import { departmentAnalytics, buildDepartmentAnalytics, type DepartmentAnalytics } from "./departments";
import { verificationAnalytics, buildVerificationAnalytics, type VerificationAnalytics } from "./verification";
import { locationAnalytics, buildLocationAnalytics, type LocationAnalytics } from "./location";
import {
  hotspotAnalytics,
  buildHotspots,
  cellKey,
  cellCenter,
  HOTSPOT_CELL_METERS,
  DEFAULT_MIN_HOTSPOT_COUNT,
  type HotspotAnalytics,
} from "./hotspots";
import {
  recurringAnalytics,
  buildRecurring,
  areaKey,
  RECURRING_CATEGORY_MIN,
  RECURRING_AREA_MIN,
  type RecurringAnalytics,
} from "./recurring";
import { trendAnalytics, buildTrend, directionFor, type TrendAnalytics } from "./trends";
import { envelope, type Envelope } from "./metricStatus";

/**
 * Analytics domain bundle (Phase 5). The overview endpoint runs every metric
 * group in ONE parallel batch — bounded, indexed queries, no N+1 — while the
 * focused endpoints call their single domain function directly.
 */

export type OverviewAnalytics = {
  envelope: Envelope;
  complaints: ComplaintAnalytics;
  resolution: ResolutionAnalytics;
  sla: SlaAnalytics;
  assignments: AssignmentAnalytics;
  verification: VerificationAnalytics;
  location: LocationAnalytics;
  trends: TrendAnalytics;
};

export async function overviewAnalytics(window: TimeWindow) {
  const [complaints, resolution, sla, assignments, verification, location, trends] = await Promise.all([
    withPoolRetry(() => complaintVolume(window)),
    withPoolRetry(() => resolutionAnalytics(window)),
    withPoolRetry(() => slaAnalytics(window)),
    withPoolRetry(() => assignmentAnalytics(window)),
    withPoolRetry(() => verificationAnalytics(window)),
    withPoolRetry(() => locationAnalytics(window)),
    withPoolRetry(() => trendAnalytics(window)),
  ]);
  return {
    envelope: envelope(window),
    complaints,
    resolution,
    sla,
    assignments,
    verification,
    location,
    trends,
  };
}

// ── Transient connection-pooler resilience (overview burst) ─────────────
// The overview endpoint runs SEVEN metric groups in parallel (~30 queries).
// Against Supabase PgBouncer this can briefly exceed the server-side client
// cap (observed: FATAL (EMAXCONNSESSION) … pool_size: 15), which surfaced to
// the UI as an opaque "Internal server error". These failures are TRANSIENT
// connection-scheduling issues, not data problems: a short bounded retry
// turns them into a correct response. Anything else rethrows immediately —
// no silent swallowing, no fabricated metrics (NO-SILENT-FAILURE rule).

/** Prisma/Postgres error text that indicates a momentary pooler overload. */
function isTransientPoolError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message ?? "";
  if (/EMAXCONNSESSION|max clients reached|pool_size|Pool timeout|Connection terminated|too many connections/i.test(msg)) {
    return true;
  }
  // Observed variant: PrismaClientUnknownRequestError with an EMPTY message
  // carrying the pooler FATAL only in the connector log.
  return err.name === "PrismaClientUnknownRequestError" && msg.length === 0;
}

const POOL_RETRY_DELAYS_MS = [150, 400, 900];

/** Bounded retry wrapper for one metric group (rethrows non-transient immediately). */
async function withPoolRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= POOL_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, POOL_RETRY_DELAYS_MS[attempt - 1]));
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientPoolError(err)) throw err;
    }
  }
  throw lastErr;
}

export {
  complaintVolume,
  buildComplaintAnalytics,
  buildDailySeries,
  resolutionAnalytics,
  buildResolutionAnalytics,
  slaAnalytics,
  buildSlaAnalytics,
  workerAnalytics,
  buildWorkerAnalytics,
  assignmentAnalytics,
  buildAssignmentAnalytics,
  departmentAnalytics,
  buildDepartmentAnalytics,
  verificationAnalytics,
  buildVerificationAnalytics,
  locationAnalytics,
  buildLocationAnalytics,
  hotspotAnalytics,
  buildHotspots,
  cellKey,
  cellCenter,
  HOTSPOT_CELL_METERS,
  DEFAULT_MIN_HOTSPOT_COUNT,
  recurringAnalytics,
  buildRecurring,
  areaKey,
  RECURRING_CATEGORY_MIN,
  RECURRING_AREA_MIN,
  trendAnalytics,
  buildTrend,
  directionFor,
};

export type {
  ComplaintAnalytics,
  ResolutionAnalytics,
  SlaAnalytics,
  WorkerAnalytics,
  AssignmentAnalytics,
  DepartmentAnalytics,
  VerificationAnalytics,
  LocationAnalytics,
  HotspotAnalytics,
  RecurringAnalytics,
  TrendAnalytics,
};

export { parseWindow, WINDOW_PRESETS, MAX_RANGE_DAYS, TimeWindowError } from "./timeWindow";
export type { TimeWindow, WindowPreset } from "./timeWindow";
export {
  METRIC_STATUSES,
  MIN_SAMPLE,
  metricOk,
  metricNoData,
  metricInsufficient,
  countMetric,
  rateMetric,
  safeMean,
  safeMedian,
  safeRate,
  durationMetric,
  envelope,
} from "./metricStatus";
export type { MetricResult, MetricStatus, Envelope } from "./metricStatus";
