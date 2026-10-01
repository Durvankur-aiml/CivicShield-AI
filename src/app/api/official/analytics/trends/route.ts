import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { handleRouteError } from "@/lib/api";
import { trendAnalytics, parseWindow } from "@/lib/analytics";

export const runtime = "nodejs";

/** GET /api/official/analytics/trends?window=24h|7d|30d|90d|&from=&to= */
export async function GET(req: Request) {
  try {
    await requireRole(req, "OFFICIAL");
    const window = parseWindow(new URL(req.url).searchParams);
    return NextResponse.json(await trendAnalytics(window));
  } catch (err) {
    return handleRouteError(err);
  }
}
