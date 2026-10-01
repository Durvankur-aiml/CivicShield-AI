import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { handleRouteError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { listWorkerProfiles } from "@/lib/workerDomain";

export const runtime = "nodejs";

/**
 * GET /api/official/workers — worker list for assignment (officials only).
 * Phase 2A: now includes verified WorkerProfile capability data (skills,
 * equipment, availability, service areas, workload capacity). Legacy workers
 * without a profile (e.g. seeded staff rows) still appear with
 * `profile: null`, so the existing dashboard assignment flow is unaffected.
 */
export async function GET(req: Request) {
  try {
    await requireRole(req, "OFFICIAL");

    const users = await prisma.user.findMany({
      where: { role: "WORKER" },
      select: { id: true, name: true, departmentId: true },
      orderBy: { name: "asc" },
    });
    const profiles = await listWorkerProfiles();
    const byUserId = new Map(profiles.map((p) => [p.userId, p]));

    return NextResponse.json({
      users: users.map((u) => ({ ...u, profile: byUserId.get(u.id) ?? null })),
      registry: profiles,
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
