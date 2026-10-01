import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { handleRouteError, jsonError, readJson, rateLimit, clientKey } from "@/lib/api";
import { workerApplicationInput } from "@/lib/constants";
import { submitWorkerApplication, getMyWorkerApplication } from "@/lib/workerDomain";

export const runtime = "nodejs";

/**
 * POST /api/worker/apply — the authenticated CITIZEN submits a worker
 * application for official verification. The applicant is always the session
 * user; no client-supplied identity is trusted.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    if (!rateLimit(clientKey(req, "worker-apply"), 5, 60 * 60_000)) {
      return jsonError(429, "Too many application attempts. Please try again later.");
    }
    const input = workerApplicationInput.parse(await readJson(req));
    const application = await submitWorkerApplication(user, input);
    return NextResponse.json({ application }, { status: 201 });
  } catch (err) {
    return handleRouteError(err);
  }
}

/** GET /api/worker/apply — the authenticated user's own application status. */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const application = await getMyWorkerApplication(user);
    return NextResponse.json({ application });
  } catch (err) {
    return handleRouteError(err);
  }
}
