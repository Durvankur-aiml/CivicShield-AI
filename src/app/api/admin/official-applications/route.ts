import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { handleRouteError } from "@/lib/api";
import { listPendingOfficialApplications, listOfficialProfiles } from "@/lib/officialDomain";

export const runtime = "nodejs";

/**
 * GET /api/admin/official-applications — pending official applications plus
 * the verified official registry (ADMIN only; the reviewer identity always
 * comes from the session, never from the client).
 */
export async function GET(req: Request) {
  try {
    await requireRole(req, "ADMIN");
    const [applications, profiles] = await Promise.all([
      listPendingOfficialApplications(),
      listOfficialProfiles(),
    ]);
    return NextResponse.json({ applications, profiles });
  } catch (err) {
    return handleRouteError(err);
  }
}
