import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, ApiError } from "@/lib/auth";
import { handleRouteError, jsonError, readJson } from "@/lib/api";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

const bodySchema = z.object({ action: z.enum(["accept", "start"]) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await params;
    const { action } = bodySchema.parse(await readJson(req));

    const complaint = await prisma.complaint.findUnique({ where: { id } });
    if (!complaint) return jsonError(404, "Complaint not found");

    const isAssignee = complaint.assignedToId === user.id;
    const isOfficial = user.role === "OFFICIAL";
    if (!isAssignee && !isOfficial) throw new ApiError(403, "Only the assigned worker or an official can update this complaint");

    if (action === "accept") {
      if (complaint.status !== "ASSIGNED" && complaint.status !== "REOPENED") {
        return jsonError(409, `Cannot accept a complaint in status ${complaint.status}`);
      }
      await prisma.complaint.update({ where: { id }, data: { status: "ASSIGNED" } });
      await prisma.timelineEvent.create({
        data: { complaintId: id, type: "STATUS", actor: `worker:${user.name}`, title: "Worker accepted the assignment" },
      });
      return NextResponse.json({ ok: true, status: "ASSIGNED" });
    }

    // action === "start"
    if (complaint.status !== "ASSIGNED" && complaint.status !== "REOPENED") {
      return jsonError(409, `Cannot start work from status ${complaint.status}`);
    }
    await prisma.complaint.update({ where: { id }, data: { status: "IN_PROGRESS", startedAt: new Date() } });
    await prisma.timelineEvent.create({
      data: { complaintId: id, type: "STATUS", actor: `worker:${user.name}`, title: "Work started on site" },
    });
    return NextResponse.json({ ok: true, status: "IN_PROGRESS" });
  } catch (err) {
    return handleRouteError(err);
  }
}
