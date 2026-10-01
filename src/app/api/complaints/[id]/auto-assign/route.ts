import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { handleRouteError } from "@/lib/api";
import { assignComplaintAutomatically } from "@/lib/assignmentDomain";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST /api/complaints/:id/auto-assign — official-triggered run of the
 * deterministic assignment engine (intake already attempts it automatically;
 * this endpoint covers manual retry / NO_ELIGIBLE_WORKER follow-up).
 * Returns the explicit engine outcome — never assigns an ineligible worker.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireRole(req, "OFFICIAL");
    const { id } = await params;
    const outcome = await assignComplaintAutomatically(id, { trigger: "MANUAL_RETRY" });
    const status = outcome.kind === "NOT_ASSIGNABLE" ? 409 : 200;
    return NextResponse.json(outcome, { status });
  } catch (err) {
    return handleRouteError(err);
  }
}
