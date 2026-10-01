# CivicShield AI — Phase 2B Report: Automatic Worker Assignment Engine

**Status: COMPLETE.** Deterministic, explainable, no-LLM automatic assignment on
top of the Phase 2A worker domain.

> **What this is:** a deterministic policy engine. **What this is not:** an LLM,
> a notification system, a worker UI, or an analytics platform. Worker selection
> involves no language model, no randomness, and no external AI calls — see
> [ASSIGNMENT_ENGINE.md](./ASSIGNMENT_ENGINE.md) for the full policy.

## 1. Executive Summary

Phase 2B replaces the manual-only assignment decision with a deterministic
assignment service. `assignComplaintAutomatically` runs inside one Prisma
interactive transaction: it derives complaint requirements from a maintained
category→capability table, hard-filters candidates for eligibility (availability,
department, skills, equipment, capacity, service area, exclusion list), scores
only the eligible pool with a documented 7-factor weighted formula (total 100),
and selects the winner via a stable tie-break (score DESC → distance ASC →
employeeId ASC). Zero eligible candidates yields an explicit
`NO_ELIGIBLE_WORKER` outcome with the complaint safely unassigned and the
reasons audited. Workers reject via a respond endpoint, which closes the old row
(preserving history), enforces a 5-attempt reassignment budget, and re-runs the
engine excluding the rejector. Officials can override any non-terminal
assignment with a new `OVERRIDE`-mode row and a required reason. Every decision
persists structured JSON sufficient to reconstruct why that worker was selected.

## 2. Files Changed

| File | Change |
|---|---|
| `prisma/schema.prisma` | **Assignment model** (lifecycle statuses, AUTO/MANUAL/OVERRIDE modes, `policyVersion`, `decision` JSON, `reason`, lifecycle timestamps, indexes); `Complaint.activeAssignmentId @unique` + `activeAssignment` relation; `User.assignments` back-relation |
| `src/lib/assignmentDomain.ts` | **NEW (~580 lines)** — engine core: requirements mapping, eligibility, scoring, ranking, `assignComplaintAutomatically`, `rejectAssignment`, `acceptAssignment`, `startAssignment`, `overrideAssignment`, `activeAssignmentCountFor` |
| `src/app/api/complaints/[id]/auto-assign/route.ts` | **NEW** — `POST`, OFFICIAL-only manual retry of the engine |
| `src/app/api/assignments/[id]/respond/route.ts` | **NEW** — `POST`, assigned worker `accept` / `reject` / `start` |
| `src/app/api/complaints/[id]/assign/route.ts` | Manual-assign made compatible: closes open assignment `REASSIGNED`, creates MANUAL row, sets pointer, audits `MANUAL_ASSIGN` |
| `src/lib/agent/orchestrator.ts` | Step 9: non-blocking auto-assign at intake; `OrchestrationResult.autoAssignment` typed |
| `tests/helpers/prisma-mock.ts` | Additive `assignment` mock block (findUnique/findFirst/create/update/count/groupBy) |
| `tests/assignmentPolicy.test.ts` | **NEW** — 24 unit tests (requirements table, eligibility gates, scoring, tie-break, normalization) |
| `tests/assignmentEngine.test.ts` | **NEW** — 21 service-layer tests (selection, explanation payloads, NO_ELIGIBLE_WORKER, guards, reject→reassign, budget, override, concurrency guard) |
| `docs/ASSIGNMENT_ENGINE.md` | **NEW** — engine policy documentation |
| `docs/PHASE2B_REPORT.md` | **NEW** — this report |
| `README.md` | Test counts updated |

## 3. Assignment Schema

```
model Assignment {
  id            String   @id @default(cuid())
  complaintId   String
  workerId      String               // User.id
  status        String               // OFFERED|ACCEPTED|IN_PROGRESS|COMPLETED|REJECTED|CANCELLED|REASSIGNED
  mode          String               // AUTO|MANUAL|OVERRIDE
  policyVersion String?              // "2026-09-29.1" (AUTO) | "manual"
  decision      Json?                // full explainability payload
  reason        String?
  respondedAt   DateTime?
  startedAt     DateTime?
  completedAt   DateTime?
  closedAt      DateTime?
  createdAt/updatedAt
  complaint     Complaint @relation(...)
  worker        User      @relation(...)
  @@index([complaintId])
  @@index([workerId, status])
  @@index([status])
}
```

- `Complaint.activeAssignmentId String? @unique` — at most one open assignment
  per complaint **at the database level**; back-relation `activeAssignment`
  (relation named `"ActiveAssignment"` on both sides).
- `User.assignments` — worker's full assignment history.
- Lifecycle states follow the phase spec, using the repo's validated-string
  convention (`ASSIGNMENT_STATUS` / `ASSIGNMENT_MODES` tuples in
  `assignmentDomain.ts`).
- **History is preserved**: reassignment/override *close* old rows
  (REASSIGNED/CANCELLED/REJECTED) and insert new ones; nothing is overwritten.

## 4. Eligibility Rules

Hard gates, evaluated **before** scoring — a failing worker can never be rescued
by a high score (documented example: wrong-department worker who is close and
idle ⇒ INELIGIBLE, not scored):

1. **Not excluded** — rejector is excluded from the reassignment round.
2. **Available** — `availability === "AVAILABLE"` (blocks OFF_DUTY/SUSPENDED).
3. **Department** — `departmentId` must equal the complaint department **code**
   (repo convention: `WorkerProfile.departmentId` stores `Department.code`).
4. **Skills** — all skills from the category requirements table present.
5. **Equipment** — all required equipment present.
6. **Capacity** — open assignments (`OFFERED/ACCEPTED/IN_PROGRESS`) below
   `maxActiveAssignments`.
7. **Service area** — complaint ward covered when both ward and declared areas
   are known.

Availability + department are pushed into SQL; the rest is evaluated in-memory
over the bounded pool with every failure reason recorded into the audit payload.

## 5. Scoring Formula

`score = Σ factor_points`, each factor normalized 0..1 then weighted:

```
skills      25 × covered/required skills          (1.0 when none required)
equipment   15 × covered/required equipment       (1.0 when none required)
serviceArea 15 × (ward covered ? 1 : 0)           (1 when ward unknown / none declared)
workload    15 × (1 − active/maxActive)           clamped 0..1
distance    15 × max(0, 1 − d/10 000 m)           0.5 neutral when no coordinates
capacity    10 × (maxActive − active)/maxActive
urgency      5 × min(1, SLA-consumed/0.75)        1.0 on breach; 0 without SLA
```

Total = 100. Full per-factor breakdown (`points/max/note`) is stored for the
winner and reflected in `candidates[]`. Distance uses the existing
`haversineMeters` helper between `WorkerProfile.base*` and complaint
coordinates.

## 6. Weight Justification

Initial deterministic policy — **not empirically optimized** (and documented as
such in the code and engine doc):

- **Skills + equipment (40)** — capability dominates: an incapable worker
  generates rework and repeat dispatches.
- **Service area, workload, distance (15 each)** — equal operational weight for
  locality, team fairness, and travel time; no data justifies ranking one over
  the others.
- **Capacity (10)** — mild preference for headroom spreads load instead of
  concentrating it on the strongest single worker.
- **Urgency (5)** — deliberately tiny: dispatch order is the wrong lever for
  urgency (SLA escalation is a separate phase); a large urgency term would
  distort capability ranking. Urgency saturation at 75 % of the window; breach
  ⇒ 1.0.

## 7. Deterministic Tie-Breaking

`rankCandidates`: **score DESC → distance ASC (nulls last) → employeeId ASC**
(unique, stable). No randomness anywhere in the pipeline; the same inputs
always produce the same selection. Verified by dedicated policy tests (equal
scores → closer worker; equal distance → lexicographic employeeId).

## 8. Assignment Lifecycle

```
OFFERED → ACCEPTED → IN_PROGRESS → COMPLETED
   │ reject    │ start (complaint → IN_PROGRESS too)
   ▼           ▼
REJECTED   (respond route, worker-only, non-terminal-only)
   └→ engine re-run (REASSIGN trigger, rejector excluded, budget 5 AUTO rows)
OVERRIDE / MANUAL reassign → previous row REASSIGNED (OFFERED/ACCEPTED)
  or CANCELLED (other states), new row OFFERED
```

- Worker transitions guarded: only the assigned worker (403), only valid source
  status (409).
- `startAssignment` mirrors complaint status to `IN_PROGRESS` + `startedAt`.
- Complaint side: ASSIGNED (`activeAssignmentId`, `assignedToId`, `assignedAt`)
  on offer creation.

## 9. Reassignment Behavior

`rejectAssignment`: closes row as `REJECTED` + `respondedAt` (history kept) →
audits `REJECT` + timeline → clears `activeAssignmentId` → checks the budget
(**max 5** total AUTO assignments per complaint; exceeding stops with an audited
`NO_ELIGIBLE_WORKER` "manual intervention required") → re-runs the engine with
`trigger: REASSIGN` and the rejector in `excludedWorkerIds`. The rejector is a
hard-ineligible candidate for that round — verified by test
(`u_worker` rejects, `DEMO-PWD-002` is selected).

## 10. Official Override

`overrideAssignment`: OFFICIAL-only (403); target must be a verified WORKER
(404); complaint must not be RESOLVED/CLOSED (409). Previous active row closed
(REASSIGNED for OFFERED/ACCEPTED, else CANCELLED) with `closedAt` — its
`decision` JSON never modified. New row: `mode OVERRIDE`,
`policyVersion "manual"`, required `reason`. Audited `OVERRIDE` with detail
`{ policyVersion: "manual", previousAssignmentId, previousWorkerId,
previousStatus, newWorkerId, newEmployeeId, reason, overriddenBy }` + timeline.
Also usable to manually dispatch a `NO_ELIGIBLE_WORKER` complaint.

## 11. Audit Trail

Every action → `AgentActivity` (agent `AssignmentAgent`) + complaint timeline:
`ASSIGN` (full decision JSON), `NO_ELIGIBLE_WORKER` (ineligibility reasons or
budget exhaustion), `REJECT`, `OVERRIDE`, plus `MANUAL_ASSIGN` on the legacy
manual route. Decision payloads persist `policyVersion`, requirements, ranked
candidates, ineligible-with-reasons, full winner breakdown — a senior engineer
can reconstruct any selection from the stored JSON alone.

## 12. Concurrency Handling

- Auto-assign runs in **one Prisma interactive transaction**.
- **Complaint row = serialization point**: re-read INSIDE the transaction;
  `activeAssignmentId` non-null ⇒ `ALREADY_ASSIGNED` (guards
  NOT_ASSIGNABLE/404 the same way). Outside reads are never trusted.
- `Assignment` insert + complaint pointer update commit atomically;
  `activeAssignmentId` is `@unique` in the schema, making two concurrent
  committed active assignments for one complaint impossible at the DB level.
- The orchestrator call is non-blocking and failures degrade to manual
  assignment paths (intake never fails because of assignment).

## 13. Performance Considerations

Two candidate queries total regardless of pool size: one
`workerProfile.findMany` (department + availability in SQL) + one
`assignment.groupBy` for open-assignment counts (no N+1). Scoring is O(pool ×
factors) in memory. Writes per assignment: 1 insert + 1 complaint update + 1
audit + 1 timeline. No premature infrastructure; correctness first.

## 14. Tests Added

- `tests/assignmentPolicy.test.ts` — **24 tests**: `CATEGORY_REQUIREMENTS`
  mapping completeness, `requirementsForComplaint` fallbacks, every eligibility
  gate individually + combined, score breakdown shape/weights/sum, distance
  neutral-0.5 for missing coordinates, urgency saturation/breach/no-SLA,
  tie-break ordering, determinism.
- `tests/assignmentEngine.test.ts` — **21 tests** (mocked Prisma, real domain
  logic): best-candidate selection + writes in one transaction; decision detail
  structure (requirements, ranked candidates, 7-factor breakdown); OTHER/GEN
  no-demands path; empty pool → NO_ELIGIBLE_WORKER audited, complaint untouched;
  per-gate ineligibility reasons recorded; NOT_ASSIGNABLE / ALREADY_ASSIGNED /
  404 guards; reject guards (403/409); reject→history preserved→re-run excluding
  rejector; budget exhaustion (5) stops the engine; accept/start lifecycle;
  override guards (403/404/409), previous row closed not deleted, OVERRIDE row +
  audit with `previousAssignmentId`/`overriddenBy`; **concurrency test** —
  in-transaction re-read observes a concurrent winner and refuses the double
  assignment (read proven to occur after `$transaction` begins, no create/no
  pointer update).

## 15. Exact Test Results (actual runs, this environment)

| Command | Result |
|---|---|
| `npx vitest run tests/assignmentPolicy.test.ts` | **24/24 passed** |
| `npx vitest run tests/assignmentEngine.test.ts` | **21/21 passed** |
| `npx vitest run` (full suite) | **156/156 passed (14 files)** — 111 Phase 2A baseline + 24 policy + 21 engine |
| `npx tsc --noEmit` | **PASS** (exit 0) |
| `npm run lint` (eslint) | **PASS** (exit 0) |
| `npm run build` (production) | **PASS** (exit 0) |
| `npx prisma validate` | **PASS** ("The schema at prisma\schema.prisma is valid") |
| `npx prisma generate` | **PASS** (client generated) |

## 16. DB Commands Actually Executed

- `npx prisma validate` — executed, passed.
- `npx prisma generate` — executed, passed.
- **NOT TESTED** (no live PostgreSQL in this environment — no local Postgres,
  no Docker): `prisma db push`, `prisma migrate`, `demo:reset` seeding,
  integration/E2E tests against a real database, live verification of the
  unique-constraint behavior, interactive-transaction atomicity, and
  `scripts/smoke.mjs`. **Nothing was fabricated**: unit tests prove
  orchestration, ordering, and guard logic against the mocked client, not
  physical transaction semantics.

## 17. Known Limitations

1. Weights and the category→capability table are initial engineering policy,
   not tuned against real outcomes.
2. Transaction atomicity / unique-constraint races verified only logically
   (mocked client) — physical behavior unproven until a live-DB integration run.
3. Reassignment budget counts only AUTO rows; MANUAL/OVERRIDE rows are
   unlimited (by design, but undocumented behavior for mixed flows).
4. An unanswered OFFERED occupies a worker's capacity until rejected/overridden
   (no offer expiry in scope).
5. Distance uses the worker's base location, not live position; service-area
   match is exact ward-string equality.
6. Engine synchronous and non-blocking at intake; no queue/retry backoff.
7. Category table must be extended manually for new complaint categories
   (unknown categories safely require nothing).

## 18. Explicitly Unimplemented (future phases)

Per phase scope — **NOT IMPLEMENTED**, deliberately:

- Notifications of any kind (email/SMS/push) for offers, rejections, overrides.
- Worker dashboard/UI for accept-reject-start flows (API exists: respond route).
- SLA escalation changes; escalation-triggered reassignment beyond the existing
  status gate (`ESCALATED` is assignable, but escalation logic untouched).
- Hotspot prediction, dynamic priority, advanced analytics.
- Offer expiry / auto-timeout of unanswered offers.
- LLM-based assignment (permanently out of scope for this engine).

## 19. Phase 3 Readiness

Ready: stable assignment rows with full history + explainability payloads;
worker availability/capacity queryable; respond API for worker actions;
override API for officials; `activeAssignmentCountFor` for workload views;
policy-version stamping enables future weight re-tuning and A/B evaluation;
audit trail covers every transition. Natural Phase 3 candidates: notifications
on OFFERED/REJECTED/REASSIGNED, worker UI on the respond API, offer expiry,
and a live-DB integration pass (docker-compose Postgres) to convert the
NOT TESTED items above into VERIFIED.
