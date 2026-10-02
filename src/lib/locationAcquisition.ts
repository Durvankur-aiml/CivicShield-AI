/**
 * Progressive GPS accuracy acquisition (client-side).
 *
 * The browser's FIRST geolocation fix is often a coarse cell/wifi reading
 * (±500 m). Rather than accepting it, this module KEEPS WATCHING and retains
 * the best valid reading — the device itself keeps improving its fix as GPS
 * locks on. The browser-reported `coords.accuracy` is the source of truth for
 * every reading; the app cannot force the device to become more accurate, it
 * can only keep listening and retain the best reading received.
 *
 * Policy:
 *  - LOWER accuracy meters = BETTER. A later WORSE reading never replaces a
 *    better one, and lat/lng/accuracy always travel together as ONE reading
 *    (never mixed across readings).
 *  - Stop as soon as the accuracy target is reached (GPS_TARGET_ACCURACY_METERS).
 *  - Otherwise stop at the bounded acquisition window (GPS_ACQUISITION_WINDOW_MS)
 *    and use the best reading obtained — never block the report on GPS.
 *  - Errors never crash the flow. Without any reading, the first error settles
 *    the hunt as failed (machine-readable code). With a best reading already
 *    held, transient errors (TIMEOUT, POSITION_UNAVAILABLE) are tolerated —
 *    the window keeps running; only PERMISSION_DENIED ends it.
 *  - The watcher is ALWAYS cleared: on target, on deadline, on error-settle,
 *    and via watcher.clear() for unmount/submit (never left running).
 *
 * The selection policy (isBetterReading) is pure and unit-tested; the adapter
 * takes the Geolocation as a parameter so tests can drive it without a device.
 */
import { validateLat, validateLng, locationErrorCode, type LocationErrorCode } from "./location";

/**
 * Accuracy target in meters (product policy — mirrors ACCURACY_GOOD_METERS:
 * "GPS-grade, safe for duplicate + assignment distance"). The hunt stops as
 * soon as a reading reaches this; it is a target, not a requirement to submit.
 */
export const GPS_TARGET_ACCURACY_METERS = 25;

/**
 * Bounded acquisition window. The submit flow must not hold the citizen
 * hostage while a device hunts for a perfect fix: whatever the best reading
 * is when this expires becomes the location. Generous enough for a cold GPS
 * start to reach a good fix on most phones, short enough not to stall the
 * report (the previous implementation allowed 10s for a single fix).
 */
export const GPS_ACQUISITION_WINDOW_MS = 20_000;

/**
 * How long any single watchPosition callback may take to produce a fix before
 * the browser fires a TIMEOUT error for that attempt (hunt continues).
 */
export const GPS_WATCH_TIMEOUT_MS = 10_000;

export type GpsReading = {
  lat: number;
  lng: number;
  /** Device-reported positional accuracy in meters; null when not reported. */
  accuracyMeters: number | null;
  capturedAt: Date;
};

export type GpsFix = {
  lat: number;
  lng: number;
  accuracyMeters: number | null;
  capturedAt: string; // ISO string — ready for the complaint payload
  /** True when the selected fix beat the device's first valid reading. */
  improved: boolean;
};

export type GpsOutcome =
  | { kind: "confirmed"; fix: GpsFix }
  | { kind: "failed"; code: LocationErrorCode };

export type GpsAcquisitionCallbacks = {
  /** A new BEST reading was retained (worse readings are never reported). */
  onProgress: (reading: GpsReading, improved: boolean) => void;
  /** Called exactly once — the hunt is over and the watcher is cleared. */
  onSettled: (outcome: GpsOutcome) => void;
};

/**
 * Best-reading selection. True when `candidate` must REPLACE `best`.
 *  - first valid reading always wins (best === null);
 *  - a finite accuracy beats an unreported one; among finite values, lower wins;
 *  - ties keep the incumbent (a strictly better reading is required).
 * Readings arrive as validated tuples, so lat/lng/accuracy can never be mixed.
 */
export function isBetterReading(candidate: GpsReading, best: GpsReading | null): boolean {
  if (!best) return true;
  if (candidate.accuracyMeters == null) return false; // absence never beats a value
  if (best.accuracyMeters == null) return true;
  return candidate.accuracyMeters < best.accuracyMeters;
}

export type GpsWatcher = { /** Idempotent: silently stops the hunt and clears the browser watch (no onSettled). */ clear: () => void };

/**
 * Runs the progressive hunt: watchPosition until the target accuracy is
 * reached or the window expires, retaining the best valid reading throughout.
 * Returns null (and settles as failed) only when geolocation itself is
 * unavailable; otherwise returns a watcher whose clear() is safe to call at
 * any time (component unmount, submission) and more than once.
 */
export function acquireBestLocation(
  callbacks: GpsAcquisitionCallbacks,
  geolocation?: Geolocation,
  options: { windowMs?: number } = {}
): GpsWatcher | null {
  const geo = geolocation ?? (typeof navigator !== "undefined" ? navigator.geolocation : undefined);
  if (!geo) {
    callbacks.onSettled({ kind: "failed", code: "GEO_UNSUPPORTED" });
    return null;
  }

  const windowMs = options.windowMs ?? GPS_ACQUISITION_WINDOW_MS;
  let best: GpsReading | null = null;
  let everImproved = false;
  let settled = false;
  let watchId: number | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;

  const clearWatch = () => {
    if (watchId != null) {
      geo.clearWatch(watchId);
      watchId = null;
    }
    if (deadline != null) {
      clearTimeout(deadline);
      deadline = null;
    }
  };

  const settle = (outcome: GpsOutcome) => {
    if (settled) return;
    settled = true;
    clearWatch();
    callbacks.onSettled(outcome);
  };

  const toFix = (reading: GpsReading): GpsFix => ({
    lat: reading.lat,
    lng: reading.lng,
    accuracyMeters: reading.accuracyMeters,
    capturedAt: reading.capturedAt.toISOString(),
    improved: everImproved,
  });

  const onPosition = (pos: GeolocationPosition) => {
    if (settled) return;
    const coords = pos?.coords;
    // Validate every reading; malformed ones are ignored, the hunt continues.
    const lat = validateLat(coords?.latitude);
    const lng = validateLng(coords?.longitude);
    if (lat === null || lng === null) return;
    const rawAccuracy = coords?.accuracy;
    // Honest accuracy: a real non-negative value is kept; absence/garbage is
    // null (absence is not precision) rather than a fabricated number.
    const accuracy =
      typeof rawAccuracy === "number" && Number.isFinite(rawAccuracy) && rawAccuracy >= 0
        ? rawAccuracy
        : null;
    const reading: GpsReading = { lat, lng, accuracyMeters: accuracy, capturedAt: new Date() };
    if (!isBetterReading(reading, best)) return; // never replace a better reading
    everImproved = best !== null;
    best = reading;
    callbacks.onProgress(reading, everImproved);
    if (accuracy != null && accuracy <= GPS_TARGET_ACCURACY_METERS) {
      settle({ kind: "confirmed", fix: toFix(reading) });
    }
  };

  const onError = (error: GeolocationPositionError) => {
    if (settled) return;
    const code = locationErrorCode(error);
    if (best) {
      // A best reading is already held. Only a permission revocation ends the
      // hunt early; transient errors (TIMEOUT, POSITION_UNAVAILABLE) leave the
      // window running — the device may still recover and improve.
      if (code === "PERMISSION_DENIED") settle({ kind: "failed", code });
      return;
    }
    settle({ kind: "failed", code });
  };

  watchId = geo.watchPosition(onPosition, onError, {
    enableHighAccuracy: true,
    maximumAge: 0, // real-time fixes only — a cached coarse fix would defeat the purpose
    timeout: GPS_WATCH_TIMEOUT_MS,
  });

  deadline = setTimeout(() => {
    if (settled) return;
    if (best) settle({ kind: "confirmed", fix: toFix(best) });
    else settle({ kind: "failed", code: "TIMEOUT" });
  }, windowMs);

  // External abandonment (unmount, submission): stop the watch and the timer
  // WITHOUT firing onSettled — the caller is leaving the flow on its own
  // terms and needs no outcome (idempotent, safe to call more than once).
  return {
    clear: () => {
      if (settled) return;
      settled = true;
      clearWatch();
    },
  };
}
