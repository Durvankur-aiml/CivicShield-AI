import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { handleRouteError } from "@/lib/api";
import { hotspotAnalytics, parseWindow } from "@/lib/analytics";

export const runtime = "nodejs";

/**
 * GET /api/official/analytics/hotspots?window=&minCount=
 * Deterministic grid aggregation over authoritative Phase 4 coordinates.
 * minCount is a validated positive integer (default 3, documented).
 */
export async function GET(req: Request) {
  try {
    await requireRole(req, "OFFICIAL");
    const params = new URL(req.url).searchParams;
    const window = parseWindow(params);
    const minCount = positiveIntParam(params.get("minCount"));
    if (minCount === false) {
      return NextResponse.json({ error: "minCount must be a positive integer" }, { status: 400 });
    }
    return NextResponse.json(await hotspotAnalytics(window, { minCount }));
  } catch (err) {
    return handleRouteError(err);
  }
}

function positiveIntParam(raw: string | null): number | undefined | false {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : false;
}
