# CivicShield AI — Phase 3 Report: Notifications, Worker Operations, SLA Escalation

**Status: COMPLETE.** The Phase 2B assignment engine is now wrapped in a full
operational workflow: in-app notifications, worker accept/reject/start/complete,
SLA warning/breach/escalation, and official monitoring/intervention.

> Honesty labels are used throughout. **VERIFIED** = the command actually ran
> in this environment. **NOT TESTED** = blocked by the environment (no live
> PostgreSQL/Docker). **NOT IMPLEMENTED** = out of Phase 3 scope by design.

## 1. Executive Summary

Phase 3 turns assignment into a reliable operations lifecycle. Every domain
event now notifies the right people through a database-guaranteed idempotent
in-app notification system (`Notification` model with a UNIQUE `dedupeKey`).
The worker side gained a session-scoped assignment list/detail view and a
complete respond surface (accept → start → complete, or reject with bounded
auto-reassignment). The existing SLA cron was extended — not replaced — with an
assignment-level pass that derives operational SLA state from timestamps,
fires once-per-assignment warnings at 75% of the window, notifies worker +
officials on breach, and escalates + reassigns offers that were never accepted
before the deadline (L3), reusing the Phase 2B engine, budget, and escalation
machinery. Officials gained a typed override endpoint and SLA/escalation
visibility on the complaint detail API. 60 new tests cover the workflow; the
full suite is 216/216.

## 2. Architecture Changes

- **New domain modules**: `src/lib/notificationDomain.ts` (creation with
  dedupe, read lifecycle, provider seam), `src/lib/slaDomain.ts` (derived
  states + scheduled pass).
- **Concept separation preserved**: Assignment (operational state) /
  Notification (messages) / SLA state (derived, never stored) / AgentActivity
  (audit) — four concerns, no merged table.
- **Transactional coupling**: notification writes happen INSIDE the same
  transaction as the state change they describe (offer creation, accept,
  start, complete, reject close, breach marker) — no assigned-but-unnotified
  states.
- **Reassignment chain**: `Assignment.previousAssignmentId` (self-relation) is
  the single canonical link, set by engine re-runs, SLA reassignment, and
  official override alike.
- **Latent Phase 2B bug fixed (compatibility requirement)**:
  `ASSIGNABLE_STATUSES` did not include `ASSIGNED`, so a real rejection
  (complaint status ASSIGNED) could never be reassigned — masked in Phase 2B
  tests by RECEIVED fixtures. Now: `RECEIVED | ASSIGNED | REOPENED |
  ESCALATED`, with a regression test.

## 3. Notification Model

`Notification` (schema §3 of NOTIFICATION_SYSTEM.md): recipient relation,
explicit type tuple (`NOTIFICATION_TYPES` — 11 types from
ASSIGNMENT_OFFERED to SYSTEM), title/body, complaint + assignment relations,
`dedupeKey @unique` (nullable for always-create), optional `data` JSON,
`readAt`, `createdAt`, indexes `(recipientId, readAt)` and `(complaintId)`.

## 4. Notification Lifecycle

Created only from domain events:

| Event | Recipients | Type / dedupeKey |
|---|---|---|
| Assignment created (AUTO/MANUAL/OVERRIDE) | new worker | ASSIGNMENT_OFFERED / `assignment:offered:<id>` |
| Worker accepts | worker (confirmation) | ASSIGNMENT_ACCEPTED / `assignment:accepted:<id>` |
| Worker rejects | worker + all officials | ASSIGNMENT_REJECTED / `assignment:rejected:<id>`, `reject:official:<id>:<officialId>` |
| Engine reassignment | new worker | ASSIGNMENT_OFFERED (new assignment id) |
| Start / complete | worker | ASSIGNMENT_STARTED / ASSIGNMENT_COMPLETED |
| SLA warning (75%) | worker | SLA_WARNING / `sla:warning:<id>` |
| SLA breach | worker + officials | SLA_BREACH / `sla:breach:<id>`, `sla:breach:official:<id>:<officialId>` |
| Escalation (L3 / no-eligible / verification) | officials | ESCALATION / `escalation:<cid>:<lvl>[:<officialId>]`, `no-eligible:<cid>:<officialId>` |
| Official override | new + previous worker | ASSIGNMENT_OFFERED / OFFICIAL_OVERRIDE |

Read state: list + unread count, mark one, mark all — session-scoped only,
404 (not 403) for foreign notifications so existence never leaks; idempotent.

## 5. Assignment Workflow

`OFFERED → ACCEPTED → IN_PROGRESS → COMPLETED` (complaint: ASSIGNED →
IN_PROGRESS → VERIFICATION, where the existing AI verification flow takes
over) or `OFFERED → REJECTED → (engine re-run)`. Invalid transitions rejected
with 409: COMPLETED→ACCEPTED, REJECTED→ACCEPTED, REASSIGNED→ACCEPTED
(post-race guard), OFFERED→COMPLETED, ACCEPTED→COMPLETED (must start first),
ACCEPTED→START. Identity is always the session user; no client-controlled
workerId/userId/employeeId is accepted anywhere.

## 6. Accept/Reject Behavior

- **Accept** (`POST /api/assignments/:id/respond {action:"accept"}`): owner +
  OFFERED-only; status + audit (`ASSIGNMENT_ACCEPTED`) + confirmation
  notification in one transaction.
- **Reject** (`{action:"reject"}`): owner + OFFERED/ACCEPTED-only; close row
  REJECTED + respondedAt, clear pointer, audit, worker + official
  notifications — all one transaction; then budget check
  (MAX_AUTO_ATTEMPTS = 5 AUTO rows) and engine re-run with the rejector
  excluded and `previousAssignmentId` set. No eligible worker ⇒ explicit
  NO_ELIGIBLE_WORKER + official ESCALATION notification; officials can
  always override.

## 7. Reassignment Behavior

History is never overwritten: rows are closed (REJECTED/REASSIGNED/CANCELLED)
and new rows added. The chain is explicit via `previousAssignmentId` on the
new row (tested in the reject, SLA-L3, and override flows). Exclusions:
the rejector (reject flow) or the unresponsive worker (L3) are passed to the
engine as `excludedWorkerIds`; the Phase 2B attempt budget bounds the loop.

## 8. SLA Model

Derived by `slaStateFor` — RESOLVED > ESCALATED > BREACHED > WARNING >
ON_TRACK (first match wins; resolution outranks everything; a warning marker
never masks a real breach). No stored state; only idempotency markers
(`slaWarnedAt`/`slaBreachedAt`) persist. See SLA_ESCALATION.md.

## 9. SLA Thresholds Actually Used

- Window: existing `SLA_HOURS` severity policy (12/24/48/72 h) — **reused,
  not invented**.
- Warning: `SLA_WARNING_FRACTION = 0.75` of the window consumed (new,
  centralized in constants.ts, documented, tested).
- Breach: `slaDueAt` expiry (existing semantics, untouched).

## 10. Escalation Ladder

L0 assignment (engine) → L1 worker warning (75%) → L2 breach notifications
(worker + officials; complaint OVERDUE + HIGH/CRITICAL escalation via the
existing checkSla) → L3 escalate + reassign only if the assignment is still
OFFERED at breach (excluding the unresponsive worker, budget-bounded). No
supervisor role exists in this repository, so officials are the escalation
target — documented decision.

## 11. Cron Behavior

`GET/POST /api/cron/sla` runs BOTH passes concurrently: legacy
complaint-level `checkSla` (untouched) and Phase 3 `processAssignmentSla`.
Same timing-safe CRON_SECRET / OFFICIAL-session auth (existing tests still
pass). Response adds `warned`/`breached` counters and includes assignment
failures in `failed`/`ok`. No second scheduler; demo/stats lazy-sweep callers
keep their behavior (their call now also drains the assignment pass).

## 12. Idempotency

- Notifications: UNIQUE `dedupeKey` (DB-enforced); P2002 → silent no-op.
- Warnings/breaches: per-assignment markers + filtered queries + guarded
  update `where: { id, slaWarnedAt: null }`.
- Escalation: level-based dedupe keys; `escalateComplaint` remains
  once-per-breach via the existing isOverdue filter.
- Accept/reject/read actions themselves are guarded transitions (409/404 on
  repeat).

## 13. Concurrency Handling

Interactive transactions for every coupled write (Phase 2B pattern). The
complaint activeAssignment pointer + `@unique` remain the serialization point
for assignment. Accept-vs-escalation race: the accept guard re-reads status
and refuses REASSIGNED rows (409, tested). Sweeps are failure-isolated per
record. **Unit-tested orchestration only; physical PostgreSQL concurrency
(row locks, constraint races, atomicity) is NOT TESTED in this environment.**

## 14. Authorization Matrix

| Action | CITIZEN | WORKER | OFFICIAL |
|---|---|---|---|
| Accept/reject/start/complete assignment | 403 | owner-only (403/409 otherwise) | — |
| List/detail own assignments | 403 (requireUser; scoped by session) | own rows only | own session scope |
| List/read notifications | own only | own only | own only |
| Override / reassign | 403 | 403 | ✔ (audited) |
| Cron sweep | 401 | 401 | ✔ (or CRON_SECRET) |
| Alter SLA state | — | — | derived; nobody can set it |

All identity from the signed session (`requireUser`/`requireRole`); tested
for citizen/worker/other-worker guards on every new surface.

## 15. Audit Behavior

Every transition writes AgentActivity (ASSIGN, ASSIGNMENT_ACCEPTED,
ASSIGNMENT_COMPLETED, REJECT, OVERRIDE, NO_ELIGIBLE_WORKER) and/or complaint
timeline events, with notification delivery recorded by the Notification rows
themselves (who was notified, when, what, read when?). The full chain —
decision JSON, rejection, reassignment link, escalation, override detail —
remains reconstructible per complaint.

## 16. Provider Status

IN-APP = VERIFIED (unit level, mocked Prisma boundary). EMAIL / SMS / PUSH =
NOT IMPLEMENTED — no provider exists in the repository and none is faked;
`send()`/`sendMany()` are the future attachment seam.

## 17. Database Changes

- **NEW** `Notification` model (see §3) with relations to User/Complaint/
  Assignment and the `dedupeKey @unique` idempotency constraint.
- `Assignment`: + `previousAssignmentId` self-relation ("Reassignments",
  onDelete SetNull), + `slaWarnedAt`, + `slaBreachedAt`, + `notifications`
  back-relation. Indexes preserved; complaint-side behavior unchanged.
- `User.notifications`, `Complaint.notifications` back-relations.

## 18. Tests

New files (all unit, mocked Prisma, real domain logic):
- `tests/notifications.test.ts` — **16**: creation shape, P2002 dedupe
  (repeat event ⇒ no duplicate), non-dedupe error propagation, always-create
  null keys, sendMany batch + fallback, ownership-scoped list/unread/mark
  (foreign id ⇒ 404, indistinguishable from unknown), idempotent read
  marking, privacy payload contract, deterministic key uniqueness.
- `tests/workerWorkflow.test.ts` — **21**: accept guards (owner 200, other
  worker/citizen 403, ACCEPTED/REJECTED/REASSIGNED 409, 404), transactional
  accept + notification, start lifecycle rules, complete → VERIFICATION +
  capacity release, reject closing + notifications + rejector exclusion +
  chain link + ASSIGNED-status regression, budget exhaustion, no-eligible
  official notification, session-scoped list/detail views.
- `tests/slaEscalation.test.ts` — **14**: all five derived states, warning
  derived at 75% vs marker, breach authority, warning-never-masks-breach,
  L1 once-only, L2 worker+official notifications once-only, L3 escalate +
  reassign of never-accepted offers, L3 skips IN_PROGRESS, repeated-sweep
  idempotency, failure isolation, no-SLA skip.
- `tests/overrideAuth.test.ts` — **9**: OFFICIAL success (close + chain +
  audit detail), worker/citizen 403, unverified target 404, RESOLVED 409,
  original decision JSON untouched, both workers notified, same-worker
  re-pick has no self-override notification.

Existing suites: untouched assertions; `tests/sla.test.ts` gained one
additive mock line (the route now also drains the assignment pass) and the
shared prisma mock gained `notification` + `assignment.findMany` (additive).

## 19. Exact Test Results (actual runs, final code state)

| Command | Result |
|---|---|
| `npx vitest run` (full suite, 18 files) | **216/216 passed** |
| `npx vitest run tests/notifications.test.ts` | 16/16 |
| `npx vitest run tests/workerWorkflow.test.ts` | 21/21 |
| `npx vitest run tests/slaEscalation.test.ts` | 14/14 |
| `npx vitest run tests/overrideAuth.test.ts` | 9/9 |
| `npx tsc --noEmit` | PASS (exit 0) |
| `npm run lint` | PASS (exit 0, 0 warnings) |
| `npm run build` | PASS (exit 0; new routes present in manifest) |

## 20. Build/Lint/Typecheck Results

See §19 — all executed against the final code state after the last fix
(tsc was re-run after every type fix; the full suite was re-run after the
final edit).

## 21. Live DB/E2E Status

**NOT TESTED (environment blocker — no local PostgreSQL, no Docker):**
`prisma db push`, migrations, seeding, `scripts/smoke.mjs` E2E, live cron
endpoint integration, and physical verification of transaction atomicity,
unique-constraint behavior (incl. `Notification.dedupeKey` and
`Complaint.activeAssignmentId`), and row-lock concurrency. Nothing was
fabricated: unit tests prove orchestration, ordering, guards, and
idempotency logic against the mocked boundary, not physical DB semantics.

## 22. Known Limitations

1. Physical DB concurrency/atomicity unproven (see §21).
2. Officials are notified as a role-broadcast (per-official dedupe keys) —
   no on-call routing exists in the repository.
3. L3 triggers only for never-accepted offers; breached IN_PROGRESS work
   relies on official override (deliberate policy).
4. Sweep `take: 500` bound — very large backlogs drain over multiple runs.
5. Notification `data` metadata is write-only (not exposed via API) by
   privacy design.
6. `checkSla` remains complaint-level; a complaint whose assignment row is
   closed (e.g. completed) but clock breached is still flagged by the legacy
   pass — overlapping coverage is intentional defense-in-depth.

## 23. Explicitly Unimplemented (future phases)

Email/SMS/push delivery; worker mobile UI redesign; notification preferences;
on-call/supervisor routing; offer auto-expiry timers (L3 covers the breached-
offer case via cron); hotspot/predictive analytics; LLM-based assignment.

## 24. Phase 4 Readiness

Ready: complete operational lifecycle with per-event notifications and
idempotent scheduled processing; session-scoped worker APIs (assignments +
notifications) ready to back a dashboard UI; derived SLA state exposed on the
complaint API; audit trail reconstructs the full chain per complaint.
Natural next phases: notification UI (badge + list), worker dashboard on
`/api/worker/assignments`, a live-DB integration pass to convert §21 items
into VERIFIED, and delivery providers attached at the `send()` seam.
