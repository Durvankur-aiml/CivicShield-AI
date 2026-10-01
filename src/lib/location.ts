/**
 * Central geospatial reliability policy (Phase 4, Workstream A).
 *
 * Coordinates are the AUTHORITATIVE location of a complaint; the address is
 * descriptive metadata. Everything that decides "is this location valid /
 * fresh / precise enough" lives HERE — no `accuracy > 100` magic numbers
 * scattered through random files.
 */
import {
  ACCURACY_DEGRADED_METERS,
  ACCURACY_GOOD_METERS,
  ACCURACY_MAX_METERS,
  LOCATION_SOURCES,
  type AccuracyLevel,
  type LocationSource,
} from "./constants";

/** One canonical representation everywhere: latitude, longitude. Never swapped. */
export type Coordinates = { lat: number; lng: number };

export type ValidatedLocation = Coordinates & {
  /** Browser/device-reported positional accuracy in meters, clamped to policy. */
  accuracyMeters: number | null;
  /** Canonical location source. */
  source: LocationSource;
  /** When the reading was obtained (staleness signal). */
  capturedAt: Date | null;
};

/**
 * Server-side coordinate validation. The single entry point every route uses.
 * Returns null instead of throwing so callers can decide policy; rejects:
 * non-numbers, NaN, ±Infinity, out-of-range, and boolean/string coercion traps.
 */
export function validateCoordinate(
  value: unknown,
  min: number,
  max: number
): number | null {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

export function validateLat(value: unknown): number | null {
  return validateCoordinate(value, -90, 90);
}

export function validateLng(value: unknown): number | null {
  return validateCoordinate(value, -180, 180);
}

/** Form-field variant: form values are strings or absent; empty → absent. */
export function parseCoordinateField(raw: FormDataEntryValue | null): number | undefined | null {
  if (raw == null || raw === "") return undefined; // absent / empty is "not provided"
  const n = Number(raw);
  return Number.isFinite(n) ? n : null; // present-but-garbage ("abc") → invalid
}

/**
 * Classifies device-reported accuracy against the central policy.
 * UNKNOWN — the device never reported an accuracy value (honest: absence is
 * not precision); GOOD/DEGRADED/POOR per thresholds in constants.ts.
 */
export function accuracyLevel(accuracyMeters: number | null | undefined): AccuracyLevel {
  if (accuracyMeters == null || !Number.isFinite(accuracyMeters) || accuracyMeters < 0) {
    return "UNKNOWN";
  }
  if (accuracyMeters <= ACCURACY_GOOD_METERS) return "GOOD";
  if (accuracyMeters <= ACCURACY_DEGRADED_METERS) return "DEGRADED";
  if (accuracyMeters <= ACCURACY_MAX_METERS) return "POOR";
  return "POOR";
}

/** True when a location is trustworthy enough to drive distance decisions. */
export function isUsableAccuracy(level: AccuracyLevel): boolean {
  return level === "GOOD" || level === "DEGRADED";
}

/**
 * Normalizes a raw device fix into the persisted shape. Clamps out-of-policy
 * accuracy to ACCURACY_MAX_METERS (a hostile/buggy client claiming ±1,000,000 m
 * must not poison distance logic), defaults the source honestly, and passes the
 * device timestamp through. Coordinates themselves must already be validated.
 */
export function normalizeLocation(input: {
  lat: number;
  lng: number;
  accuracyMeters?: number | null;
  source?: string | null;
  capturedAt?: Date | string | null;
}): ValidatedLocation {
  const accuracy =
    input.accuracyMeters != null && Number.isFinite(input.accuracyMeters) && input.accuracyMeters >= 0
      ? Math.min(input.accuracyMeters, ACCURACY_MAX_METERS)
      : null;
  const source = LOCATION_SOURCES.includes(input.source as LocationSource)
    ? (input.source as LocationSource)
    : "UNKNOWN";
  const capturedAt = input.capturedAt ? new Date(input.capturedAt) : null;
  return {
    lat: input.lat,
    lng: input.lng,
    accuracyMeters: accuracy,
    source,
    capturedAt: capturedAt && !Number.isNaN(capturedAt.getTime()) ? capturedAt : null,
  };
}

/**
 * Machine-readable location error codes (A8). The UI maps these to friendly
 * copy; the complaint flow NEVER crashes because of a location problem and
 * NEVER silently substitutes a default location.
 */
export const LOCATION_ERROR_CODES = [
  "GEO_UNSUPPORTED",
  "PERMISSION_DENIED",
  "POSITION_UNAVAILABLE",
  "TIMEOUT",
  "INVALID_COORDINATES",
  "UNKNOWN",
] as const;
export type LocationErrorCode = (typeof LOCATION_ERROR_CODES)[number];

/** Maps a browser GeolocationPositionError.code to a stable error code. */
export function locationErrorCode(error: unknown): LocationErrorCode {
  const code = (error as { code?: number } | null | undefined)?.code;
  if (code === 1) return "PERMISSION_DENIED";
  if (code === 2) return "POSITION_UNAVAILABLE";
  if (code === 3) return "TIMEOUT";
  return "UNKNOWN";
}

/** True when the reading is fresh enough to trust (product policy: 30 min). */
export const LOCATION_FRESHNESS_MS = 30 * 60_000;
export function isLocationFresh(capturedAt: Date | null, now = Date.now()): boolean {
  if (!capturedAt) return false; // unknown age — treated as not fresh
  const age = now - capturedAt.getTime();
  return age >= 0 && age <= LOCATION_FRESHNESS_MS;
}
