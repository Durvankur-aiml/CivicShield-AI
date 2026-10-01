import { prisma } from "../db";
import type { TimeWindow } from "./timeWindow";
import { envelope, type Envelope } from "./metricStatus";
import { CELL_DEG_LAT, CELL_DEG_LNG } from "./hotspots";

/**
 * Recurring-issue analytics (Phase 5, spec §8) — deterministic aggregation
 * over historical records answering: "does this TYPE of issue repeatedly
 * occur over time or in an area?"
 *
 * DISTINCT FROM DUPLICATE DETECTION (Phase 1, src/lib/duplicate.ts): that
 * answers "are these reports probably the SAME incident?" at submission time
 * with proximity + recency + text similarity. Recurrence here is a
 * retrospective count over settled history — the two concepts are never
 * merged and one never replaces the other.
 *
 * Methodology (documented in docs/CIVIC_INTELLIGENCE.md):
 * - Category recurrence: group complaints by category (+ department) within
 *   the window. Recurring = count >= RECURRING_CATEGORY_MIN.
 * - Area recurrence: the same Phase 5 grid keys as hotspots; a cell/category
 *   pair recurring = count >= RECURRING_AREA_MIN.
 */

export const RECURRING_CATEGORY_MIN = 5;
export const RECURRING_AREA_MIN = 3;

export type RecurringIssue = {
  scope: "CATEGORY" | "CATEGORY_DEPARTMENT" | "AREA";
  key: string;
  category: string;
  department: string | null;
  cellLat?: number;
  cellLng?: number;
  count: number;
};

export type RecurringAnalytics = {
  envelope: Envelope;
  minCategoryCount: number;
  minAreaCount: number;
  byCategory: RecurringIssue[];
  byCategoryDepartment: RecurringIssue[];
  byArea: RecurringIssue[];
  note: string;
};

export function areaKey(lat: number, lng: number): { cellLat: number; cellLng: number } {
  return {
    cellLat: Math.floor((lat + 90) / CELL_DEG_LAT),
    cellLng: Math.floor((lng + 180) / CELL_DEG_LNG),
  };
}

/** Pure aggregation — exported for deterministic tests. */
export function buildRecurring(
  rows: Array<{ lat: number | null; lng: number | null; category: string; departmentCode: string | null }>,
  mins: { category: number; area: number }
): Pick<RecurringAnalytics, "byCategory" | "byCategoryDepartment" | "byArea"> {
  const cat = new Map<string, number>();
  const catDept = new Map<string, { count: number; category: string; department: string | null }>();
  const area = new Map<string, { count: number; category: string; cellLat: number; cellLng: number }>();

  for (const r of rows) {
    cat.set(r.category, (cat.get(r.category) ?? 0) + 1);
    const dk = `${r.category}|${r.departmentCode ?? "UNASSIGNED"}`;
    const cd = catDept.get(dk) ?? { count: 0, category: r.category, department: r.departmentCode };
    cd.count += 1;
    catDept.set(dk, cd);
    if (r.lat != null && r.lng != null) {
      const { cellLat, cellLng } = areaKey(r.lat, r.lng);
      const ak = `${cellLat}:${cellLng}|${r.category}`;
      const a = area.get(ak) ?? { count: 0, category: r.category, cellLat, cellLng };
      a.count += 1;
      area.set(ak, a);
    }
  }

  const byCategory: RecurringIssue[] = [...cat.entries()]
    .filter(([, count]) => count >= mins.category)
    .map(([category, count]) => ({ scope: "CATEGORY" as const, key: category, category, department: null, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

  const byCategoryDepartment: RecurringIssue[] = [...catDept.entries()]
    .filter(([, v]) => v.count >= mins.category)
    .map(([key, v]) => ({
      scope: "CATEGORY_DEPARTMENT" as const,
      key,
      category: v.category,
      department: v.department,
      count: v.count,
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  const byArea: RecurringIssue[] = [...area.entries()]
    .filter(([, v]) => v.count >= mins.area)
    .map(([key, v]) => ({
      scope: "AREA" as const,
      key,
      category: v.category,
      department: null,
      cellLat: v.cellLat,
      cellLng: v.cellLng,
      count: v.count,
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  return { byCategory, byCategoryDepartment, byArea };
}

export async function recurringAnalytics(
  window: TimeWindow,
  opts: { minCategory?: number; minArea?: number } = {}
): Promise<RecurringAnalytics> {
  const minCategory = Math.max(1, opts.minCategory ?? RECURRING_CATEGORY_MIN);
  const minArea = Math.max(1, opts.minArea ?? RECURRING_AREA_MIN);

  const rows = await prisma.complaint.findMany({
    where: { createdAt: { gte: window.from, lt: window.to } },
    select: { lat: true, lng: true, category: true, department: { select: { code: true } } },
    orderBy: { createdAt: "desc" },
    take: 5000, // bounded sample (documented)
  });

  const parts = buildRecurring(
    rows.map((r) => ({
      lat: r.lat,
      lng: r.lng,
      category: r.category,
      departmentCode: r.department?.code ?? null,
    })),
    { category: minCategory, area: minArea }
  );

  const total = parts.byCategory.length + parts.byCategoryDepartment.length + parts.byArea.length;
  return {
    envelope: envelope(window),
    minCategoryCount: minCategory,
    minAreaCount: minArea,
    ...parts,
    note:
      total === 0
        ? rows.length === 0
          ? "No complaints in the selected window."
          : `No pattern reached the recurrence thresholds (category ≥ ${minCategory}, area ≥ ${minArea}).`
        : `${total} recurring pattern(s) met the documented thresholds.`,
  };
}
