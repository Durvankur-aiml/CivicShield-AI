import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { handleRouteError } from "@/lib/api";
import { workerAnalytics, parseWindow } from "@/lib/analytics";

export const runtime = "nodejs";

/**
 * GET /api/official/analytics/workers?window=24h|7d|30d|90d|&from=&to=
 * Raw operational measurements per worker — no scores, no rankings, minimal
 * identity (employeeId + display name only).
 */
export async function GET(req: Request) {
  try {
    await requireRole(req, "OFFICIAL");
    const window = parseWindow(new URL(req.url).searchParams);
    return NextResponse.json(await workerAnalytics(window));
  } catch (err) {
    return handleRouteError(err);
  }
}
