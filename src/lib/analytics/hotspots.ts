import { prisma } from "../db";
import type { TimeWindow } from "./timeWindow";
import { envelope, metricNoData, type Envelope } from "./metricStatus";

/**
 * Hotspot analytics (Phase 5, spec §7) — DETERMINISTIC descriptive spatial
 * aggregation over the Phase 4 authoritative coordinates. Not ML, not
 * prediction: a fixed 250 m grid, each cell counted independently.
 *
 * Methodology:
 * - Only complaints with BOTH lat and lng present participate (never address
 *   text — coordinates are authoritative per Phase 4).
 * - Each complaint maps to exactly one grid cell: floor((lat+90)/size) and
 *   floor((lng+180)/size). Cell centers are the exact cell midpoints.
 * - A cell is a hotspot only if count >= MIN_HOTSPOT_COUNT (default 3) —
 *   documented product threshold; a single complaint is never a hotspot.
 * - The bounding box of participating complaints defines which cells can
 *   exist; empty cells are never fabricated.
 */

export const HOTSPOT_CELL_METERS = 250;
export const DEFAULT_MIN_HOTSPOT_COUNT = 3;

/** Degrees per cell, derived from meters at the equator (approximation is
 * fine for grid KEYS; centers are computed consistently in the same space). */
const M_PER_DEG_LAT = 111_320;
export const CELL_DEG_LAT = HOTSPOT_CELL_METERS / M_PER_DEG_LAT;
export const CELL_DEG_LNG = CELL_DEG_LAT; // uniform grid; longitudes compress toward poles (documented)

export type Hotspot = {
  cellLat: number;
  cellLng: number;
  centerLat: number;
  centerLng: number;
  count: number;
  dominantCategory: string;
  dominantSeverity: string;
  department: string | null;
  severityDistribution: Record<string, number>;
};

export type HotspotAnalytics = {
  envelope: Envelope;
  cellMeters: number;
  minCount: number;
  complaintsInScope: number;
  complaintsPlotted: number;
  hotspots: Hotspot[];
  note: string;
};

export type HotspotInput = {
  lat: number;
  lng: number;
  category: string;
  severity: string;
  departmentCode?: string | null;
};

export function cellKey(lat: number, lng: number): { cellLat: number; cellLng: number } {
  return {
    cellLat: Math.floor((lat + 90) / CELL_DEG_LAT),
    cellLng: Math.floor((lng + 180) / CELL_DEG_LNG),
  };
}

export function cellCenter(cellLat: number, cellLng: number): { centerLat: number; centerLng: number } {
  return {
    centerLat: (cellLat + 0.5) * CELL_DEG_LAT - 90,
    centerLng: (cellLng + 0.5) * CELL_DEG_LNG - 180,
  };
}

/** Pure aggregation — exported for deterministic tests. */
export function buildHotspots(
  inputs: HotspotInput[],
  minCount: number = DEFAULT_MIN_HOTSPOT_COUNT
): Hotspot[] {
  type Cell = {
    count: number;
    categories: Map<string, number>;
    severities: Map<string, number>;
    departments: Map<string, number>;
  };
  const cells = new Map<string, Cell>();

  for (const p of inputs) {
    const { cellLat, cellLng } = cellKey(p.lat, p.lng);
    const key = `${cellLat}:${cellLng}`;
    if (!cells.has(key)) cells.set(key, { count: 0, categories: new Map(), severities: new Map(), departments: new Map() });
    const cell = cells.get(key)!;
    cell.count += 1;
    cell.categories.set(p.category, (cell.categories.get(p.category) ?? 0) + 1);
    cell.severities.set(p.severity, (cell.severities.get(p.severity) ?? 0) + 1);
    if (p.departmentCode) cell.departments.set(p.departmentCode, (cell.departments.get(p.departmentCode) ?? 0) + 1);
  }

  const top = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];

  const hotspots: Hotspot[] = [];
  for (const [key, cell] of cells) {
    if (cell.count < minCount) continue;
    const [cellLat, cellLng] = key.split(":").map(Number);
    const { centerLat, centerLng } = cellCenter(cellLat, cellLng);
    const severityDistribution: Record<string, number> = {};
    for (const [sev, n] of [...cell.severities.entries()].sort((a, b) => b[1] - a[1])) {
      severityDistribution[sev] = n;
    }
    hotspots.push({
      cellLat,
      cellLng,
      centerLat,
      centerLng,
      count: cell.count,
      dominantCategory: top(cell.categories) ?? "UNKNOWN",
      dominantSeverity: top(cell.severities) ?? "UNKNOWN",
      department: top(cell.departments) ?? null,
      severityDistribution,
    });
  }
  return hotspots.sort((a, b) => b.count - a.count || a.cellLat - b.cellLat || a.cellLng - b.cellLng);
}

export async function hotspotAnalytics(
  window: TimeWindow,
  opts: { minCount?: number } = {}
): Promise<HotspotAnalytics> {
  const minCount = Math.max(1, opts.minCount ?? DEFAULT_MIN_HOTSPOT_COUNT);
  // Bounded, indexed-window fetch of only the columns aggregation needs.
  const rows = await prisma.complaint.findMany({
    where: { createdAt: { gte: window.from, lt: window.to }, lat: { not: null }, lng: { not: null } },
    select: { lat: true, lng: true, category: true, severity: true, department: { select: { code: true } } },
    orderBy: { createdAt: "desc" },
    take: 5000, // bounded sample for spatial aggregation (documented)
  });

  const inputs: HotspotInput[] = rows
    .filter((r) => r.lat != null && r.lng != null)
    .map((r) => ({
      lat: r.lat as number,
      lng: r.lng as number,
      category: r.category,
      severity: r.severity,
      departmentCode: r.department?.code ?? null,
    }));

  const hotspots = buildHotspots(inputs, minCount);
  const totalInWindow = hotspots.length > 0 || inputs.length > 0 ? inputs.length : 0;

  return {
    envelope: envelope(window),
    cellMeters: HOTSPOT_CELL_METERS,
    minCount,
    complaintsInScope: totalInWindow,
    complaintsPlotted: inputs.length,
    hotspots,
    note:
      hotspots.length === 0
        ? metricNoData().status === "NO_DATA"
          ? inputs.length === 0
            ? "No geolocated complaints in the selected window."
            : `No area reached the minimum of ${minCount} complaints in the selected window.`
          : ""
        : `${hotspots.length} area(s) reached at least ${minCount} complaint(s) within ${HOTSPOT_CELL_METERS} m grid cells.`,
  };
}
