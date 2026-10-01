import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { handleRouteError, readJson } from "@/lib/api";
import { workerApplicationReviewInput } from "@/lib/constants";
import { listPendingWorkerApplications, reviewWorkerApplication } from "@/lib/workerDomain";

export const runtime = "nodejs";

/** GET /api/official/worker-applications — pending applications (officials only). */
export async function GET(req: Request) {
  try {
    await requireRole(req, "OFFICIAL");
    const applications = await listPendingWorkerApplications();
    return NextResponse.json({ applications });
  } catch (err) {
    return handleRouteError(err);
  }
}

/**
 * POST /api/official/worker-applications — approve or reject an application.
 * The reviewer is always the authenticated OFFICIAL session user. Approval
 * is atomic (WorkerProfile + role transition + status); rejection requires
 * a reason. Both decisions are audited.
 */
export async function POST(req: Request) {
  try {
    const reviewer = await requireRole(req, "OFFICIAL");
    const { applicationId, decision, rejectionReason } = (
      z
        .object({
          applicationId: z.string().min(5).max(60),
        })
        .merge(workerApplicationReviewInput)
    ).parse(await readJson(req));

    const result = await reviewWorkerApplication(reviewer, applicationId, decision, rejectionReason);
    return NextResponse.json(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
