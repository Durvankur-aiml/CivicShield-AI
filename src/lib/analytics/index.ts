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
    complaintVolume(window),
    resolutionAnalytics(window),
    slaAnalytics(window),
    assignmentAnalytics(window),
    verificationAnalytics(window),
    locationAnalytics(window),
    trendAnalytics(window),
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
