import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { handleRouteError } from "@/lib/api";
import { listMyAssignments } from "@/lib/assignmentDomain";

export const runtime = "nodejs";

/**
 * GET /api/worker/assignments — the authenticated worker's assignment list
 * (newest first, complaint summary included). Identity comes from the
 * session; there is no client-controlled workerId anywhere.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const assignments = await listMyAssignments(user);
    return NextResponse.json({ assignments });
  } catch (err) {
    return handleRouteError(err);
  }
}
