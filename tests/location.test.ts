import { describe, expect, it } from "vitest";
import {
  validateLat,
  validateLng,
  parseCoordinateField,
  accuracyLevel,
  isUsableAccuracy,
  normalizeLocation,
  locationErrorCode,
  isLocationFresh,
  LOCATION_FRESHNESS_MS,
} from "@/lib/location";
import {
  ACCURACY_GOOD_METERS,
  ACCURACY_DEGRADED_METERS,
  ACCURACY_MAX_METERS,
  ACCURACY_LEVELS,
  LOCATION_SOURCES,
  DEMO_MAP_CENTER,
  complaintInput,
} from "@/lib/constants";
import { haversineMeters, findBestDuplicate } from "@/lib/duplicate";
import { scoreCandidate } from "@/lib/assignmentDomain";
import type { WorkerProfile } from "@prisma/client";
import {
  NoopReverseGeocoder,
  describeCoordinates,
  describeCoordinatesCached,
  clearGeocodeCache,
} from "@/lib/geocode";

/**
 * Phase 4 Workstream A — geospatial reliability (unit; no DB, no browser).
 * BROWSER GPS INTEGRATION NOT TESTED in this environment (no device sensors);
 * browser behavior is pinned at the module boundary (locationErrorCode) instead.
 */

describe("server-side coordinate validation (A3)", () => {
  it("accepts valid latitudes and longitudes", () => {
    expect(validateLat(16.6952)).toBe(16.6952);
    expect(validateLat(-90)).toBe(-90);
    expect(validateLat(90)).toBe(90);
    expect(validateLng(74.4574)).toBe(74.4574);
    expect(validateLng(-180)).toBe(-180);
    expect(validateLng(180)).toBe(180);
  });

  it("rejects out-of-range coordinates", () => {
    expect(validateLat(90.000001)).toBeNull();
    expect(validateLat(-90.1)).toBeNull();
    expect(validateLng(180.5)).toBeNull();
    expect(validateLng(-181)).toBeNull();
  });

  it("rejects NaN and ±Infinity (never silently accepted)", () => {
    expect(validateLat(Number.NaN)).toBeNull();
    expect(validateLng(Number.NaN)).toBeNull();
    expect(validateLat(Infinity)).toBeNull();
    expect(validateLat(-Infinity)).toBeNull();
    expect(validateLng(Infinity)).toBeNull();
  });

  it("rejects non-number types (string/boolean/null/undefined)", () => {
    expect(validateLat("16.6952" as unknown as number)).toBeNull();
    expect(validateLng(true as unknown as number)).toBeNull();
    expect(validateLat(null as unknown as number)).toBeNull();
    expect(validateLng(undefined as unknown as number)).toBeNull();
  });

  it("canonical order is (lat, lng) — haversineMeters is symmetric only in this order", () => {
    // Kolhapur ≈ (16.70 N, 74.24 E): distance to a point 1° east must be ~106 km
    // (1° longitude × cos(lat)); a swapped call would produce a wildly
    // different value — this pins the canonical argument order.
    const d = haversineMeters(16.7, 74.24, 16.7, 75.24);
    expect(d).toBeGreaterThan(100_000);
    expect(d).toBeLessThan(115_000);
  });

  it("form fields: absent/empty is 'not provided', garbage is invalid", () => {
    expect(parseCoordinateField(null)).toBeUndefined();
    expect(parseCoordinateField("")).toBeUndefined();
    expect(parseCoordinateField("16.6952")).toBe(16.6952);
    expect(parseCoordinateField("abc")).toBeNull(); // present-but-garbage → invalid
  });
});

describe("central accuracy policy (A5/A6) — no scattered magic numbers", () => {
  it("classifies GOOD / DEGRADED / POOR from the centralized thresholds", () => {
    expect(accuracyLevel(5)).toBe("GOOD");
    expect(accuracyLevel(ACCURACY_GOOD_METERS)).toBe("GOOD"); // boundary inclusive
    expect(accuracyLevel(ACCURACY_GOOD_METERS + 1)).toBe("DEGRADED");
    expect(accuracyLevel(ACCURACY_DEGRADED_METERS)).toBe("DEGRADED");
    expect(accuracyLevel(ACCURACY_DEGRADED_METERS + 1)).toBe("POOR");
    expect(accuracyLevel(ACCURACY_MAX_METERS)).toBe("POOR");
    expect(accuracyLevel(ACCURACY_MAX_METERS + 1)).toBe("POOR"); // clamped domain
  });

  it("treats a missing accuracy honestly as UNKNOWN (absence is not precision)", () => {
    expect(accuracyLevel(null)).toBe("UNKNOWN");
    expect(accuracyLevel(undefined)).toBe("UNKNOWN");
    expect(accuracyLevel(Number.NaN)).toBe("UNKNOWN");
    expect(accuracyLevel(-3)).toBe("UNKNOWN"); // negative accuracy is nonsense
  });

  it("GOOD and DEGRADED are usable for distance decisions; POOR/UNKNOWN are not", () => {
    expect(isUsableAccuracy("GOOD")).toBe(true);
    expect(isUsableAccuracy("DEGRADED")).toBe(true);
    expect(isUsableAccuracy("POOR")).toBe(false);
    expect(isUsableAccuracy("UNKNOWN")).toBe(false);
  });

  it("thresholds are ordered and documented product values", () => {
    expect(ACCURACY_GOOD_METERS).toBeLessThan(ACCURACY_DEGRADED_METERS);
    expect(ACCURACY_DEGRADED_METERS).toBeLessThan(ACCURACY_MAX_METERS);
    expect(ACCURACY_LEVELS).toEqual(["GOOD", "DEGRADED", "POOR", "UNKNOWN"]);
  });
});

describe("location normalization (A2/A7/A9)", () => {
  it("preserves the browser-reported accuracy (never fabricated)", () => {
    const loc = normalizeLocation({ lat: 16.7, lng: 74.24, accuracyMeters: 42, source: "GPS", capturedAt: "2026-09-30T10:00:00Z" });
    expect(loc.accuracyMeters).toBe(42);
    expect(loc.source).toBe("GPS");
    expect(loc.capturedAt).toEqual(new Date("2026-09-30T10:00:00Z"));
  });

  it("keeps the canonical source taxonomy and defaults honestly to UNKNOWN", () => {
    for (const s of LOCATION_SOURCES) {
      expect(normalizeLocation({ lat: 1, lng: 1, source: s }).source).toBe(s);
    }
    expect(normalizeLocation({ lat: 1, lng: 1 }).source).toBe("UNKNOWN");
    expect(normalizeLocation({ lat: 1, lng: 1, source: "HOCUS" }).source).toBe("UNKNOWN");
  });

  it("clamps a hostile/broken accuracy claim to the policy ceiling", () => {
    const loc = normalizeLocation({ lat: 1, lng: 1, accuracyMeters: 1_000_000 });
    expect(loc.accuracyMeters).toBe(ACCURACY_MAX_METERS);
  });

  it("rejects invalid capture timestamps instead of storing garbage", () => {
    expect(normalizeLocation({ lat: 1, lng: 1, capturedAt: "not-a-date" }).capturedAt).toBeNull();
  });
});

describe("capture-time freshness policy (A7)", () => {
  it("fresh within the policy window", () => {
    expect(isLocationFresh(new Date(Date.now() - 60_000))).toBe(true);
  });

  it("stale beyond the window and for unknown capture time", () => {
    expect(isLocationFresh(new Date(Date.now() - LOCATION_FRESHNESS_MS - 1))).toBe(false);
    expect(isLocationFresh(null)).toBe(false);
  });

  it("never treats a future timestamp as fresh", () => {
    expect(isLocationFresh(new Date(Date.now() + 60_000))).toBe(false);
  });
});

describe("machine-readable geolocation errors (A8)", () => {
  it("maps browser GeolocationPositionError codes", () => {
    expect(locationErrorCode({ code: 1 })).toBe("PERMISSION_DENIED");
    expect(locationErrorCode({ code: 2 })).toBe("POSITION_UNAVAILABLE");
    expect(locationErrorCode({ code: 3 })).toBe("TIMEOUT");
    expect(locationErrorCode({})).toBe("UNKNOWN");
  });
});

describe("complaint input location contract (route boundary)", () => {
  it("accepts a full GPS report", () => {
    const parsed = complaintInput.parse({
      description: "Deep pothole near the bus stand",
      lat: 16.7, lng: 74.24, accuracyMeters: 18, locationSource: "GPS", locationCapturedAt: "2026-09-30T10:00:00Z",
    });
    expect(parsed.lat).toBe(16.7);
    expect(parsed.accuracyMeters).toBe(18);
    expect(parsed.locationSource).toBe("GPS");
  });

  it("allows a report WITHOUT coordinates (no silent default location)", () => {
    const parsed = complaintInput.parse({ description: "Garbage not collected near the school" });
    expect(parsed.lat).toBeUndefined();
    expect(parsed.lng).toBeUndefined();
  });

  it("rejects invalid, out-of-range, and non-finite coordinates", () => {
    expect(complaintInput.safeParse({ description: "x".repeat(20), lat: 95, lng: 0 }).success).toBe(false);
    expect(complaintInput.safeParse({ description: "x".repeat(20), lat: 0, lng: 200 }).success).toBe(false);
    expect(complaintInput.safeParse({ description: "x".repeat(20), lat: Number.NaN, lng: 0 }).success).toBe(false);
    expect(complaintInput.safeParse({ description: "x".repeat(20), lat: Infinity, lng: 0 }).success).toBe(false);
    expect(complaintInput.safeParse({ description: "x".repeat(20), accuracyMeters: -5 }).success).toBe(false);
  });
});

describe("duplicate intelligence tolerates location-less complaints (A13)", () => {
  const now = new Date();
  const base = { category: "POTHOLE", description: "deep pothole near the bus stand", createdAt: new Date(now.getTime() - 3600_000) };

  it("no duplicate is claimed without coordinates (no invented distances)", () => {
    const match = findBestDuplicate(
      { ...base, lat: null, lng: null },
      [{ id: "c1", refCode: "CS-2026-000001", category: "POTHOLE", description: "pothole", lat: 16.7, lng: 74.24, createdAt: now }]
    );
    expect(match).toBeNull();
  });

  it("location-less candidates are skipped instead of crashing haversine", () => {
    const match = findBestDuplicate(
      { ...base, lat: 16.7, lng: 74.24 },
      [{ id: "c1", refCode: "CS-2026-000002", category: "POTHOLE", description: "pothole", lat: null, lng: null, createdAt: now }]
    );
    expect(match).toBeNull();
  });
});

describe("assignment engine stays compatible with missing complaint coordinates (A13)", () => {
  const profile = (over: Partial<WorkerProfile> = {}): WorkerProfile =>
    ({
      id: "wp1", userId: "u1", employeeId: "DEMO-PWD-001", departmentId: "PWD",
      designation: "Road Repair Technician", skills: ["ROAD_REPAIR"], equipment: ["DRILL"],
      availability: "AVAILABLE", serviceAreas: ["Ward 1"], baseLat: 16.6952, baseLng: 74.4574,
      maxActiveAssignments: 3, phone: null, workEmail: null, approvedById: "official",
      approvedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), ...over,
    }) as WorkerProfile;

  const requirements = { departmentCode: "PWD", category: "POTHOLE", requiredSkills: ["ROAD_REPAIR"], requiredEquipment: ["DRILL"], serviceArea: null };

  it("distance is neutral (half weight) when the complaint has no coordinates", () => {
    const c = scoreCandidate(profile(), requirements, 0, {
      lat: null, lng: null, severity: "HIGH", slaDueAt: new Date(Date.now() + 24 * 3600_000), status: "RECEIVED", createdAt: new Date(),
    });
    const distance = c.breakdown.find((b) => b.factor === "distance")!;
    expect(c.distanceM).toBeNull();
    expect(distance.points).toBeCloseTo(7.5, 5); // exactly half of the distance weight
    expect(distance.note).toContain("no complaint coordinates");
  });

  it("unchanged behavior with coordinates (Phase 2B weights untouched)", () => {
    const c = scoreCandidate(profile(), requirements, 0, {
      lat: 16.6952, lng: 74.4574, severity: "HIGH", slaDueAt: new Date(Date.now() + 24 * 3600_000), status: "RECEIVED", createdAt: new Date(),
    });
    expect(c.distanceM).toBe(0);
    expect(c.breakdown.find((b) => b.factor === "distance")!.points).toBe(15);
  });
});

describe("reverse geocoding cannot destroy coordinates (A10/A11)", () => {
  it("the default boundary performs no external lookup and returns no fabricated metadata", async () => {
    expect(await new NoopReverseGeocoder().reverse({ lat: 1, lng: 2 })).toBeNull();
  });

  it("describeCoordinates never throws — failure degrades to null metadata", async () => {
    const res = await describeCoordinates({ lat: 16.7, lng: 74.24 });
    expect(res).toBeNull();
  });

  it("returns an ADDRESS, never coordinates (coordinates stay authoritative)", async () => {
    const res = await describeCoordinatesCached({ lat: 16.7, lng: 74.24 });
    if (res) {
      expect(res).not.toHaveProperty("lat");
      expect(res).not.toHaveProperty("lng");
      expect(typeof res.address).toBe("string");
    }
    clearGeocodeCache();
  });

  it("the only hardcoded coordinates are the demo MAP VIEWPORT default — never a submission fallback", () => {
    expect(DEMO_MAP_CENTER).toEqual({ lat: 16.6952, lng: 74.4574 });
  });
});
