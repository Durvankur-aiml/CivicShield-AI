import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { handleRouteError, readJson } from "@/lib/api";
import { officialApplicationReviewInput } from "@/lib/constants";
import { reviewOfficialApplication } from "@/lib/officialDomain";

export const runtime = "nodejs";

/**
 * POST /api/admin/official-applications/review — approve or reject an
 * official application (ADMIN only). Mirrors POST /api/official/worker-
 * applications: the reviewer is always the authenticated ADMIN session user,
 * approval is atomic (OfficialProfile + CivicShield Official ID + role
 * transition), rejection requires a reason. Both decisions are audited.
 */
export async function POST(req: Request) {
  try {
    const reviewer = await requireRole(req, "ADMIN");
    const { applicationId, decision, rejectionReason } = (
      z
        .object({
          applicationId: z.string().min(5).max(60),
        })
        .merge(officialApplicationReviewInput)
    ).parse(await readJson(req));

    const result = await reviewOfficialApplication(reviewer, applicationId, decision, rejectionReason);
    return NextResponse.json(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
