import { NextResponse } from "next/server";
import { requireUser, ApiError } from "@/lib/auth";
import { handleRouteError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { publicUrlForKey, deleteImage } from "@/lib/storage";
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

/**
 * A citizen may delete their own report ONLY while it is still unassigned and
 * untouched by worker processing — i.e. status RECEIVED (the intake default)
 * with NO active assignment and NO assignee ever recorded. The instant an
 * assignment exists (or once existed and was closed), the complaint has
 * entered the operational workflow and can no longer be withdrawn.
 *
 * Concurrency (B6): eligibility is decided INSIDE a transaction on the
 * complaint row's CURRENT database state, and the deleteMany's where clause
 * re-checks the same condition — an assignment that lands between the UI's
 * render and the delete click is rejected server-side (409), never trusted
 * from stale browser state.
 *
 * Data semantics (B4): physical deletion. Child records are handled by the
 * schema's own FK actions — timeline events, agent activities, escalations
 * and notifications CASCADE; the duplicateOf self-relation is SET NULL, so
 * related complaints keep their history with a cleared link. The report's
 * photo is best-effort removed so evidence does not outlive its report.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await params;

    const result = await prisma.$transaction(async (tx) => {
      // Current state only — the browser's view is never trusted.
      const complaint = await tx.complaint.findUnique({
        where: { id },
        select: { id: true, reporterId: true, status: true, activeAssignmentId: true, assignedToId: true, photoKey: true },
      });
      if (!complaint) throw new ApiError(404, "Complaint not found");
      if (complaint.reporterId !== user.id) throw new ApiError(403, "You can only delete your own reports");
      if (complaint.status !== "RECEIVED" || complaint.activeAssignmentId || complaint.assignedToId) {
        throw new ApiError(
          409,
          complaint.activeAssignmentId || complaint.assignedToId
            ? "This report has been assigned to a worker and can no longer be deleted"
            : `This report is ${complaint.status} and can no longer be deleted`
        );
      }
      // Conditional delete: re-checks eligibility at write time — a racing
      // assignment transaction commits before this statement and makes the
      // where clause match nothing (the complaint survives, the API says 409).
      const deleted = await tx.complaint.deleteMany({
        where: { id, reporterId: user.id, status: "RECEIVED", activeAssignmentId: null, assignedToId: null },
      });
      if (deleted.count === 0) throw new ApiError(409, "This report can no longer be deleted");
      return { photoKey: complaint.photoKey as string | null };
    });

    // Evidence must not outlive its report (best-effort — a storage failure
    // is logged and left for housekeeping; it must NEVER fail the deletion,
    // which has already committed).
    if (result.photoKey) {
      try {
        await deleteImage(result.photoKey);
      } catch (cleanupErr) {
        console.error("[api] complaint photo cleanup failed:", cleanupErr);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
