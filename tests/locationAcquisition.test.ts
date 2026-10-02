import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireBestLocation,
  GPS_ACQUISITION_WINDOW_MS,
  GPS_TARGET_ACCURACY_METERS,
  GPS_WATCH_TIMEOUT_MS,
  isBetterReading,
  type GpsReading,
} from "@/lib/locationAcquisition";
import { ACCURACY_GOOD_METERS } from "@/lib/constants";

/**
 * Progressive GPS accuracy acquisition (Part A).
 *
 * BROWSER GPS INTEGRATION NOT TESTED against a real device in this
 * environment (no geolocation sensors) — the module is deterministic and
 * takes the Geolocation as a parameter, so these tests drive a FAKE
 * geolocation: watchPosition/clearWatch are spied and readings/errors are
 * emitted manually. The selection policy is additionally pinned pure.
 */

const reading = (accuracy: number | null, lat = 16.7, lng = 74.24): GpsReading => ({
  lat,
  lng,
  accuracyMeters: accuracy,
  capturedAt: new Date(),
});

/** Fake Geolocation: records watches; tests emit fixes via the returned harness. */
function makeFakeGeo() {
  const handlers: Array<{ watchId: number; onPosition: (p: GeolocationPosition) => void; onError: (e: GeolocationPositionError) => void }> = [];
  let nextWatchId = 1;
  const cleared: number[] = [];
  const geo = {
    watchPosition: vi.fn((onPosition: (p: GeolocationPosition) => void, onError: (e: GeolocationPositionError) => void) => {
      const watchId = nextWatchId++;
      handlers.push({ watchId, onPosition, onError });
      return watchId;
    }),
    clearWatch: vi.fn((id: number) => {
      cleared.push(id);
    }),
    getCurrentPosition: vi.fn(),
  } as unknown as Geolocation;
  return {
    geo,
    /**
     * Emit a position fix to the newest watch. Browsers only report accuracy as
     * a finite number in the DOM type, so the fake drives `coords.accuracy` as
     * the same numeric value we pass; null-accuracy combinations are exercised
     * against the pure `isBetterReading` policy directly (already covered above).
     */
    fix: (accuracy: number, lat = 16.7, lng = 74.24) => {
      const h = handlers[handlers.length - 1];
      h?.onPosition({ coords: { latitude: lat, longitude: lng, accuracy } } as unknown as GeolocationPosition);
    },
    /** Emit an error to the newest watch (1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT). */
    fail: (code: 1 | 2 | 3) => {
      const h = handlers[handlers.length - 1];
      h?.onError({ code, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError);
    },
    watchCount: () => handlers.length,
    cleared,
  };
}

describe("best-reading selection policy (pure)", () => {
  it("keeps only strictly better readings — 500 → 200 → 50 → 20, then worse is ignored", () => {
    let best: GpsReading | null = null;
    for (const r of [reading(500), reading(200), reading(50), reading(20), reading(70), reading(120)]) {
      if (isBetterReading(r, best)) best = r;
    }
    expect(best?.accuracyMeters).toBe(20);
  });

  it("the first valid reading always wins when nothing is held", () => {
    expect(isBetterReading(reading(900), null)).toBe(true);
  });

  it("a reading without reported accuracy never replaces one with a value", () => {
    expect(isBetterReading(reading(null), reading(4000))).toBe(false);
  });

  it("a value beats an unreported accuracy (absence is not precision)", () => {
    expect(isBetterReading(reading(4000), reading(null))).toBe(true);
  });

  it("an equal reading does not replace the incumbent (strictly-better rule)", () => {
    expect(isBetterReading(reading(50, 16.8), reading(50, 16.7))).toBe(false);
  });    it("the accuracy target is the product's GPS-grade threshold", () => {
    // Tied to ACCURACY_GOOD_METERS so the acquisition target and the accuracy
    // policy cannot drift apart. Window and per-attempt timeout are bounded
    // (never unbounded), moderate enough for a demo UX.
    expect(GPS_TARGET_ACCURACY_METERS).toBe(ACCURACY_GOOD_METERS);
    expect(GPS_TARGET_ACCURACY_METERS).toBe(25);
    expect(GPS_ACQUISITION_WINDOW_MS).toBeLessThanOrEqual(30_000);
    expect(GPS_ACQUISITION_WINDOW_MS).toBeGreaterThan(10_000); // enough for a cold GPS start
    expect(GPS_WATCH_TIMEOUT_MS).toBeGreaterThan(5_000); // per-attempt retry, not instant
  });
});

describe("progressive acquisition with a fake geolocation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retains the best reading across progressively improving fixes", () => {
    const fake = makeFakeGeo();
    const progress: (number | null)[] = [];
    let settled: { kind: string; fix?: { accuracyMeters: number | null } } | null = null;
    acquireBestLocation(
      { onProgress: (r) => progress.push(r.accuracyMeters), onSettled: (o) => (settled = o) },
      fake.geo
    );
    fake.fix(500);
    fake.fix(200);
    fake.fix(50);
    fake.fix(20);
    expect(progress).toEqual([500, 200, 50, 20]);
    expect(settled).toMatchObject({ kind: "confirmed", fix: { accuracyMeters: 20 } });
    expect(fake.cleared).toHaveLength(1); // watcher stopped at target
  });

  it("a worse later reading never replaces a better one — tuple stays from ONE reading", () => {
    const fake = makeFakeGeo();
    let settled: { kind: string; fix?: { lat: number; lng: number; accuracyMeters: number | null } } | null = null;
    acquireBestLocation({ onProgress: () => {}, onSettled: (o) => (settled = o) }, fake.geo);
    fake.fix(30, 16.7, 74.24); // best
    fake.fix(80, 16.9, 74.99); // worse — must be ignored entirely
    vi.advanceTimersByTime(GPS_ACQUISITION_WINDOW_MS); // 30 m misses the 25 m target → settle at deadline
    expect(settled).toMatchObject({
      kind: "confirmed",
      fix: { lat: 16.7, lng: 74.24, accuracyMeters: 30 }, // lat/lng/accuracy from the SAME reading
    });
  });

  it("reaching the target accuracy stops the watcher immediately (deadline never fires)", () => {
    const fake = makeFakeGeo();
    const onSettled = vi.fn();
    acquireBestLocation({ onProgress: () => {}, onSettled }, fake.geo);
    fake.fix(GPS_TARGET_ACCURACY_METERS);
    vi.advanceTimersByTime(GPS_ACQUISITION_WINDOW_MS + 1000);
    expect(onSettled).toHaveBeenCalledTimes(1); // only the target settle
    expect(fake.cleared).toHaveLength(1);
  });

  it("the deadline expires with the best reading obtained — never blocks forever", () => {
    const fake = makeFakeGeo();
    let settled: { kind: string; fix?: { accuracyMeters: number | null }; code?: string } | null = null;
    acquireBestLocation({ onProgress: () => {}, onSettled: (o) => (settled = o) }, fake.geo);
    fake.fix(500);
    fake.fix(220);
    fake.fix(187); // never reaches 25 m
    vi.advanceTimersByTime(GPS_ACQUISITION_WINDOW_MS);
    expect(settled).toMatchObject({ kind: "confirmed", fix: { accuracyMeters: 187 } });
    expect(fake.cleared).toHaveLength(1);
  });

  it("the deadline without any reading settles as an honest TIMEOUT failure", () => {
    const fake = makeFakeGeo();
    let settled: { kind: string; code?: string } | null = null;
    acquireBestLocation({ onProgress: () => {}, onSettled: (o) => (settled = o) }, fake.geo);
    vi.advanceTimersByTime(GPS_ACQUISITION_WINDOW_MS);
    expect(settled).toMatchObject({ kind: "failed", code: "TIMEOUT" });
  });

  it("geolocation errors are handled: no reading → fail with a machine-readable code", () => {
    const fake = makeFakeGeo();
    let settled: { kind: string; code?: string } | null = null;
    acquireBestLocation({ onProgress: () => {}, onSettled: (o) => (settled = o) }, fake.geo);
    fake.fail(1); // PERMISSION_DENIED
    expect(settled).toMatchObject({ kind: "failed", code: "PERMISSION_DENIED" });
    expect(fake.cleared).toHaveLength(1);
  });

  it("transient errors with a best reading held do not discard the fix; permission loss ends the hunt", () => {
    const fake = makeFakeGeo();
    const onSettled = vi.fn();
    acquireBestLocation({ onProgress: () => {}, onSettled: onSettled }, fake.geo);
    fake.fix(60);
    fake.fail(3); // TIMEOUT — transient, hunt continues
    expect(onSettled).not.toHaveBeenCalled();
    fake.fail(2); // POSITION_UNAVAILABLE — transient too
    expect(onSettled).not.toHaveBeenCalled();
    fake.fix(45); // still improving after transient errors
    fake.fail(1); // PERMISSION_DENIED — ends the hunt early
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(fake.cleared).toHaveLength(1);
  });

  it("malformed readings (out-of-range/NaN coordinates) are ignored without crashing the hunt", () => {
    const fake = makeFakeGeo();
    const progress: (number | null)[] = [];
    let settled: { kind: string; fix?: { lat: number } } | null = null;
    acquireBestLocation({ onProgress: (r) => progress.push(r.accuracyMeters), onSettled: (o) => (settled = o) }, fake.geo);
    fake.fix(95, 95, 74.24); // latitude out of range
    fake.fix(95, 16.7, 200); // longitude out of range
    fake.fix(90, 16.7, 74.24); // valid
    expect(progress).toEqual([90]);
    vi.advanceTimersByTime(GPS_ACQUISITION_WINDOW_MS); // 90 m misses the target → settle at deadline
    expect(settled).toMatchObject({ kind: "confirmed", fix: { lat: 16.7 } });
  });

  it("clear() stops the hunt silently — watcher cleared, no settle callback, timer neutralized", () => {
    const fake = makeFakeGeo();
    const onSettled = vi.fn();
    const watcher = acquireBestLocation({ onProgress: () => {}, onSettled: onSettled }, fake.geo);
    fake.fix(120);
    watcher?.clear();
    watcher?.clear(); // idempotent
    vi.advanceTimersByTime(GPS_ACQUISITION_WINDOW_MS + 5000);
    fake.fix(10); // a straggler fix after clear must do nothing
    expect(onSettled).not.toHaveBeenCalled();
    expect(fake.cleared).toHaveLength(1);
  });

  it("a missing geolocation settles immediately as GEO_UNSUPPORTED", () => {
    const onSettled = vi.fn();
    const watcher = acquireBestLocation({ onProgress: () => {}, onSettled: onSettled }, undefined);
    expect(onSettled).toHaveBeenCalledWith({ kind: "failed", code: "GEO_UNSUPPORTED" });
    expect(watcher).toBeNull();
  });

  it("settling is exactly-once even when error and deadline race", () => {
    const fake = makeFakeGeo();
    const onSettled = vi.fn();
    acquireBestLocation({ onProgress: () => {}, onSettled: onSettled }, fake.geo);
    fake.fail(2); // no best reading → failed
    vi.advanceTimersByTime(GPS_ACQUISITION_WINDOW_MS + 1000);
    fake.fix(20);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});
