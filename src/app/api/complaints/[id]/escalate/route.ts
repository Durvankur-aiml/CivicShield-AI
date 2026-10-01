import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { handleRouteError, jsonError, readJson } from "@/lib/api";
import { prisma } from "@/lib/db";
import { escalateComplaint } from "@/lib/agent/tools";

export const runtime = "nodejs";

const bodySchema = z.object({ reason: z.string().trim().min(5).max(300) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireRole(req, "OFFICIAL");
    const { id } = await params;
    const { reason } = bodySchema.parse(await readJson(req));

    const complaint = await prisma.complaint.findUnique({ where: { id } });
    if (!complaint) return jsonError(404, "Complaint not found");
    if (["RESOLVED", "CLOSED"].includes(complaint.status)) {
      return jsonError(409, "Resolved complaints cannot be escalated");
    }

    const updated = await escalateComplaint(id, reason);
    await prisma.timelineEvent.create({
      data: { complaintId: id, type: "ESCALATION", actor: "official", title: `Manually escalated (level ${updated.escalationCount})`, detail: reason },
    });
    return NextResponse.json({ ok: true, status: updated.status, escalationCount: updated.escalationCount });
  } catch (err) {
    return handleRouteError(err);
  }
}
