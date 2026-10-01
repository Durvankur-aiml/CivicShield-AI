import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { handleRouteError, jsonError, readJson } from "@/lib/api";
import { prisma } from "@/lib/db";
import { checkSla } from "@/lib/agent/tools";

export const runtime = "nodejs";

const bodySchema = z.object({
  complaintId: z.string().min(5).max(60),
  mode: z.enum(["warning", "breach"]),
});

/**
 * DEMO / DEVELOPMENT MODE ONLY.
 *
 * Lets a demo official move a complaint's SLA clock so judges can see the
 * warning → overdue → escalation behavior without waiting hours. This is a
 * transparent, labeled demo control — every use writes a timeline event and
 * an agent-log entry saying exactly what was adjusted and by whom. It is
 * disabled in production builds unless DEMO_MODE=true is set explicitly, and
 * it never touches anything outside the running app's own database.
 */
export async function POST(req: Request) {
  try {
    if (process.env.DEMO_MODE === "false") return jsonError(403, "Demo mode is disabled");
    // Default-secure: demo controls require an explicit DEMO_MODE=true on any
    // deployed environment (production OR Vercel preview — VERCEL_ENV covers
    // previews where a lax guard would otherwise expose SLA manipulation),
    // and stay available for local development.
    const isDeployed =
      process.env.NODE_ENV === "production" ||
      process.env.VERCEL === "1" ||
      process.env.VERCEL_ENV != null;
    if (isDeployed && process.env.DEMO_MODE !== "true") {
      return jsonError(403, "Demo controls are disabled in production");
    }

    const official = await requireRole(req, "OFFICIAL");
    const { complaintId, mode } = bodySchema.parse(await readJson(req));

    const complaint = await prisma.complaint.findUnique({ where: { id: complaintId } });
    if (!complaint) return jsonError(404, "Complaint not found");
    if (["RESOLVED", "CLOSED"].includes(complaint.status)) {
      return jsonError(409, "Demo SLA control is not available for closed cases");
    }

    const newDueAt =
      mode === "warning"
        ? new Date(Date.now() + 15 * 60_000) // deadline approaching: 15 minutes left
        : new Date(Date.now() - 60 * 60_000); // already breached: 1 hour past due

    await prisma.complaint.update({ where: { id: complaintId }, data: { slaDueAt: newDueAt } });
    await prisma.timelineEvent.create({
      data: {
        complaintId,
        type: "SLA",
        actor: `official:${official.name}`,
        title: `⏰ DEMO MODE: SLA clock ${mode === "warning" ? "set to expire in 15 minutes" : "set 1 hour into the past (breached)"}`,
        detail: "Development demo control — used to demonstrate SLA warning/overdue/escalation behavior without waiting. Not a real breach.",
      },
    });
    await prisma.agentActivity.create({
      data: {
        complaintId,
        agent: "SLAAgent",
        action: "demo_adjust_sla",
        summary: `DEMO MODE: SLA deadline moved to ${newDueAt.toISOString()} by ${official.name} for demonstration`,
        detail: JSON.stringify({ mode, demo: true }),
      },
    });

    // For a breach, run the same sweep production would run on schedule.
    const sweep = mode === "breach" ? await checkSla() : [];

    return NextResponse.json({
      ok: true,
      mode,
      slaDueAt: newDueAt.toISOString(),
      sweep,
      note: "DEMO MODE — SLA clock adjusted for demonstration; every adjustment is labeled in the case timeline.",
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
