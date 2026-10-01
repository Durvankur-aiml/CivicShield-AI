import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { handleRouteError, readJson } from "@/lib/api";
import { overrideAssignment } from "@/lib/assignmentDomain";

export const runtime = "nodejs";

const bodySchema = z.object({
  workerId: z.string().min(5).max(60),
  reason: z.string().trim().min(3).max(500),
});

/**
 * POST /api/complaints/:id/override — OFFICIAL replaces the engine's pick
 * (or manually dispatches a NO_ELIGIBLE_WORKER complaint). The previous
 * assignment row is closed (never overwritten), the new row carries
 * mode=OVERRIDE, the required reason, and the reassignment chain link.
 * Fully audited; the new worker is notified.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const official = await requireRole(req, "OFFICIAL");
    const { id } = await params;
    const { workerId, reason } = bodySchema.parse(await readJson(req));
    const result = await overrideAssignment(official, id, workerId, reason);
    return NextResponse.json(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
