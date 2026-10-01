import { NextResponse } from "next/server";
import { requireUser, ApiError } from "@/lib/auth";
import { handleRouteError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { publicUrlForKey } from "@/lib/storage";
import { slaStateFor } from "@/lib/slaDomain";

export const runtime = "nodejs";

/** GET /api/complaints/:id — full detail incl. agent activity, timeline, escalations. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await params;

    const complaint = await prisma.complaint.findUnique({
      where: { id },
      include: {
        reporter: { select: { id: true, name: true, email: true } },
        assignedTo: { select: { id: true, name: true, phone: true } },
        department: { select: { id: true, code: true, name: true } },
        events: { orderBy: { createdAt: "asc" } },
        agentActivities: { orderBy: { createdAt: "asc" } },
        escalations: { orderBy: { level: "desc" } },
        duplicateOf: { select: { id: true, refCode: true, title: true } },
        duplicates: { select: { id: true, refCode: true, title: true } },
        activeAssignment: {
          select: { id: true, status: true, mode: true, slaWarnedAt: true, slaBreachedAt: true, completedAt: true },
        },
      },
    });
    if (!complaint) throw new ApiError(404, "Complaint not found");

    const isOwner = complaint.reporterId === user.id;
    const isAssignee = complaint.assignedToId === user.id;
    const isOfficial = user.role === "OFFICIAL";
    if (!isOwner && !isAssignee && !isOfficial) throw new ApiError(403, "You do not have access to this complaint");

    // Phase 3: derived operational SLA state (never stored — computed from
    // authoritative timestamps) so officials/citizens can answer "is this
    // within SLA?" and "what escalation happened?" from one endpoint.
    const { activeAssignment, ...complaintData } = complaint;
    const slaState = slaStateFor(complaint, activeAssignment ?? null);
    return NextResponse.json({
      complaint: {
        ...complaintData,
        photoUrl: publicUrlForKey(complaint.photoKey),
        resolutionUrl: publicUrlForKey(complaint.resolutionKey),
        activeAssignment: activeAssignment
          ? { id: activeAssignment.id, status: activeAssignment.status, mode: activeAssignment.mode }
          : null,
        slaState,
      },
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
