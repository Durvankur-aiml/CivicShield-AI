import type { TimeWindow } from "./timeWindow";

/**
 * Analytics response contract (Phase 5, spec §13).
 *
 * Every derived metric distinguishes:
 *   OK                — computed from real records (value may be 0 legitimately)
 *   NO_DATA           — no records in scope (a rate denominator of 0, e.g.)
 *   INSUFFICIENT_DATA — records exist but too few for a meaningful value
 *
 * A legitimate zero is never conflated with "not enough data to calculate".
 * Nothing here fabricates a value: when data cannot support a metric, the
 * status says so instead of returning a misleading number.
 */

export const METRIC_STATUSES = ["OK", "NO_DATA", "INSUFFICIENT_DATA"] as const;
export type MetricStatus = (typeof METRIC_STATUSES)[number];

/** Minimum sample size for "meaningful" statistical values (rates, medians, trends). */
export const MIN_SAMPLE = 2;

export type MetricResult<T> = {
  value: T | null;
  sampleSize: number;
  status: MetricStatus;
  unit?: string;
};

export function metricOk<T>(value: T, sampleSize: number, unit?: string): MetricResult<T> {
  return { value, sampleSize, status: "OK", unit };
}

export function metricNoData<T = number>(unit?: string): MetricResult<T> {
  return { value: null, sampleSize: 0, status: "NO_DATA", unit };
}

export function metricInsufficient<T>(sampleSize: 0 | 1, unit?: string): MetricResult<T> {
  return { value: null, sampleSize, status: "INSUFFICIENT_DATA", unit };
}

/** Signed integer metric: 0 with zero records is still OK (a true zero). */
export function countMetric(value: number): MetricResult<number> {
  return { value, sampleSize: value, status: "OK" };
}

/** Mean over a finite numeric array — null/NaN/negative inputs are excluded first. */
export function safeMean(values: number[]): number | null {
  const v = values.filter((n) => Number.isFinite(n) && n >= 0);
  if (v.length === 0) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

/**
 * Median (lower-middle element for even counts — deterministic, cheap).
 * Negative durations are excluded: a completedAt before startedAt is a data
 * anomaly, not a meaningful duration (spec §17).
 */
export function safeMedian(values: number[]): number | null {
  const v = values.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : v[mid - 1];
}

/** Rate = part/whole, guarded against zero denominators; NaN can never leak. */
export function safeRate(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return part / whole;
}

/**
 * A rate computed from a sample; NO_DATA with zero denominator,
 * INSUFFICIENT_DATA with a 1-element sample (a 0%/100% rate from one record
 * is not meaningful), OK otherwise. Rounds to a stable 4 decimals.
 */
export function rateMetric(part: number, whole: number, unit = "ratio"): MetricResult<number> {
  if (whole <= 0) return metricNoData(unit);
  if (whole === 1) return metricInsufficient(1, unit);
  const rate = safeRate(part, whole);
  return rate == null ? metricNoData(unit) : metricOk(Number(rate.toFixed(4)), whole, unit);
}

/** Bounding envelope for every analytics payload (explainability + debugging). */
export type Envelope = {
  window: { from: string; to: string; preset: string };
  generatedAt: string;
};

export function envelope(window: TimeWindow, now: Date = new Date()): Envelope {
  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString(), preset: window.preset },
    generatedAt: now.toISOString(),
  };
}

/**
 * Duration metric over hour values (already non-negative-filtered by
 * safeMean/safeMedian): NO_DATA with no samples, OK otherwise.
 * Unlike rates, a single duration sample is a REAL measurement (mean = median
 * = that value) — nothing is estimated — so the sampleSize field carries the
 * nuance instead of an INSUFFICIENT_DATA status. Shared by
 * SLA/worker/assignment/resolution metrics.
 */
export function durationMetric(hours: number[]): {
  avg: MetricResult<number>;
  median: MetricResult<number>;
  sampleSize: number;
} {
  const avg = safeMean(hours);
  const median = safeMedian(hours);
  const none: MetricResult<number> =
    hours.length === 0 ? metricNoData<number>("hours") : metricInsufficient<number>(hours.length as 0 | 1, "hours");
  return {
    avg: avg == null ? none : metricOk(Number(avg.toFixed(2)), hours.length, "hours"),
    median: median == null ? none : metricOk(Number(median.toFixed(2)), hours.length, "hours"),
    sampleSize: hours.length,
  };
}
