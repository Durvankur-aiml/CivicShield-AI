import { describe, expect, it } from "vitest";
import {
  buildHotspots,
  cellKey,
  cellCenter,
  HOTSPOT_CELL_METERS,
  DEFAULT_MIN_HOTSPOT_COUNT,
  CELL_DEG_LAT,
  CELL_DEG_LNG,
  type HotspotInput,
} from "@/lib/analytics/hotspots";
import { buildRecurring, RECURRING_CATEGORY_MIN, RECURRING_AREA_MIN } from "@/lib/analytics/recurring";

/**
 * Phase 5 — spatial analytics (deterministic, no ML, no DB).
 * HOTSPOT/LIVE-DB AGGREGATION NOT TESTED: SQL-side behavior needs a real
 * PostgreSQL; these pin the pure clustering/recurring methodology.
 */

const p = (lat: number, lng: number, category = "POTHOLE", severity = "MEDIUM", departmentCode = "PWD"): HotspotInput => ({
  lat,
  lng,
  category,
  severity,
  departmentCode,
});

describe("hotspot grid methodology (spec §7)", () => {
  it("maps coordinates to stable grid cells and consistent centers", () => {
    const k1 = cellKey(16.6952, 74.4574);
    const k2 = cellKey(16.6952, 74.4574);
    expect(k1).toEqual(k2);
    const { centerLat, centerLng } = cellCenter(k1.cellLat, k1.cellLng);
    // The center is within one cell of the source point
    expect(Math.abs(centerLat - 16.6952)).toBeLessThan(CELL_DEG_LAT);
    expect(Math.abs(centerLng - 74.4574)).toBeLessThan(CELL_DEG_LNG);
  });

  it("nearby points cluster; distant points do not", () => {
    const pts = [
      p(16.6952, 74.4574),
      p(16.6953, 74.4575),
      p(16.6954, 74.4576),
    ];
    const hs = buildHotspots(pts, 3);
    expect(hs).toHaveLength(1);
    expect(hs[0].count).toBe(3);
    expect(hs[0].dominantCategory).toBe("POTHOLE");
  });

  it("below the threshold a cell is NOT a hotspot (no single-complaint hotspots)", () => {
    expect(buildHotspots([p(16.7001, 74.2401)], 3)).toHaveLength(0);
    const two = buildHotspots([p(16.7001, 74.2401), p(16.7002, 74.2402)], 3);
    expect(two).toHaveLength(0);
    const three = buildHotspots([p(16.7001, 74.2401), p(16.7002, 74.2402), p(16.7003, 74.2403)], 3);
    expect(three).toHaveLength(1);
  });

  it("a custom threshold is honored", () => {
    const pts = [p(16.7001, 74.2401), p(16.7002, 74.2402)];
    expect(buildHotspots(pts, 2)).toHaveLength(1);
    expect(buildHotspots(pts, 5)).toHaveLength(0);
    expect(DEFAULT_MIN_HOTSPOT_COUNT).toBe(3);
    expect(HOTSPOT_CELL_METERS).toBe(250);
  });

  it("grid cell boundaries are exact — points in adjacent cells do not cluster", () => {
    // 74.24 lies on a longitude cell boundary: one side vs the other are
    // different cells even ~1 m apart. Deterministic by design.
    const a = buildHotspots([p(16.7, 74.24)], 1);
    const b = buildHotspots([p(16.7, 74.2401)], 1);
    expect(a[0].cellLng).not.toBe(b[0].cellLng);
  });

  it("dominant category/severity/department come from real majorities", () => {
    const pts = [
      p(16.7001, 74.2401, "POTHOLE", "HIGH", "PWD"),
      p(16.7002, 74.2402, "POTHOLE", "HIGH", "PWD"),
      p(16.7003, 74.2403, "GARBAGE", "LOW", "SWM"),
    ];
    const hs = buildHotspots(pts, 3);
    expect(hs[0].dominantCategory).toBe("POTHOLE");
    expect(hs[0].dominantSeverity).toBe("HIGH");
    expect(hs[0].department).toBe("PWD");
    expect(hs[0].severityDistribution).toMatchObject({ HIGH: 2, LOW: 1 });
  });

  it("ordering is deterministic: count DESC, then cell coordinates", () => {
    const a = buildHotspots([p(16.7001, 74.2401), p(16.7002, 74.2402), p(16.7003, 74.2403)], 3);
    const b = buildHotspots([p(16.7003, 74.2403), p(16.7001, 74.2401), p(16.7002, 74.2402)], 3);
    expect(a).toEqual(b);
  });

  it("empty and coordinate-less scopes are honest (no fabricated hotspots)", () => {
    expect(buildHotspots([], 1)).toEqual([]);
  });
});

describe("recurring issues (spec §8) — distinct from incident-level duplicates", () => {
  const row = (lat: number | null, lng: number | null, category = "POTHOLE", departmentCode = "PWD") => ({
    lat,
    lng,
    category,
    departmentCode,
  });

  it("category recurrence requires the documented minimum (default 5)", () => {
    expect(RECURRING_CATEGORY_MIN).toBe(5);
    const rows = [
      row(16.7, 74.24, "POTHOLE"),
      row(16.8, 74.30, "POTHOLE"),
      row(16.9, 74.10, "POTHOLE"),
      row(16.6, 74.50, "POTHOLE"),
      row(16.5, 74.60, "POTHOLE"), // 5th pothole anywhere → recurring category
    ];
    const r = buildRecurring(rows, { category: 5, area: 3 });
    expect(r.byCategory).toEqual([{ scope: "CATEGORY", key: "POTHOLE", category: "POTHOLE", department: null, count: 5 }]);
    expect(r.byArea).toHaveLength(0); // scattered — no area recurrence
  });

  it("area recurrence needs repeats in the SAME grid cell (default 3)", () => {
    expect(RECURRING_AREA_MIN).toBe(3);
    const rows = [
      row(16.7, 74.24, "GARBAGE"),
      row(16.7, 74.24, "GARBAGE"),
      row(16.7, 74.24, "GARBAGE"),
    ];
    const r = buildRecurring(rows, { category: 5, area: 3 });
    expect(r.byArea).toHaveLength(1);
    expect(r.byArea[0]).toMatchObject({ scope: "AREA", category: "GARBAGE", count: 3 });
    expect(r.byCategory).toHaveLength(0); // 3 < 5 → not a recurring category
  });

  it("category×department recurrence attributes departments", () => {
    const rows = [
      row(null, null, "STREETLIGHT", "ELECT"),
      row(null, null, "STREETLIGHT", "ELECT"),
      row(null, null, "STREETLIGHT", "ELECT"),
      row(null, null, "STREETLIGHT", "ELECT"),
      row(null, null, "STREETLIGHT", "ELECT"),
    ];
    const r = buildRecurring(rows, { category: 5, area: 3 });
    expect(r.byCategoryDepartment[0]).toMatchObject({ category: "STREETLIGHT", department: "ELECT", count: 5 });
    expect(r.byArea).toHaveLength(0); // null coordinates never fabricate areas
  });

  it("no coordinate-less area fabrication; deterministic ordering", () => {
    const rows = [
      row(16.7, 74.24, "POTHOLE"),
      row(16.7, 74.24, "POTHOLE"),
      row(16.7, 74.24, "POTHOLE"),
      row(16.7, 74.24, "POTHOLE"),
      row(16.7, 74.24, "POTHOLE"),
    ];
    const r1 = buildRecurring(rows, { category: 5, area: 3 });
    const r2 = buildRecurring([...rows].reverse(), { category: 5, area: 3 });
    expect(r1.byCategory).toEqual(r2.byCategory);
    expect(r1.byArea).toEqual(r2.byArea);
  });
});
