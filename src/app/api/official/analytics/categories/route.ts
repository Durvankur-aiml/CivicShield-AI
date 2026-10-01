import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { handleRouteError } from "@/lib/api";
import { recurringAnalytics, parseWindow } from "@/lib/analytics";

export const runtime = "nodejs";

/**
 * GET /api/official/analytics/categories?window=&minCategory=&minArea=
 * Recurring-issue analytics by category, category×department, and grid area.
 * Thresholds are validated positive integers (documented defaults otherwise).
 */
export async function GET(req: Request) {
  try {
    await requireRole(req, "OFFICIAL");
    const params = new URL(req.url).searchParams;
    const window = parseWindow(params);
    const minCategory = positiveIntParam(params.get("minCategory"));
    const minArea = positiveIntParam(params.get("minArea"));
    if (minCategory === false || minArea === false) {
      return NextResponse.json({ error: "minCategory/minArea must be positive integers" }, { status: 400 });
    }
    return NextResponse.json(await recurringAnalytics(window, { minCategory, minArea }));
  } catch (err) {
    return handleRouteError(err);
  }
}

function positiveIntParam(raw: string | null): number | undefined | false {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : false;
}
