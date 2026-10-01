import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { handleRouteError } from "@/lib/api";
import { getMyAssignment } from "@/lib/assignmentDomain";

export const runtime = "nodejs";

/**
 * GET /api/worker/assignments/:id — one assignment of the authenticated
 * worker with its complaint summary (404 for anyone else's — no existence
 * leak). Includes the reassignment chain link (previousAssignmentId).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await params;
    const assignment = await getMyAssignment(user, id);
    return NextResponse.json({ assignment });
  } catch (err) {
    return handleRouteError(err);
  }
}
