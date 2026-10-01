import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handleRouteError, readJson } from "@/lib/api";
import { acceptAssignment, rejectAssignment, startAssignment, completeAssignment } from "@/lib/assignmentDomain";

export const runtime = "nodejs";

const bodySchema = z.object({ action: z.enum(["accept", "reject", "start", "complete"]) });

/**
 * POST /api/assignments/:id/respond — the ASSIGNED worker responds to their
 * assignment (identity from the session; transition guards server-side):
 *  - accept   → OFFERED → ACCEPTED
 *  - start    → ACCEPTED → IN_PROGRESS (complaint follows)
 *  - complete → IN_PROGRESS → COMPLETED (complaint → VERIFICATION)
 *  - reject   → assignment closed (REJECTED, history preserved), engine
 *               re-runs excluding this worker; bounded attempts, explicit
 *               NO_ELIGIBLE_WORKER when nobody eligible remains.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await params;
    const { action } = bodySchema.parse(await readJson(req));

    if (action === "accept") return NextResponse.json(await acceptAssignment(user, id));
    if (action === "start") return NextResponse.json(await startAssignment(user, id));
    if (action === "complete") return NextResponse.json(await completeAssignment(user, id));
    return NextResponse.json(await rejectAssignment(user, id));
  } catch (err) {
    return handleRouteError(err);
  }
}
