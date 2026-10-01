import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { handleRouteError } from "@/lib/api";
import { getMyWorkerProfile } from "@/lib/workerDomain";

export const runtime = "nodejs";

/**
 * GET /api/worker/profile — the authenticated WORKER's verified profile.
 * A user without a profile gets 404 (no existence oracle for other users —
 * this endpoint only ever reflects the caller's own record).
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const profile = await getMyWorkerProfile(user);
    return NextResponse.json({ profile });
  } catch (err) {
    return handleRouteError(err);
  }
}
