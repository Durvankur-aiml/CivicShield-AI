import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { handleRouteError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { toPublicOfficialProfile } from "@/lib/officialDomain";

export const runtime = "nodejs";

/**
 * GET /api/official/profile — the authenticated OFFICIAL's own verified
 * profile (CivicShield Official ID, department, designation…). 404 when the
 * account has no verified profile (e.g. allowlist-provisioned staff) — a
 * "not yet provisioned" state, not an error surface.
 */
export async function GET(req: Request) {
  try {
    const user = await requireRole(req, "OFFICIAL");
    const profile = await prisma.officialProfile.findUnique({
      where: { userId: user.id },
      include: { department: { select: { code: true, name: true } } },
    });
    if (!profile) {
      return NextResponse.json({ error: "No verified official profile for this account" }, { status: 404 });
    }
    return NextResponse.json({ profile: toPublicOfficialProfile(profile) });
  } catch (err) {
    return handleRouteError(err);
  }
}
