import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { handleRouteError } from "@/lib/api";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

/** GET /api/activity — most recent Agent Activity entries (dashboard panel). */
export async function GET(req: Request) {
  try {
    await requireRole(req, "OFFICIAL");
    const url = new URL(req.url);
    const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 40));
    const complaintId = url.searchParams.get("complaintId") ?? undefined;

    const activities = await prisma.agentActivity.findMany({
      where: complaintId ? { complaintId } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { complaint: { select: { refCode: true } } },
    });
    return NextResponse.json({ activities });
  } catch (err) {
    return handleRouteError(err);
  }
}
