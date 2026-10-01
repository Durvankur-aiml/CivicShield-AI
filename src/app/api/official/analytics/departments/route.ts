import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { handleRouteError } from "@/lib/api";
import { departmentAnalytics, parseWindow } from "@/lib/analytics";

export const runtime = "nodejs";

/** GET /api/official/analytics/departments?window=24h|7d|30d|90d|&from=&to= */
export async function GET(req: Request) {
  try {
    await requireRole(req, "OFFICIAL");
    const window = parseWindow(new URL(req.url).searchParams);
    return NextResponse.json(await departmentAnalytics(window));
  } catch (err) {
    return handleRouteError(err);
  }
}
