import { prisma } from "./db";
import { SLA_WARNING_FRACTION, SLA_STATES } from "./constants";
import { send } from "./notificationDomain";
import { escalateComplaint } from "./agent/tools";
import { assignComplaintAutomatically } from "./assignmentDomain";

/**
 * SLA domain (Phase 3) — operational SLA states + scheduled assignment-level
 * SLA processing.
 *
 * STATE IS DERIVED, NOT STORED: slaStateFor() computes the current state from
 * authoritative timestamps (slaDueAt, completion/resolution markers,
 * escalationCount). There is no redundant authoritative "slaState" column
 * that could drift out of sync. The persisted markers (slaWarnedAt /
 * slaBreachedAt on Assignment) exist ONLY for once-per-assignment idempotency
 * of warnings/breaches.
 *
 * ESCALATION LADDER (deterministic; reuses the existing role structure — this
 * repository has no supervisor role, so OFFICIALS are the escalation target):
 *   L0  assignment created (worker notified)                — Phase 2B engine
 *   L1  SLA_WARNING at 75% of the window consumed           → worker notified
 *   L2  SLA_BREACH past slaDueAt                            → worker + officials
 *       (complaint-level OVERDUE flag + HIGH/CRITICAL escalation stay in the
 *        existing checkSla — one breach pipeline, no duplication)
 *   L3  breach on an assignment still OFFERED (worker never responded for the
 *       entire window) → complaint escalated, assignment closed REASSIGNED,
 *       engine re-runs excluding the unresponsive worker (bounded by the
 *       Phase 2B MAX_AUTO_ATTEMPTS budget). Breached ACCEPTED/IN_PROGRESS
 *       work is NOT auto-reassigned — the worker may legitimately be on site;
 *       officials intervene via override.
 *
 * TIMING: thresholds reuse the existing severity-based SLA_HOURS policy — no
 * new durations are invented. The warning fraction is SLA_WARNING_FRACTION
 * (0.75), centralized in constants.ts.
 */

export type SlaState = (typeof SLA_STATES)[number];

/**
 * Derive the operational SLA state from authoritative data (complaint +
 * optional active assignment). THE canonical entry point for APIs, views, and
 * tests — state is computed, never stored.
 */
export function slaStateFor(
  complaint: {
    status: string;
    slaDueAt: Date | null;
    isOverdue: boolean;
    escalationCount: number;
    createdAt: Date;
    resolvedAt?: Date | null;
  },
  activeAssignment?: { slaWarnedAt: Date | null; slaBreachedAt: Date | null; completedAt: Date | null } | null,
  now: Date = new Date()
): SlaState {
  const done =
    complaint.status === "RESOLVED" ||
    complaint.status === "CLOSED" ||
    !!complaint.resolvedAt ||
    !!activeAssignment?.completedAt;
  if (done) return "RESOLVED";
  if (complaint.status === "ESCALATED" && complaint.escalationCount > 0) return "ESCALATED";
  if (complaint.isOverdue || (complaint.slaDueAt != null && complaint.slaDueAt.getTime() <= now.getTime())) {
    return "BREACHED";
  }
  if (activeAssignment?.slaWarnedAt) return "WARNING";
  if (complaint.slaDueAt != null) {
    const windowMs = complaint.slaDueAt.getTime() - complaint.createdAt.getTime();
    if (windowMs > 0 && now.getTime() - complaint.createdAt.getTime() >= windowMs * SLA_WARNING_FRACTION) {
      return "WARNING";
    }
  }
  return "ON_TRACK";
}

export type AssignmentSweepResult = {
  assignmentId: string;
  complaintRef: string;
  action: "warning" | "breach" | "escalated" | "none";
  error?: string;
};

const OPEN_STATUSES = ["OFFERED", "ACCEPTED", "IN_PROGRESS"] as const;
/** Complaint statuses whose active assignment is still operationally live. */
const SWEEPABLE_COMPLAINT_STATUSES = ["ASSIGNED", "IN_PROGRESS", "REOPENED", "ESCALATED"] as const;

async function notifyOfficials(
  type: string,
  title: string,
  body: string,
  complaintId: string,
  dedupeKey: string
): Promise<void> {
  const officials = await prisma.user.findMany({ where: { role: "OFFICIAL" }, select: { id: true } });
  await Promise.all(
    officials.map((o) =>
      send(prisma, { recipientId: o.id, type, title, body, complaintId, dedupeKey: `${dedupeKey}:${o.id}` })
    )
  );
}

/**
 * Close the breached offer, clear the pointer, escalate the complaint, and
 * re-run the engine excluding the unresponsive worker. Bounded by the Phase
 * 2B MAX_AUTO_ATTEMPTS budget inside the engine itself.
 */
async function escalateAndReassign(
  assignment: { id: string; workerId: string; complaintId: string },
  refCode: string
): Promise<"escalated" | "none"> {
  // L3 is only for offers never accepted — re-check status under the tx.
  const fresh = await prisma.assignment.findUnique({ where: { id: assignment.id } });
  if (!fresh || fresh.status !== "OFFERED") return "none";

  const esc = await escalateComplaint(assignment.complaintId, "SLA breached with no worker response — reassignment required");
  await notifyOfficials(
    "ESCALATION",
    `Escalated (level ${esc.escalationCount}): ${refCode}`,
    "SLA breached and the assigned worker never responded. Reassignment has been attempted — override manually if needed.",
    assignment.complaintId,
    `escalation:${assignment.complaintId}:${esc.escalationCount}`
  );
  await prisma.$transaction(async (tx) => {
    await tx.assignment.update({
      where: { id: assignment.id },
      data: { status: "REASSIGNED", closedAt: new Date() },
    });
    await tx.complaint.update({ where: { id: assignment.complaintId }, data: { activeAssignmentId: null } });
  });
  await assignComplaintAutomatically(assignment.complaintId, {
    trigger: "REASSIGN",
    excludedWorkerIds: [assignment.workerId],
    actor: "sla-sweep",
  });
  return "escalated";
}

/**
 * processAssignmentSla — the Phase 3 scheduled SLA pass (run by the cron route
 * alongside the legacy complaint-level checkSla).
 *
 * Idempotent per assignment: slaWarnedAt / slaBreachedAt markers guarantee the
 * warning and breach fire EXACTLY once per assignment no matter how often the
 * sweep runs; marker update + notification are written in ONE transaction and
 * the notification dedupeKey UNIQUE constraint backstops any race.
 *
 * Failure isolation: one broken assignment never aborts the sweep.
 */
export async function processAssignmentSla(now: Date = new Date()): Promise<AssignmentSweepResult[]> {
  const open = await prisma.assignment.findMany({
    where: {
      status: { in: [...OPEN_STATUSES] },
      complaint: { slaDueAt: { not: null }, status: { in: [...SWEEPABLE_COMPLAINT_STATUSES] } },
    },
    include: {
      complaint: { select: { id: true, refCode: true, slaDueAt: true, createdAt: true } },
    },
    take: 500,
  });

  const results: AssignmentSweepResult[] = [];
  for (const a of open) {
    const due = a.complaint.slaDueAt;
    if (!due) continue;
    const windowMs = due.getTime() - a.complaint.createdAt.getTime();
    if (windowMs <= 0) continue;
    const consumed = now.getTime() - a.complaint.createdAt.getTime();
    const base = { assignmentId: a.id, complaintRef: a.complaint.refCode };
    try {
      if (consumed >= windowMs) {
        // ── L2 BREACH — once per assignment ─────────────────────────────
        if (!a.slaBreachedAt) {
          await prisma.$transaction(async (tx) => {
            await tx.assignment.update({ where: { id: a.id, slaBreachedAt: null }, data: { slaBreachedAt: now } });
            await send(tx, {
              recipientId: a.workerId,
              type: "SLA_BREACH",
              title: `SLA breached on ${a.complaint.refCode}`,
              body: "The deadline for this complaint has passed. Complete the work or reject the assignment so it can be reassigned.",
              complaintId: a.complaintId,
              assignmentId: a.id,
              dedupeKey: `sla:breach:${a.id}`,
            });
          });
          await notifyOfficials(
            "SLA_BREACH",
            `SLA breached: ${a.complaint.refCode}`,
            "The assignment deadline has passed without completion. Review the complaint or override the assignment.",
            a.complaintId,
            `sla:breach:official:${a.id}`
          );
        }
        // ── L3 — breach on an offer the worker never accepted ──────────
        const action = a.status === "OFFERED" ? await escalateAndReassign(a, a.complaint.refCode) : "none";
        results.push({ ...base, action: action === "escalated" ? "escalated" : "breach" });
      } else if (consumed >= windowMs * SLA_WARNING_FRACTION) {
        // ── L1 WARNING — once per assignment ───────────────────────────
        if (a.slaWarnedAt) {
          results.push({ ...base, action: "none" });
          continue;
        }
        await prisma.$transaction(async (tx) => {
          await tx.assignment.update({ where: { id: a.id, slaWarnedAt: null }, data: { slaWarnedAt: now } });
          await send(tx, {
            recipientId: a.workerId,
            type: "SLA_WARNING",
            title: `Deadline approaching on ${a.complaint.refCode}`,
            body: "The SLA window is almost over. Please accept, start, or complete the work soon.",
            complaintId: a.complaintId,
            assignmentId: a.id,
            dedupeKey: `sla:warning:${a.id}`,
          });
        });
        results.push({ ...base, action: "warning" });
      } else {
        results.push({ ...base, action: "none" });
      }
    } catch (err) {
      results.push({ ...base, action: "none", error: (err as Error).message });
    }
  }
  return results;
}
