import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { checkSla } from "@/lib/agent/tools";
import { processAssignmentSla } from "@/lib/slaDomain";
import { jsonError } from "@/lib/api";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET/POST /api/cron/sla — scheduled SLA sweep (see vercel.json).
 *
 * Runs BOTH passes:
 *  1. Legacy complaint-level breach handling (OVERDUE flag, timeline, HIGH/
 *     CRITICAL escalation) — untouched Phase 1 machinery.
 *  2. Phase 3 assignment-level pass (processAssignmentSla): once-per-
 *     assignment SLA_WARNING at 75% of the window, SLA_BREACH notification,
 *     and L3 reassignment of offers never accepted before breach.
 *
 * Auth (either):
 *  1. `Authorization: Bearer $CRON_SECRET` — the format Vercel Cron sends
 *     natively when CRON_SECRET is configured as an environment variable.
 *  2. `x-cron-secret: $CRON_SECRET` — for external schedulers
 *     (EventBridge, GitHub Actions, curl, uptime monitors).
 *  3. A signed OFFICIAL session (manual sweeps from the app).
 *
 * Comparison is timing-safe (never short-circuits on the first mismatched
 * byte) and the secret value is never echoed in any response.
 */
function secretMatches(received: string | null): boolean {
  const expected = process.env.CRON_SECRET ?? "";
  if (!expected || received == null || received.length === 0) return false;
  const a = Buffer.from(received, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false; // length itself is not secret-critical
  return timingSafeEqual(a, b);
}

async function run(req: Request) {
  const bearer = req.headers.get("authorization");
  const bearerToken = bearer?.startsWith("Bearer ") ? bearer.slice(7).trim() : null;
  const headerToken = req.headers.get("x-cron-secret");

  const okBySecret = secretMatches(bearerToken) || secretMatches(headerToken);
  if (!okBySecret) {
    const { requireRole } = await import("@/lib/auth");
    try {
      await requireRole(req, "OFFICIAL");
    } catch {
      return jsonError(401, "Unauthorized SLA sweep");
    }
  }

  // Both sweeps are idempotent and failure-isolated per record (see
  // tools.ts / slaDomain.ts): already-processed items are filtered by their
  // markers before any write, per-record failures are returned on that
  // record's result instead of aborting the sweep.
  const [results, assignmentResults] = await Promise.all([checkSla(), processAssignmentSla()]);
  const failures = [...results, ...assignmentResults].filter((r) => "error" in r && r.error);
  return NextResponse.json({
    sweptAt: new Date().toISOString(),
    checked: results.length + assignmentResults.length,
    escalated:
      results.filter((r) => r.escalated).length +
      assignmentResults.filter((r) => r.action === "escalated").length,
    warned: assignmentResults.filter((r) => r.action === "warning").length,
    breached: assignmentResults.filter((r) => r.action === "breach").length,
    failed: failures.length,
    ok: failures.length === 0,
  });
}

export const GET = run;
export const POST = run;
