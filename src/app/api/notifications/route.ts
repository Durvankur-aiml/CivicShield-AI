import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, ApiError } from "@/lib/auth";
import { handleRouteError, readJson } from "@/lib/api";
import { listMyNotifications, markNotificationRead, markAllNotificationsRead } from "@/lib/notificationDomain";

export const runtime = "nodejs";

const readSchema = z.object({
  id: z.string().min(1).max(60).optional(),
  all: z.boolean().optional(),
});

/**
 * GET /api/notifications — the CURRENT user's notifications (server session
 * identity is authoritative; no client-controlled recipient) with unread
 * count. `?unread=true` lists only unread.
 * POST /api/notifications — mark one ({ id }) or all ({ all: true }) of the
 * CURRENT user's notifications read. Idempotent.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const unreadOnly = url.searchParams.get("unread") === "true";
    const limitParam = Number(url.searchParams.get("limit") ?? "50");
    const result = await listMyNotifications(user, {
      unreadOnly,
      limit: Number.isFinite(limitParam) ? limitParam : 50,
    });
    return NextResponse.json(result);
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = readSchema.parse(await readJson(req));
    if (body.all) return NextResponse.json(await markAllNotificationsRead(user));
    if (body.id) return NextResponse.json(await markNotificationRead(user, body.id));
    throw new ApiError(422, "Provide a notification id or all:true");
  } catch (err) {
    return handleRouteError(err);
  }
}
