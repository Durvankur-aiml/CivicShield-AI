import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { handleRouteError, jsonError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { closeComplaint } from "@/lib/agent/tools";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireRole(req, "OFFICIAL");
    const { id } = await params;

    const complaint = await prisma.complaint.findUnique({ where: { id } });
    if (!complaint) return jsonError(404, "Complaint not found");
    if (complaint.status !== "RESOLVED") {
      return jsonError(409, "Only AI-verified resolved complaints can be closed");
    }

    const updated = await closeComplaint(id);
    await prisma.timelineEvent.create({
      data: { complaintId: id, type: "STATUS", actor: "official", title: "Complaint closed after verified resolution" },
    });
    return NextResponse.json({ ok: true, status: updated.status });
  } catch (err) {
    return handleRouteError(err);
  }
}
