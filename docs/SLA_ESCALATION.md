# CivicShield AI — SLA States & Escalation (Phase 3)

Implementation: `src/lib/slaDomain.ts` · Thresholds: `SLA_HOURS`,
`SLA_WARNING_FRACTION` in `src/lib/constants.ts`.

## SLA state is DERIVED, never stored

`slaStateFor(complaint, activeAssignment?, now)` computes the operational
state from authoritative timestamps on every read. There is no redundant
authoritative `slaState` column that could drift. The only persisted SLA
fields are per-assignment **idempotency markers** (`slaWarnedAt`,
`slaBreachedAt`) that guarantee once-per-assignment events — they never
override what the timestamps say.

| State | Condition (first match wins) |
|---|---|
| `RESOLVED` | complaint RESOLVED/CLOSED, `resolvedAt` set, or active assignment `completedAt` set |
| `ESCALATED` | complaint status ESCALATED with `escalationCount > 0` |
| `BREACHED` | `isOverdue` flag or `slaDueAt <= now` |
| `WARNING` | assignment warned marker, or ≥ 75% of the window consumed |
| `ON_TRACK` | otherwise |

Surfaced read-only via `GET /api/complaints/:id` (`slaState`,
`activeAssignment{id,status,mode}`).

## Thresholds — reused, not invented

- **Window**: the existing severity policy `SLA_HOURS` (CRITICAL 12 h,
  HIGH 24 h, MEDIUM 48 h, LOW 72 h) → `slaDueAt = createdAt + hours`
  (unchanged Phase 1 behavior).
- **Warning**: `SLA_WARNING_FRACTION = 0.75` of the window consumed. One
  constant, centralized, tested.

## Escalation ladder (deterministic)

| Level | Trigger | Action |
|---|---|---|
| L0 | engine assignment created | worker notified (`ASSIGNMENT_OFFERED`) — Phase 2B |
| L1 | ≥ 75% of window consumed | once-per-assignment `SLA_WARNING` → worker |
| L2 | window expired | once-per-assignment `SLA_BREACH` → worker + all officials; complaint-level OVERDUE flag and HIGH/CRITICAL escalation stay in the **existing** `checkSla` (one breach pipeline, no duplication) |
| L3 | breach while the assignment is still `OFFERED` (worker never responded for the entire window) | complaint escalated via the existing `escalateComplaint` (officials notified, level-dedupe key), stale offer closed `REASSIGNED` (history preserved), engine re-runs excluding the unresponsive worker, bounded by the Phase 2B `MAX_AUTO_ATTEMPTS` (5) budget |

L3 deliberately **skips** ACCEPTED/IN_PROGRESS work — the worker may be on
site; those cases are handled by officials via `POST /api/complaints/:id/
override`. A breached complaint is never auto-closed and the worker is never
silently removed without an audit trail.

## Scheduled processing

`processAssignmentSla()` runs in the existing cron route
(`GET/POST /api/cron/sla`, same CRON_SECRET/OFFICIAL auth, `checked /
escalated / warned / breached / failed / ok` result semantics) **alongside**
the legacy complaint-level `checkSla` — no second scheduler exists.

- **Idempotent**: marker filters + dedupe keys mean repeated sweeps
  (12:00, 12:15, 12:30 …) never re-warn, re-breach, re-escalate, or spam.
- **Failure-isolated**: one broken assignment records its error on its own
  result and never aborts the sweep.
- **Bounded**: `take: 500` per run; the next sweep picks up the rest.

## Concurrency honesty

Marker updates and their notifications are written in one transaction, and
the dedupe-key UNIQUE constraint backstops races (e.g. worker accept racing
the sweep: the accept's status guard re-checks the row, and a closed
assignment refuses stale transitions with 409). **Unit-tested orchestration
only — physical PostgreSQL concurrency (row locks, constraint races) is NOT
TESTED in this environment** (no live DB; see PHASE3_REPORT.md §21).
