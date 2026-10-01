import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { handleRouteError, jsonError, readJson } from "@/lib/api";
import { prisma } from "@/lib/db";
import { assignWorker } from "@/lib/agent/tools";

export const runtime = "nodejs";

const bodySchema = z.object({ workerId: z.string().min(5).max(60) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const official = await requireRole(req, "OFFICIAL");
    const { id } = await params;
    const { workerId } = bodySchema.parse(await readJson(req));

    const complaint = await prisma.complaint.findUnique({ where: { id }, include: { department: true } });
    if (!complaint) return jsonError(404, "Complaint not found");
    if (complaint.status === "RESOLVED" || complaint.status === "CLOSED") {
      return jsonError(409, `Complaint is already ${complaint.status.toLowerCase()}`);
    }

    // Validate the worker explicitly so a bad id returns 404, not a 500.
    const worker = await prisma.user.findUnique({ where: { id: workerId }, select: { id: true, name: true, role: true } });
    if (!worker || worker.role !== "WORKER") return jsonError(404, "Worker not found");

    const updated = await assignWorker(id, workerId);

    // Phase 2B compatibility: manual assignment participates in the same
    // Assignment history model (mode MANUAL). Any open assignment is closed
    // as REASSIGNED before the new row is created — history is preserved.
    const newAssignmentId = await prisma.$transaction(async (tx) => {
      if (complaint.activeAssignmentId) {
        await tx.assignment.update({
          where: { id: complaint.activeAssignmentId },
          data: { status: "REASSIGNED", closedAt: new Date() },
        });
      }
      const created = await tx.assignment.create({
        data: {
          complaintId: id,
          workerId,
          status: "OFFERED",
          mode: "MANUAL",
          policyVersion: "manual",
          reason: `Manual assignment by ${official.email}`,
        },
      });
      await tx.complaint.update({ where: { id }, data: { activeAssignmentId: created.id } });
      return created.id;
    });
    void newAssignmentId;

    await prisma.timelineEvent.create({
      data: {
        complaintId: id, type: "ASSIGNMENT", actor: `official:${official.name}`,
        title: "Field worker assigned",
        detail: `Assigned to ${worker?.name ?? "worker"}${complaint.department ? ` (${complaint.department.name})` : ""}`,
      },
    });
    await prisma.agentActivity.create({
      data: {
        complaintId: id, agent: "AssignmentAgent", action: "MANUAL_ASSIGN",
        summary: `Worker ${worker?.name ?? workerId} assigned to ${complaint.refCode} by ${official.email} (manual)`,
      },
    });

    return NextResponse.json({ ok: true, status: updated.status });
  } catch (err) {
    return handleRouteError(err);
  }
}
