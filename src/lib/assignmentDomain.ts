import { prisma } from "./db";
import { ApiError, type SessionUser } from "./auth";
import { haversineMeters } from "./duplicate";
import { send, notificationKeys } from "./notificationDomain";
import type { WorkerProfile, Complaint } from "@prisma/client";

/**
 * Assignment engine (Phase 2B) — DETERMINISTIC policy engine, NOT an LLM.
 *
 * Pipeline: requirements → hard eligibility filter → scoring → selection.
 * Hard eligibility ALWAYS gates scoring: a worker failing any hard check is
 * ineligible and can never be rescued by a high score.
 *
 * Concurrency: auto-assign runs inside a single Prisma interactive
 * transaction; the complaint row is the serialization point (re-read with a
 * guard on activeAssignmentId == null inside the transaction, then the new
 * Assignment + complaint pointer are committed atomically). Two concurrent
 * auto-assign calls for one complaint serialize at the database level; the
 * loser sees an already-assigned complaint and returns ALREADY_ASSIGNED
 * without creating a duplicate.
 */

export const ASSIGNMENT_POLICY_VERSION = "2026-09-29.1";

/** Lifecycle statuses (validated strings, repo convention). */
export const ASSIGNMENT_STATUS = [
  "OFFERED", "ACCEPTED", "IN_PROGRESS", "COMPLETED", "REJECTED", "CANCELLED", "REASSIGNED",
] as const;
export const ASSIGNMENT_MODES = ["AUTO", "MANUAL", "OVERRIDE"] as const;

/** Auto-assign is attempted at most this many times per complaint. */
const MAX_AUTO_ATTEMPTS = 5;

// ── Scoring policy (explicit, documented in docs/ASSIGNMENT_ENGINE.md) ────
// Weights are an initial deterministic policy — NOT empirically optimized.
export const SCORE_WEIGHTS = {
  skills: 25, // capability coverage 0..1 × 25
  equipment: 15, // required-equipment coverage 0..1 × 15
  serviceArea: 15, // 1 if any service-area match, else 0 × 15
  workload: 15, // lighter load scores higher (1 − active/max), clamped
  distance: 15, // 1 at 0 m → 0 at MAX_DISTANCE_M, linear
  capacity: 10, // remaining-capacity headroom 0..1 × 10
  urgency: 5, // SLA time-pressure factor 0..1 × 5
} as const;
const MAX_TOTAL = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0); // 100
/** Distance beyond which proximity contributes 0 (service radius). */
export const MAX_DISTANCE_M = 10_000;
/** SLA fraction consumed at which urgency tops out. */
const URGENCY_SATURATION = 0.75;

export type ScoreBreakdown = { factor: string; points: number; max: number; note: string };

export type ComplaintRequirements = {
  departmentCode: string;
  category: string;
  requiredSkills: string[];
  requiredEquipment: string[];
  serviceArea: string | null; // ward when known
};

/**
 * Deterministic category → capability requirements mapping.
 *
 * Phase 2B scope note: triage metadata currently provides department +
 * category only (no skill/equipment extraction exists anywhere in the
 * codebase). This mapping is a DETERMINISTIC policy table — it is not
 * AI-generated and must not be presented as such. Keep it minimal and
 * conservative: only skills that are genuinely needed for the category.
 */
export const CATEGORY_REQUIREMENTS: Record<string, { skills: string[]; equipment: string[] }> = {
  POTHOLE: { skills: ["ROAD_REPAIR"], equipment: ["DRILL"] },
  ROAD_DAMAGE: { skills: ["ROAD_REPAIR"], equipment: ["DRILL"] },
  GARBAGE: { skills: ["WASTE_COLLECTION"], equipment: [] },
  WASTE_OVERFLOW: { skills: ["WASTE_COLLECTION"], equipment: ["COMPACTOR_TRUCK"] },
  WATERLOGGING: { skills: ["DRAINAGE_CLEARING"], equipment: ["WATER_PUMP"] },
  STREETLIGHT: { skills: ["ELECTRICAL_REPAIR"], equipment: ["POLE_TRUCK"] },
  OTHER: { skills: [], equipment: [] }, // no hard capability demands
};

export function requirementsForComplaint(
  complaint: Pick<Complaint, "category" | "ward"> & { department?: { code: string } | null }
): ComplaintRequirements {
  const departmentCode = complaint.department?.code ?? "GEN";
  const req = CATEGORY_REQUIREMENTS[complaint.category] ?? CATEGORY_REQUIREMENTS.OTHER;
  return {
    departmentCode,
    category: complaint.category,
    requiredSkills: req.skills,
    requiredEquipment: req.equipment,
    serviceArea: complaint.ward ?? null,
  };
}

// ── Eligibility (hard gates — checked BEFORE any scoring) ────────────────

export type EligibilityResult = { eligible: boolean; reasons: string[] };

export function checkEligibility(
  profile: WorkerProfile,
  requirements: ComplaintRequirements,
  activeAssignments: number,
  excludedWorkerIds: Set<string>
): EligibilityResult {
  const reasons: string[] = [];
  if (excludedWorkerIds.has(profile.userId)) reasons.push("excluded (already rejected this request)");
  if (profile.availability !== "AVAILABLE") reasons.push(`availability is ${profile.availability}`);
  if (profile.departmentId && profile.departmentId !== requirements.departmentCode) {
    // departmentId stores the code (repo convention: Department.code as FK value in seeds/profiles)
    reasons.push(`different department (${profile.departmentId} ≠ ${requirements.departmentCode})`);
  }
  const missingSkills = requirements.requiredSkills.filter((s) => !profile.skills.includes(s));
  if (missingSkills.length > 0) reasons.push(`missing required skill(s): ${missingSkills.join(", ")}`);
  const missingEquipment = requirements.requiredEquipment.filter((e) => !profile.equipment.includes(e));
  if (missingEquipment.length > 0) reasons.push(`missing required equipment: ${missingEquipment.join(", ")}`);
  if (activeAssignments >= profile.maxActiveAssignments) {
    reasons.push(`at capacity (${activeAssignments}/${profile.maxActiveAssignments} active)`);
  }
  if (requirements.serviceArea && profile.serviceAreas.length > 0 && !profile.serviceAreas.includes(requirements.serviceArea)) {
    reasons.push(`service area does not cover ${requirements.serviceArea}`);
  }
  return { eligible: reasons.length === 0, reasons };
}

// ── Scoring (eligible candidates only) ───────────────────────────────────

export type ScoredCandidate = {
  profile: WorkerProfile;
  activeAssignments: number;
  distanceM: number | null;
  breakdown: ScoreBreakdown[];
  score: number; // 0..100
};

export function scoreCandidate(
  profile: WorkerProfile,
  requirements: ComplaintRequirements,
  activeAssignments: number,
  complaint: Pick<Complaint, "lat" | "lng" | "severity" | "slaDueAt" | "status" | "createdAt">
): ScoredCandidate {
  // Phase 4 compatibility (A13): complaint coordinates may be absent. Distance
  // then stays neutral (0.5 weight) — the engine never invents a distance.
  // Scoring WEIGHTS themselves are unchanged from Phase 2B.
  const breakdown: ScoreBreakdown[] = [];

  // 1. Skill coverage (0..1)
  const skillCov = requirements.requiredSkills.length
    ? requirements.requiredSkills.filter((s) => profile.skills.includes(s)).length /
      requirements.requiredSkills.length
    : 1;
  breakdown.push({
    factor: "skills", points: round2(skillCov * SCORE_WEIGHTS.skills), max: SCORE_WEIGHTS.skills,
    note: requirements.requiredSkills.length
      ? `${requirements.requiredSkills.filter((s) => profile.skills.includes(s)).length}/${requirements.requiredSkills.length} required skills`
      : "no specific skills required",
  });

  // 2. Equipment coverage (0..1)
  const equipCov = requirements.requiredEquipment.length
    ? requirements.requiredEquipment.filter((e) => profile.equipment.includes(e)).length /
      requirements.requiredEquipment.length
    : 1;
  breakdown.push({
    factor: "equipment", points: round2(equipCov * SCORE_WEIGHTS.equipment), max: SCORE_WEIGHTS.equipment,
    note: requirements.requiredEquipment.length
      ? `${requirements.requiredEquipment.filter((e) => profile.equipment.includes(e)).length}/${requirements.requiredEquipment.length} required equipment`
      : "no specific equipment required",
  });

  // 3. Service-area match (0 or 1)
  const areaMatch =
    !requirements.serviceArea || profile.serviceAreas.length === 0 || profile.serviceAreas.includes(requirements.serviceArea);
  breakdown.push({
    factor: "serviceArea", points: areaMatch ? SCORE_WEIGHTS.serviceArea : 0, max: SCORE_WEIGHTS.serviceArea,
    note: requirements.serviceArea
      ? areaMatch
        ? `covers ${requirements.serviceArea}`
        : `no declared coverage of ${requirements.serviceArea} (soft factor)`
      : "complaint ward unknown",
  });

  // 4. Workload (1 − active/max, clamped to 0..1)
  const load = Math.min(1, Math.max(0, activeAssignments / Math.max(1, profile.maxActiveAssignments)));
  breakdown.push({
    factor: "workload", points: round2((1 - load) * SCORE_WEIGHTS.workload), max: SCORE_WEIGHTS.workload,
    note: `${activeAssignments}/${profile.maxActiveAssignments} active assignments`,
  });

  // 5. Capacity headroom (remaining slots / max, 0..1) — mild extra credit
  const capacity = Math.min(1, Math.max(0, (profile.maxActiveAssignments - activeAssignments) / Math.max(1, profile.maxActiveAssignments)));
  breakdown.push({
    factor: "capacity", points: round2(capacity * SCORE_WEIGHTS.capacity), max: SCORE_WEIGHTS.capacity,
    note: `${profile.maxActiveAssignments - activeAssignments} slot(s) free`,
  });

  // 6. Distance (linear 1 → 0 over MAX_DISTANCE_M; no coordinates → neutral 0.5)
  let distanceM: number | null = null;
  let distancePoints = SCORE_WEIGHTS.distance * 0.5;
  let distanceNote = "no worker location on file — neutral";
  if (profile.baseLat != null && profile.baseLng != null && complaint.lat != null && complaint.lng != null) {
    distanceM = Math.round(haversineMeters(profile.baseLat, profile.baseLng, complaint.lat, complaint.lng));
    distancePoints = SCORE_WEIGHTS.distance * Math.max(0, 1 - distanceM / MAX_DISTANCE_M);
    distanceNote = `${distanceM} m from complaint`;
  } else if (profile.baseLat != null && profile.baseLng != null) {
    distanceNote = "no complaint coordinates — neutral";
  }
  breakdown.push({
    factor: "distance", points: round2(distancePoints), max: SCORE_WEIGHTS.distance, note: distanceNote,
  });

  // 7. SLA urgency (0..1, saturated at URGENCY_SATURATION of the window consumed)
  let urgency = 0;
  if (complaint.slaDueAt && complaint.status !== "RESOLVED" && complaint.status !== "CLOSED") {
    const windowMs = complaint.slaDueAt.getTime() - complaint.createdAt.getTime();
    if (windowMs > 0) {
      const consumed = (Date.now() - complaint.createdAt.getTime()) / windowMs; // 0..1 of the window
      urgency = Math.min(1, Math.max(0, consumed / URGENCY_SATURATION));
    } else {
      urgency = 1; // already breached
    }
  }
  breakdown.push({
    factor: "urgency", points: round2(urgency * SCORE_WEIGHTS.urgency), max: SCORE_WEIGHTS.urgency,
    note: complaint.slaDueAt ? `${Math.round(urgency * 100)}% of SLA window consumed` : "no SLA clock",
  });

  const score = round2(breakdown.reduce((a, b) => a + b.points, 0));
  return { profile, activeAssignments, distanceM, breakdown, score };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Deterministic ranking: score DESC → distance ASC (nulls last) →
 * employeeId ASC (stable, unique).
 */
export function rankCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  const da = a.distanceM ?? Number.POSITIVE_INFINITY;
  const db = b.distanceM ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da - db;
  return a.profile.employeeId.localeCompare(b.profile.employeeId);
}

// ── Candidate loading (avoid N+1: one query + one aggregate) ─────────────

async function loadCandidatePool(departmentCode: string) {
  const profiles = await prisma.workerProfile.findMany({
    where: { departmentId: departmentCode, availability: "AVAILABLE" },
    // availability/department are hard gates pushable into SQL — everything
    // else is evaluated in-memory over this bounded pool (per-department).
  });
  if (profiles.length === 0) return [];
  const workerIds = profiles.map((p) => p.userId);
  const counts = await prisma.assignment.groupBy({
    by: ["workerId"],
    where: { workerId: { in: workerIds }, status: { in: ["OFFERED", "ACCEPTED", "IN_PROGRESS"] } },
    _count: { _all: true },
  });
  const countByWorker = new Map(counts.map((c) => [c.workerId, c._count._all]));
  return profiles.map((p) => ({ profile: p, activeAssignments: countByWorker.get(p.userId) ?? 0 }));
}

// ── Decision types ────────────────────────────────────────────────────────

export type AssignmentDecisionDetail = {
  policyVersion: string;
  requirements: ComplaintRequirements;
  selected: { userId: string; employeeId: string; name: string; score: number; breakdown: ScoreBreakdown[] } | null;
  candidates: Array<{ employeeId: string; score: number; distanceM: number | null }>;
  ineligible: Array<{ employeeId: string; reasons: string[] }>;
  consideredCount: number;
  noEligibleWorker?: boolean;
};

export type AssignmentOutcome =
  | { kind: "ASSIGNED"; assignmentId: string; workerId: string; employeeId: string; score: number; detail: AssignmentDecisionDetail }
  | { kind: "NO_ELIGIBLE_WORKER"; detail: AssignmentDecisionDetail }
  | { kind: "ALREADY_ASSIGNED"; assignmentId: string | null }
  | { kind: "NOT_ASSIGNABLE"; reason: string };

function buildDetail(
  requirements: ComplaintRequirements,
  eligible: ScoredCandidate[],
  ineligible: Array<{ employeeId: string; reasons: string[] }>
): AssignmentDecisionDetail {
  const ranked = [...eligible].sort(rankCandidates);
  return {
    policyVersion: ASSIGNMENT_POLICY_VERSION,
    requirements,
    selected: ranked[0]
      ? {
          userId: ranked[0].profile.userId,
          employeeId: ranked[0].profile.employeeId,
          name: ranked[0].profile.designation ?? ranked[0].profile.employeeId,
          score: ranked[0].score,
          breakdown: ranked[0].breakdown,
        }
      : null,
    candidates: ranked.map((c) => ({ employeeId: c.profile.employeeId, score: c.score, distanceM: c.distanceM })),
    ineligible,
    consideredCount: eligible.length + ineligible.length,
  };
}

/**
 * Complaint statuses the engine may (re)assign. ASSIGNED is included so the
 * rejection/escalation flow can reassign a complaint that is currently
 * assigned (its active assignment was just closed and the pointer cleared).
 */
const ASSIGNABLE_STATUSES = ["RECEIVED", "ASSIGNED", "REOPENED", "ESCALATED"] as const;

/**
 * assignComplaintAutomatically — the engine entry point.
 *
 * Returns an explicit outcome; NEVER assigns an ineligible worker and NEVER
 * invents a fallback assignment. Complaint is left unassigned (and audited)
 * on NO_ELIGIBLE_WORKER so officials/escalation can intervene.
 */
export async function assignComplaintAutomatically(
  complaintId: string,
  opts: {
    trigger: "INTAKE" | "REASSIGN" | "MANUAL_RETRY";
    excludedWorkerIds?: string[];
    actor?: string;
    previousAssignmentId?: string; // reassignment chain link (Phase 3)
  } = {
    trigger: "INTAKE",
  }
): Promise<AssignmentOutcome> {
  const excluded = new Set(opts.excludedWorkerIds ?? []);

  return prisma.$transaction(async (tx) => {
    const complaint = await tx.complaint.findUnique({
      where: { id: complaintId },
      include: { department: { select: { code: true, name: true } } },
    });
    if (!complaint) throw new ApiError(404, "Complaint not found");
    if (!ASSIGNABLE_STATUSES.includes(complaint.status as (typeof ASSIGNABLE_STATUSES)[number])) {
      return { kind: "NOT_ASSIGNABLE", reason: `status is ${complaint.status}` } as AssignmentOutcome;
    }
    if (complaint.activeAssignmentId) {
      return { kind: "ALREADY_ASSIGNED", assignmentId: complaint.activeAssignmentId } as AssignmentOutcome;
    }

    const requirements = requirementsForComplaint(complaint);
    const pool = await loadCandidatePool(requirements.departmentCode);

    const eligible: ScoredCandidate[] = [];
    const ineligible: Array<{ employeeId: string; reasons: string[] }> = [];
    for (const { profile, activeAssignments } of pool) {
      const elig = checkEligibility(profile, requirements, activeAssignments, excluded);
      if (elig.eligible) eligible.push(scoreCandidate(profile, requirements, activeAssignments, complaint));
      else ineligible.push({ employeeId: profile.employeeId, reasons: elig.reasons });
    }
    eligible.sort(rankCandidates);

    const detail = buildDetail(requirements, eligible, ineligible);

    if (eligible.length === 0) {
      detail.noEligibleWorker = true;
      await tx.agentActivity.create({
        data: {
          complaintId: complaint.id,
          agent: "AssignmentAgent",
          action: "NO_ELIGIBLE_WORKER",
          summary: `No eligible worker for ${complaint.refCode} (${requirements.departmentCode}) — complaint remains unassigned for official review`,
          detail: JSON.stringify(detail),
        },
      });
      await tx.timelineEvent.create({
        data: {
          complaintId: complaint.id,
          type: "ASSIGNMENT",
          actor: "agent:AssignmentAgent",
          title: "No eligible worker available",
          detail: `Requirements: ${requirements.requiredSkills.join(", ") || "none"} in ${requirements.departmentCode}. Awaiting official intervention.`,
        },
      });
      // Officials learn that the complaint needs manual intervention (one
      // notification per complaint per official — dedupeKey prevents spam).
      const officials = ((await tx.user.findMany({ where: { role: "OFFICIAL" }, select: { id: true } })) ?? []) as Array<{ id: string }>;
      for (const o of officials) {
        await send(tx, {
          recipientId: o.id,
          type: "ESCALATION",
          title: `No eligible worker for ${complaint.refCode}`,
          body: `Auto-assignment found no eligible ${requirements.departmentCode} worker. Official intervention required.`,
          complaintId: complaint.id,
          dedupeKey: `no-eligible:${complaint.id}:${o.id}`,
        });
      }
      return { kind: "NO_ELIGIBLE_WORKER", detail } as AssignmentOutcome;
    }

    const winner = eligible[0];
    const assignment = await tx.assignment.create({
      data: {
        complaintId: complaint.id,
        workerId: winner.profile.userId,
        status: "OFFERED",
        mode: "AUTO",
        policyVersion: ASSIGNMENT_POLICY_VERSION,
        previousAssignmentId: opts.previousAssignmentId ?? null,
        decision: JSON.stringify(detail),
        reason: opts.trigger === "REASSIGN" ? "Automatic reassignment after rejection" : "Automatic assignment at intake",
      },
    });
    await tx.complaint.update({
      where: { id: complaint.id },
      data: { activeAssignmentId: assignment.id, assignedToId: winner.profile.userId, status: "ASSIGNED", assignedAt: new Date() },
    });
    // Notify the worker INSIDE the same transaction — the offer and its
    // notification commit atomically (no assigned-but-unnotified states).
    await send(tx, {
      recipientId: winner.profile.userId,
      type: "ASSIGNMENT_OFFERED",
      title: `New assignment: ${complaint.refCode}`,
      body: `${complaint.category} in ${complaint.ward ?? "your service area"} — accept or reject it in your assignments list.`,
      complaintId: complaint.id,
      assignmentId: assignment.id,
      dedupeKey: notificationKeys.assignmentOffered(assignment.id),
    });
    await tx.agentActivity.create({
      data: {
        complaintId: complaint.id,
        agent: "AssignmentAgent",
        action: "ASSIGN",
        summary: `${winner.profile.employeeId} selected for ${complaint.refCode} — score ${winner.score}/${MAX_TOTAL} (${opts.trigger.toLowerCase()})`,
        detail: JSON.stringify(detail),
      },
    });
    await tx.timelineEvent.create({
      data: {
        complaintId: complaint.id,
        type: "ASSIGNMENT",
        actor: "agent:AssignmentAgent",
        title: `Automatically assigned to ${winner.profile.employeeId}`,
        detail: `Score ${winner.score}/${MAX_TOTAL} · ${requirements.departmentCode} · policy ${ASSIGNMENT_POLICY_VERSION}`,
      },
    });

    return {
      kind: "ASSIGNED",
      assignmentId: assignment.id,
      workerId: winner.profile.userId,
      employeeId: winner.profile.employeeId,
      score: winner.score,
      detail,
    } as AssignmentOutcome;
  });
}

/** Max sequential reassignment attempts after rejections (no infinite loops). */
export { MAX_AUTO_ATTEMPTS };

/**
 * rejectAssignment — the assigned worker declines. Closes the assignment
 * (history preserved), then runs the engine again excluding the rejecting
 * worker. Bounded by MAX_AUTO_ATTEMPTS total auto-assignments per complaint.
 */
export async function rejectAssignment(user: SessionUser, assignmentId: string): Promise<AssignmentOutcome> {
  const assignment = await prisma.assignment.findUnique({ where: { id: assignmentId }, include: { complaint: true } });
  if (!assignment) throw new ApiError(404, "Assignment not found");
  if (assignment.workerId !== user.id) throw new ApiError(403, "Only the assigned worker can reject this assignment");
  if (assignment.status !== "OFFERED" && assignment.status !== "ACCEPTED") {
    throw new ApiError(409, `Assignment is ${assignment.status} and can no longer be rejected`);
  }

  // Close + pointer clear + audit + worker/official notifications commit in
  // ONE transaction — a rejected assignment can never silently keep the
  // active pointer, and history rows are never touched.
  await prisma.$transaction(async (tx) => {
    await tx.assignment.update({
      where: { id: assignment.id },
      data: { status: "REJECTED", respondedAt: new Date() },
    });
    await tx.complaint.update({ where: { id: assignment.complaintId }, data: { activeAssignmentId: null } });
    await tx.agentActivity.create({
      data: {
        complaintId: assignment.complaintId,
        agent: "AssignmentAgent",
        action: "REJECT",
        summary: `Worker rejected assignment for ${assignment.complaint.refCode} — reassignment will be attempted`,
      },
    });
    await tx.timelineEvent.create({
      data: {
        complaintId: assignment.complaintId,
        type: "ASSIGNMENT",
        actor: `worker:${user.name}`,
        title: "Worker rejected the assignment",
        detail: "Assignment history preserved; engine will select the next eligible candidate.",
      },
    });
    await send(tx, {
      recipientId: user.id,
      type: "ASSIGNMENT_REJECTED",
      title: `Assignment rejected: ${assignment.complaint.refCode}`,
      body: "The complaint will be reassigned to the next eligible worker.",
      complaintId: assignment.complaintId,
      assignmentId: assignment.id,
      dedupeKey: notificationKeys.assignmentRejected(assignment.id),
    });
    const officials = ((await tx.user.findMany({ where: { role: "OFFICIAL" }, select: { id: true } })) ?? []) as Array<{ id: string }>;
    for (const o of officials) {
      await send(tx, {
        recipientId: o.id,
        type: "ASSIGNMENT_REJECTED",
        title: `Worker rejected assignment on ${assignment.complaint.refCode}`,
        body: "Reassignment is running automatically; override manually if the next pick is unsuitable.",
        complaintId: assignment.complaintId,
        assignmentId: assignment.id,
        dedupeKey: `reject:official:${assignment.id}:${o.id}`,
      });
    }
  });

  const previous = await prisma.assignment.count({ where: { complaintId: assignment.complaintId, mode: "AUTO" } });
  if (previous >= MAX_AUTO_ATTEMPTS) {
    await prisma.agentActivity.create({
      data: {
        complaintId: assignment.complaintId,
        agent: "AssignmentAgent",
        action: "NO_ELIGIBLE_WORKER",
        summary: `Auto-assignment attempt budget exhausted (${MAX_AUTO_ATTEMPTS}) for ${assignment.complaint.refCode} — manual intervention required`,
      },
    });
    return { kind: "NO_ELIGIBLE_WORKER", detail: { policyVersion: ASSIGNMENT_POLICY_VERSION, requirements: { departmentCode: "", category: "", requiredSkills: [], requiredEquipment: [], serviceArea: null }, selected: null, candidates: [], ineligible: [], consideredCount: 0, noEligibleWorker: true } };
  }

  // Complaint may be ASSIGNED here (not only RECEIVED) — the engine's
  // assignable statuses include it precisely so reassignment after a
  // rejection/escalation works.
  return assignComplaintAutomatically(assignment.complaintId, {
    trigger: "REASSIGN",
    excludedWorkerIds: [assignment.workerId],
    previousAssignmentId: assignment.id,
  });
}

/**
 * Worker accept — OFFERED → ACCEPTED. Identity comes from the session (never
 * from the client); transition guard enforces the lifecycle. Status update,
 * audit, and the ACCEPTED notification commit in one transaction.
 */
export async function acceptAssignment(user: SessionUser, assignmentId: string): Promise<{ status: string }> {
  const assignment = await prisma.assignment.findUnique({ where: { id: assignmentId } });
  if (!assignment) throw new ApiError(404, "Assignment not found");
  if (assignment.workerId !== user.id) throw new ApiError(403, "Only the assigned worker can accept this assignment");
  if (assignment.status !== "OFFERED") {
    throw new ApiError(409, `Assignment is ${assignment.status} and can no longer be accepted`);
  }
  await prisma.$transaction(async (tx) => {
    await tx.assignment.update({ where: { id: assignment.id }, data: { status: "ACCEPTED", respondedAt: new Date() } });
    await tx.agentActivity.create({
      data: {
        complaintId: assignment.complaintId,
        agent: "AssignmentAgent",
        action: "ASSIGNMENT_ACCEPTED",
        summary: `Worker accepted the assignment for complaint ${assignment.complaintId}`,
      },
    });
    await send(tx, {
      recipientId: user.id,
      type: "ASSIGNMENT_ACCEPTED",
      title: "Assignment accepted",
      body: "Start the work from your assignments list when you arrive on site.",
      complaintId: assignment.complaintId,
      assignmentId: assignment.id,
      dedupeKey: notificationKeys.assignmentAccepted(assignment.id),
    });
  });
  return { status: "ACCEPTED" };
}

export async function startAssignment(user: SessionUser, assignmentId: string): Promise<{ status: string }> {
  const assignment = await prisma.assignment.findUnique({ where: { id: assignmentId } });
  if (!assignment) throw new ApiError(404, "Assignment not found");
  if (assignment.workerId !== user.id) throw new ApiError(403, "Only the assigned worker can start this assignment");
  if (assignment.status !== "ACCEPTED") {
    throw new ApiError(409, `Assignment must be ACCEPTED before starting (currently ${assignment.status})`);
  }
  await prisma.$transaction(async (tx) => {
    await tx.assignment.update({ where: { id: assignment.id }, data: { status: "IN_PROGRESS", startedAt: new Date() } });
    await tx.complaint.update({ where: { id: assignment.complaintId }, data: { status: "IN_PROGRESS", startedAt: new Date() } });
    await send(tx, {
      recipientId: user.id,
      type: "ASSIGNMENT_STARTED",
      title: "Work started",
      body: "Mark the assignment complete when the work is finished.",
      complaintId: assignment.complaintId,
      assignmentId: assignment.id,
      dedupeKey: notificationKeys.assignmentStarted(assignment.id),
    });
  });
  return { status: "IN_PROGRESS" };
}

/**
 * Worker completes their work — IN_PROGRESS → COMPLETED. The complaint
 * moves to VERIFICATION (existing AI evidence-verification flow takes over
 * from there). Capacity is released because the status leaves the open set.
 * Status update, audit, timeline, and notification commit in one transaction.
 */
export async function completeAssignment(user: SessionUser, assignmentId: string): Promise<{ status: string }> {
  const assignment = await prisma.assignment.findUnique({ where: { id: assignmentId } });
  if (!assignment) throw new ApiError(404, "Assignment not found");
  if (assignment.workerId !== user.id) throw new ApiError(403, "Only the assigned worker can complete this assignment");
  if (assignment.status !== "IN_PROGRESS") {
    throw new ApiError(409, `Assignment must be IN_PROGRESS before completing (currently ${assignment.status})`);
  }
  await prisma.$transaction(async (tx) => {
    await tx.assignment.update({
      where: { id: assignment.id },
      data: { status: "COMPLETED", completedAt: new Date(), closedAt: new Date() },
    });
    await tx.complaint.update({ where: { id: assignment.complaintId }, data: { status: "VERIFICATION", submittedAt: new Date() } });
    await tx.agentActivity.create({
      data: {
        complaintId: assignment.complaintId,
        agent: "AssignmentAgent",
        action: "ASSIGNMENT_COMPLETED",
        summary: `Worker completed the assignment for complaint ${assignment.complaintId} — awaiting verification`,
      },
    });
    await tx.timelineEvent.create({
      data: {
        complaintId: assignment.complaintId,
        type: "ASSIGNMENT",
        actor: `worker:${user.name}`,
        title: "Work completed — submitted for verification",
      },
    });
    await send(tx, {
      recipientId: user.id,
      type: "ASSIGNMENT_COMPLETED",
      title: "Work submitted for verification",
      body: "Upload the resolution photo if you have not yet — verification confirms the fix.",
      complaintId: assignment.complaintId,
      assignmentId: assignment.id,
      dedupeKey: notificationKeys.assignmentCompleted(assignment.id),
    });
  });
  return { status: "COMPLETED" };
}

/**
 * overrideAssignment — official replaces the engine's pick (or assigns
 * manually on an unassigned complaint). The original decision row is closed
 * (CANCELLED / REASSIGNED), never rewritten; the new Assignment carries
 * mode=OVERRIDE with the official's reason.
 */
export async function overrideAssignment(
  official: SessionUser,
  complaintId: string,
  newWorkerUserId: string,
  reason: string
): Promise<{ kind: "OVERRIDE"; assignmentId: string; previousAssignmentId: string | null } | { kind: "NO_ELIGIBLE_WORKER" }> {
  if (official.role !== "OFFICIAL") throw new ApiError(403, "Only officials can override assignments");

  const complaint = await prisma.complaint.findUnique({
    where: { id: complaintId },
    include: { activeAssignment: true },
  });
  if (!complaint) throw new ApiError(404, "Complaint not found");
  if (["RESOLVED", "CLOSED"].includes(complaint.status)) {
    throw new ApiError(409, `Complaint is already ${complaint.status.toLowerCase()}`);
  }

  const worker = await prisma.user.findUnique({
    where: { id: newWorkerUserId },
    include: { workerProfile: true },
  });
  if (!worker || worker.role !== "WORKER" || !worker.workerProfile) {
    throw new ApiError(404, "Verified worker not found");
  }

  const previous = complaint.activeAssignment;
  if (previous) {
    const closedStatus = previous.status === "OFFERED" || previous.status === "ACCEPTED" ? "REASSIGNED" : "CANCELLED";
    await prisma.assignment.update({
      where: { id: previous.id },
      data: { status: closedStatus, closedAt: new Date() },
    });
  }

  const created = await prisma.assignment.create({
    data: {
      complaintId: complaint.id,
      workerId: worker.id,
      status: "OFFERED",
      mode: "OVERRIDE",
      policyVersion: "manual",
      previousAssignmentId: previous?.id ?? null,
      reason,
      decision: JSON.stringify({
        policyVersion: "manual",
        previousAssignmentId: previous?.id ?? null,
        previousWorkerId: previous?.workerId ?? null,
        overriddenBy: official.email,
      }),
    },
  });
  // Phase 3 notifications: the new worker receives the offer, the previous
  // worker (if any) learns the assignment moved on. Idempotent by dedupeKey.
  await send(prisma, {
    recipientId: worker.id,
    type: "ASSIGNMENT_OFFERED",
    title: `New assignment: ${complaint.refCode}`,
    body: `${complaint.category} in ${complaint.ward ?? "your service area"} — assigned by an official.`,
    complaintId: complaint.id,
    assignmentId: created.id,
    dedupeKey: notificationKeys.assignmentOffered(created.id),
  });
  if (previous && previous.workerId !== worker.id) {
    await send(prisma, {
      recipientId: previous.workerId,
      type: "OFFICIAL_OVERRIDE",
      title: `Assignment reassigned: ${complaint.refCode}`,
      body: "An official reassigned this complaint. No further action is needed from you.",
      complaintId: complaint.id,
      assignmentId: created.id,
      dedupeKey: notificationKeys.officialOverride(created.id),
    });
  }
  await prisma.complaint.update({
    where: { id: complaint.id },
    data: { activeAssignmentId: created.id, assignedToId: worker.id, status: "ASSIGNED", assignedAt: complaint.assignedAt ?? new Date() },
  });
  await prisma.agentActivity.create({
    data: {
      complaintId: complaint.id,
      agent: "AssignmentAgent",
      action: "OVERRIDE",
      summary: `Official ${official.email} overrode assignment for ${complaint.refCode} → ${worker.workerProfile.employeeId}`,
      detail: JSON.stringify({
        policyVersion: "manual",
        previousAssignmentId: previous?.id ?? null,
        previousWorkerId: previous?.workerId ?? null,
        previousStatus: previous?.status ?? null,
        newWorkerId: worker.id,
        newEmployeeId: worker.workerProfile.employeeId,
        reason,
        overriddenBy: official.email,
      }),
    },
  });
  await prisma.timelineEvent.create({
    data: {
      complaintId: complaint.id,
      type: "ASSIGNMENT",
      actor: `official:${official.name}`,
      title: `Assignment overridden → ${worker.workerProfile.employeeId}`,
      detail: reason,
    },
  });

  return { kind: "OVERRIDE", assignmentId: created.id, previousAssignmentId: previous?.id ?? null };
}

/** Total assignment count for a worker with open statuses (workload view). */
export async function activeAssignmentCountFor(workerUserId: string): Promise<number> {
  return prisma.assignment.count({
    where: { workerId: workerUserId, status: { in: ["OFFERED", "ACCEPTED", "IN_PROGRESS"] } },
  });
}

/** Open statuses shared by workload counting and the worker assignment list. */
export const OPEN_ASSIGNMENT_STATUSES = ["OFFERED", "ACCEPTED", "IN_PROGRESS"] as const;

/**
 * The authenticated worker's assignments — newest first. Session identity is
 * the ONLY selector; there is no client-controlled workerId. Active
 * assignments first-class: both open and historical rows are returned so the
 * worker sees their full record.
 */
export async function listMyAssignments(user: SessionUser) {
  const rows = await prisma.assignment.findMany({
    where: { workerId: user.id },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      complaint: {
        select: {
          id: true, refCode: true, title: true, description: true, category: true,
          severity: true, status: true, ward: true, lat: true, lng: true, address: true,
          slaDueAt: true, createdAt: true,
        },
      },
    },
  });
  return rows.map((a) => ({
    id: a.id,
    status: a.status,
    mode: a.mode,
    reason: a.reason,
    respondedAt: a.respondedAt?.toISOString() ?? null,
    startedAt: a.startedAt?.toISOString() ?? null,
    completedAt: a.completedAt?.toISOString() ?? null,
    closedAt: a.closedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    complaint: a.complaint,
  }));
}

/** One assignment for the authenticated worker (404 otherwise — no leak). */
export async function getMyAssignment(user: SessionUser, assignmentId: string) {
  const a = await prisma.assignment.findFirst({
    where: { id: assignmentId, workerId: user.id },
    include: {
      complaint: {
        select: {
          id: true, refCode: true, title: true, description: true, category: true, severity: true,
          status: true, ward: true, lat: true, lng: true, address: true, slaDueAt: true, createdAt: true,
        },
      },
    },
  });
  if (!a) throw new ApiError(404, "Assignment not found");
  return {
    id: a.id,
    status: a.status,
    mode: a.mode,
    reason: a.reason,
    previousAssignmentId: a.previousAssignmentId ?? null,
    respondedAt: a.respondedAt?.toISOString() ?? null,
    startedAt: a.startedAt?.toISOString() ?? null,
    completedAt: a.completedAt?.toISOString() ?? null,
    closedAt: a.closedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    complaint: a.complaint,
  };
}
