import { prisma } from "../db";
import { getVisionProvider, getLLMProvider, getResolutionVerifier } from "../ai";
import { computeSeverity, computePriority, slaDueAtFor, type SeverityResult, type PriorityResult } from "../severity";
import { findBestDuplicate, type DuplicateCandidate, type DuplicateMatch } from "../duplicate";
import { withUniqueRefCode } from "../refCode";
import { CATEGORY_DEPARTMENT, categoryLabels } from "../constants";
import { unavailableVerdict } from "../visionStates";
import type { VisionResult, LLMResult, ResolutionVerdict } from "../ai/types";

/**
 * Agent tools — each is a discrete capability the Orchestrator selects and
 * executes. Tools are pure-ish: they return structured results the
 * orchestrator turns into AgentActivity log entries.
 */

export type SlaSweepResult = {
  refCode: string;
  escalated: boolean;
  error?: string;
};

/** analyze_image — computer-vision detection of the civic issue. */
export async function analyzeImage(image: Buffer, mime: string, demoHint?: string): Promise<VisionResult> {
  const provider = getVisionProvider();
  try {
    return await provider.detect(image, mime, { demoHint });
  } catch (err) {
    // Production provider failed → fall back to the LABELED dev provider, never a silent fake.
    const dev = new (await import("../ai/devVision")).DevVisionProvider();
    const result = await dev.detect(image, mime, { demoHint });
    return {
      ...result,
      providerState: "DEV_HINT",
      note: `Primary vision provider (${provider.id}) failed: ${(err as Error).message}. ${result.note ?? ""}`.trim(),
    };
  }
}

/** classify_issue — LLM structured understanding of the complaint text. */
export async function classifyIssue(input: {
  description: string;
  visionCategory: string | null;
  visionConfidence: number | null;
  language: string;
}): Promise<LLMResult> {
  const provider = getLLMProvider();
  try {
    return await provider.reason(input);
  } catch (err) {
    const dev = new (await import("../ai/devLlm")).DevLLMProvider();
    const result = await dev.reason(input);
    return { ...result, reasoning: [`Primary LLM (${provider.id}) failed: ${(err as Error).message}`, ...result.reasoning] };
  }
}

/** calculate_severity — explainable severity scoring. */
export function calculateSeverity(category: string, description: string, visionConfidence?: number | null): SeverityResult {
  return computeSeverity(category, description, visionConfidence);
}

/** calculate_priority — queue priority 1..100. */
export function calculatePriority(severity: string, opts: { nearbyReports?: number; description?: string }): PriorityResult {
  return computePriority(severity, opts);
}

/** find_nearby_complaints — recent open complaints near a location.
 *  Phase 4: without coordinates there is no "nearby" — returns [] instead of
 *  pretending an origin. All stored rows may carry null lat/lng; the bounding
 *  box filter skips them. */
export async function findNearbyComplaints(
  lat: number | null,
  lng: number | null,
  category: string,
  radiusM = 150,
  windowHours = 72
) {
  if (lat == null || lng == null) return [];
  const since = new Date(Date.now() - windowHours * 3600_000);
  const rows = await prisma.complaint.findMany({
    where: {
      category,
      createdAt: { gte: since },
      status: { notIn: ["RESOLVED", "CLOSED", "REOPENED"] },
    },
    select: { id: true, refCode: true, category: true, description: true, lat: true, lng: true, createdAt: true },
    take: 200,
  });
  // Coarse pre-filter to a bounding box (~radius) before precise distance checks.
  const latDelta = radiusM / 111_320;
  const lngDelta = radiusM / (111_320 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return rows.filter(
    (r) => r.lat != null && r.lng != null && Math.abs(r.lat - lat) <= latDelta && Math.abs(r.lng - lng) <= lngDelta
  );
}

/** detect_duplicate — decides whether an existing report covers the same issue. */
export function detectDuplicate(
  incoming: { category: string; description: string; lat: number | null; lng: number | null; createdAt: Date },
  candidates: DuplicateCandidate[]
): DuplicateMatch | null {
  return findBestDuplicate(incoming, candidates);
}

/** find_department — routes a category to the responsible municipal department. */
export function findDepartment(category: string) {
  const code = CATEGORY_DEPARTMENT[category] ?? "GEN";
  const label = categoryLabels[category] ?? "Civic issue";
  const reasonByCode: Record<string, string> = {
    PWD: "Roads & infrastructure issues are handled by Public Works",
    SWM: "Waste-related issues are handled by Solid Waste Management",
    ELECT: "Lighting issues are handled by the Electricity department",
    WATER: "Waterlogging & drainage are handled by the Water department",
    HEALTH: "Sanitation health hazards are handled by Public Health",
    GEN: "General municipal issues are handled by the General department",
  };
  return { code, name: DEPARTMENT_NAMES[code], reason: reasonByCode[code], issueLabel: label };
}

export const DEPARTMENT_NAMES: Record<string, string> = {
  PWD: "Public Works Department",
  SWM: "Solid Waste Management",
  ELECT: "Electricity Department",
  WATER: "Water & Sewerage Department",
  HEALTH: "Public Health Department",
  GEN: "General Municipal Department",
};

/** create_complaint — persists the complaint with SLA clock started.
 *  Concurrency-safe reference codes: when `refCode` is omitted, the next
 *  unique code is allocated via the high-water-mark strategy (see refCode.ts)
 *  and retried on unique-violation races; the DB UNIQUE constraint on
 *  Complaint.refCode is the arbiter. An explicitly provided refCode (demo
 *  seeds/tests) is honored as-is and still surfaces unique violations. */
export async function createComplaint(data: {
  refCode?: string;
  title: string;
  description: string;
  category: string;
  severity: string;
  priority: number;
  lat: number | null;
  lng: number | null;
  address?: string;
  ward?: string;
  language: string;
  transcript?: string;
  originalText?: string;
  photoKey?: string;
  departmentCode: string;
  reporterId: string;
  aiConfidence?: number | null;
  aiSummary?: string | null;
  duplicateOfId?: string | null;
  source?: string;
  // Phase 4 geospatial metadata (see src/lib/location.ts).
  accuracyMeters?: number | null;
  locationSource?: string | null;
  locationCapturedAt?: Date | null;
}) {
  const sla = slaDueAtFor(data.severity);
  const department = await prisma.department.findUnique({ where: { code: data.departmentCode } });

  const insert = (refCode: string) =>
    prisma.complaint.create({
      data: {
        refCode,
        title: data.title,
        description: data.description,
        category: data.category,
        severity: data.severity,
        priority: data.priority,
        status: "RECEIVED",
        source: data.source ?? "CITIZEN",
        lat: data.lat,
        lng: data.lng,
        address: data.address,
        ward: data.ward,
        accuracyMeters: data.accuracyMeters ?? null,
        locationSource: data.locationSource ?? null,
        locationCapturedAt: data.locationCapturedAt ?? null,
        language: data.language,
        transcript: data.transcript,
        originalText: data.originalText,
        photoKey: data.photoKey,
        aiConfidence: data.aiConfidence,
        aiSummary: data.aiSummary,
        duplicateOfId: data.duplicateOfId,
        departmentId: department?.id,
        reporterId: data.reporterId,
        slaHours: sla.hours,
        slaDueAt: sla.dueAt,
      },
    });

  if (data.refCode) return insert(data.refCode);
  const { result } = await withUniqueRefCode(insert);
  return result;
}

/** assign_worker — official assigns a field worker. */
export async function assignWorker(complaintId: string, workerId: string) {
  const worker = await prisma.user.findUnique({ where: { id: workerId } });
  if (!worker || worker.role !== "WORKER") throw new Error("Invalid worker");
  return prisma.complaint.update({
    where: { id: complaintId },
    data: { assignedToId: workerId, status: "ASSIGNED", assignedAt: new Date() },
  });
}

/** notify_citizen — records an in-app notification as a timeline event.
 *  (Email/WhatsApp channels are pluggable extensions; see docs/ARCHITECTURE.md.) */
export function notifyCitizen(complaintId: string, title: string, detail?: string) {
  return prisma.timelineEvent.create({
    data: { complaintId, type: "NOTIFICATION", actor: "agent:DispatchAgent", title, detail },
  });
}

/**
 * check_sla — flags and escalates complaints past their SLA clock.
 *
 * Idempotent: the `isOverdue: false` filter means already-processed
 * complaints are never picked up again, so repeated sweeps (cron, dashboard
 * lazy sweep, demo trigger) do not double-escalate.
 *
 * Failure isolation: each complaint is processed independently — a failure
 * on one record is logged with its refCode and returned on that record's
 * result, but never aborts the sweep for the others. Errors are logged
 * without credentials or sensitive data.
 */
export async function checkSla(): Promise<SlaSweepResult[]> {
  const now = new Date();
  const overdue = await prisma.complaint.findMany({
    where: {
      slaDueAt: { lt: now },
      isOverdue: false,
      status: { in: ["RECEIVED", "ASSIGNED", "IN_PROGRESS", "VERIFICATION"] },
    },
    include: { department: true },
  });
  const results: SlaSweepResult[] = [];
  for (const c of overdue) {
    try {
      await prisma.complaint.update({ where: { id: c.id }, data: { isOverdue: true } });
      await prisma.timelineEvent.create({
        data: { complaintId: c.id, type: "SLA", actor: "agent:SLAAgent", title: "SLA breached — marked OVERDUE", detail: `Due ${c.slaDueAt?.toISOString()}` },
      });
      const escalate = c.severity === "CRITICAL" || c.severity === "HIGH" || c.status === "VERIFICATION";
      if (escalate) {
        await escalateComplaint(c.id, "SLA breached without resolution");
        results.push({ refCode: c.refCode, escalated: true });
      } else {
        results.push({ refCode: c.refCode, escalated: false });
      }
    } catch (err) {
      // Failure isolation: record, log safely (no secrets — refCode + message
      // only), and keep the sweep going for the remaining complaints.
      console.error(`[SLA sweep] failed to process complaint ${c.refCode}: ${(err as Error).message}`);
      results.push({ refCode: c.refCode, escalated: false, error: (err as Error).message });
    }
  }
  return results;
}

/** escalate_complaint — bumps escalation level and records history. */
export async function escalateComplaint(complaintId: string, reason: string) {
  const c = await prisma.complaint.findUnique({ where: { id: complaintId } });
  if (!c) throw new Error("Complaint not found");
  const level = c.escalationCount + 1;
  await prisma.escalation.create({ data: { complaintId, level, reason } });
  return prisma.complaint.update({
    where: { id: complaintId },
    data: { status: "ESCALATED", escalationCount: level },
  });
}

/** reopen_complaint — verification failed; citizen issue persists. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function reopenComplaint(complaintId: string, _reason: string) {
  const c = await prisma.complaint.findUnique({ where: { id: complaintId } });
  if (!c) throw new Error("Complaint not found");
  return prisma.complaint.update({
    where: { id: complaintId },
    data: { status: "REOPENED", reopenedCount: c.reopenedCount + 1, verified: false },
  });
}

/** close_complaint — terminal state after successful verification. */
export async function closeComplaint(complaintId: string) {
  return prisma.complaint.update({
    where: { id: complaintId },
    data: { status: "CLOSED", closedAt: new Date() },
  });
}

/** verify_resolution — AI checks the worker's after-image against the issue.
 *  Phase 4 failure honesty: when every provider fails to run, the verdict is
 *  an explicit UNAVAILABLE (fail-safe) — never a heuristic dressed up as a
 *  model decision and never an auto-approval. */
export async function verifyResolution(input: {
  category: string;
  originalDescription: string;
  beforeImage: Buffer | null;
  beforeMime: string | null;
  afterImage: Buffer;
  afterMime: string;
}): Promise<ResolutionVerdict> {
  const verifier = getResolutionVerifier();
  try {
    return await verifier.verify(input);
  } catch (err) {
    // Production verifier could not run at all → UNAVAILABLE is the honest
    // state. (The dev heuristic remains available to routes that explicitly
    // want a labeled heuristic opinion; the pipeline itself fails safe.)
    const unavailable = unavailableVerdict(
      `Verification unavailable — verifier (${verifier.id}) failed: ${(err as Error).message}`
    );
    return unavailable;
  }
}
