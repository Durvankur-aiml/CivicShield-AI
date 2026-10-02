import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { handleRouteError, readJson, rateLimit, clientKey } from "@/lib/api";
import { officialApplicationInput } from "@/lib/constants";
import { submitOfficialApplication, getMyOfficialApplication } from "@/lib/officialDomain";

export const runtime = "nodejs";

/**
 * POST /api/official/apply — the authenticated CITIZEN/WORKER submits an
 * official application for ADMIN verification. The applicant is always the
 * session user; no client-supplied identity (and never an officialId) is
 * trusted. Rate-limited like the worker application route.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    if (!rateLimit(clientKey(req, "official-apply"), 5, 60 * 60_000)) {
      return NextResponse.json({ error: "Too many application attempts. Please try again later." }, { status: 429 });
    }
    const input = officialApplicationInput.parse(await readJson(req));
    const application = await submitOfficialApplication(user, input);
    return NextResponse.json({ application }, { status: 201 });
  } catch (err) {
    return handleRouteError(err);
  }
}

/** GET /api/official/apply — the authenticated user's own application status. */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const application = await getMyOfficialApplication(user);
    return NextResponse.json({ application });
  } catch (err) {
    return handleRouteError(err);
  }
}
