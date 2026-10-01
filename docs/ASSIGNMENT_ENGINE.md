# CivicShield AI — Automatic Assignment Engine (Phase 2B)

The engine that decides **which verified worker gets a complaint** — deterministic,
explainable, and fully audited.

> **This is a deterministic policy engine, NOT an LLM.** No language model, no
> `Math.random()`, no external AI call participates in the selection decision.
> For the same complaint state + worker state + policy version, the engine
> always produces the same result. All weights below are an initial
> deterministic policy chosen by engineering judgment — they are **not**
> empirically optimized.

Implementation: `src/lib/assignmentDomain.ts` (single file, ~580 lines).
Policy version: **`2026-09-29.1`** (`ASSIGNMENT_POLICY_VERSION`, stamped on
every AUTO assignment row and every decision payload).

---

## 1. Architecture

```
Complaint (RECEIVED / REOPENED / ESCALATED)
   │
   ▼
assignComplaintAutomatically(complaintId, { trigger })      ── inside ONE Prisma
   │                                                            interactive tx
   ├─ 1. Re-read complaint INSIDE the transaction  ← serialization point
   │      (guards: 404 · NOT_ASSIGNABLE · ALREADY_ASSIGNED)
   ├─ 2. requirementsForComplaint()  — deterministic category → capabilities map
   ├─ 3. loadCandidatePool()         — 1 findMany + 1 groupBy (no N+1)
   ├─ 4. checkEligibility()          — HARD gates, evaluated BEFORE any scoring
   ├─ 5. scoreCandidate()            — only eligible workers, full breakdown
   ├─ 6. rankCandidates()            — deterministic sort with stable tie-break
   ├─ 7. zero eligible? → NO_ELIGIBLE_WORKER (audit + timeline, stays unassigned)
   └─ 8. Assignment row (OFFERED/AUTO) + complaint pointer + audit + timeline
          → committed atomically
```

Entry points:

| Trigger | Caller | Where |
|---|---|---|
| `INTAKE` | Orchestrator step 9 (non-blocking — never fails intake) | `src/lib/agent/orchestrator.ts` |
| `MANUAL_RETRY` | `POST /api/complaints/[id]/auto-assign` (OFFICIAL-only) | `src/app/api/complaints/[id]/auto-assign/route.ts` |
| `REASSIGN` | Engine re-run after a worker rejection | `rejectAssignment()` |

The engine returns an explicit outcome — it never invents a fallback:

```ts
type AssignmentOutcome =
  | { kind: "ASSIGNED"; assignmentId; workerId; employeeId; score; detail }
  | { kind: "NO_ELIGIBLE_WORKER"; detail }
  | { kind: "ALREADY_ASSIGNED"; assignmentId }
  | { kind: "NOT_ASSIGNABLE"; reason };
```

## 2. Assignment model & lifecycle

`Assignment` (`prisma/schema.prisma`) connects `Complaint → Assignment →
User/WorkerProfile` and preserves **full history**: reassignment adds a new row
and closes the old one — previous rows are never overwritten or deleted.

```
OFFERED ──accept──▶ ACCEPTED ──start──▶ IN_PROGRESS ──▶ COMPLETED
   │                                              (worker/respond route)
   ├──reject──▶ REJECTED  (respondedAt stamped) → engine re-run (see §7)
   ├──official override──▶ REASSIGNED (was OFFERED/ACCEPTED) or CANCELLED
   └──manual reassign──▶ REASSIGNED
```

- `status`: `OFFERED | ACCEPTED | IN_PROGRESS | COMPLETED | REJECTED | CANCELLED | REASSIGNED`
- `mode`: `AUTO` (engine) · `MANUAL` (existing assign route) · `OVERRIDE` (official override)
- `policyVersion`: engine version, or `"manual"` for human decisions
- `decision`: structured JSON explaining the pick (see §6)
- `reason`: human-readable trigger reason
- Timestamps: `respondedAt`, `startedAt`, `completedAt`, `closedAt`
- Active pointer: `Complaint.activeAssignmentId` (`@unique`), back-relation
  `activeAssignment` — at most one open assignment per complaint, enforced by
  the database.

## 3. Required capabilities (deterministic mapping)

Complaint triage metadata currently provides **department + category only**;
no skill/equipment extraction exists upstream. The engine therefore uses the
following **deterministic policy table** (`CATEGORY_REQUIREMENTS`). It is a
maintained lookup, not AI output, and must not be presented as such.

| Category | Required skills | Required equipment |
|---|---|---|
| `POTHOLE`, `ROAD_DAMAGE` | `ROAD_REPAIR` | `DRILL` |
| `WATERLOGGING` | `DRAINAGE_CLEARING` | `WATER_PUMP` |
| `WASTE_OVERFLOW` | `WASTE_COLLECTION` | `COMPACTOR_TRUCK` |
| `STREETLIGHT` | `ELECTRICAL_REPAIR` | `POLE_TRUCK` |
| `GARBAGE` | `WASTE_COLLECTION` | — |
| `OTHER` (and unknown) | — | — (no hard demands) |

Department comes from the complaint's `department.code` (falls back to `"GEN"`),
service area from the complaint's `ward`. Skill/equipment tokens match the
Phase 2A taxonomies on `WorkerProfile.skills[]` / `WorkerProfile.equipment[]`.

## 4. Eligibility (hard gates — separate from scoring)

Eligibility (`checkEligibility`) is evaluated **before** any scoring. A worker
who fails any hard check is recorded as ineligible with reasons and can never
be rescued by a high score — even a perfectly positioned, idle worker from the
wrong department is INELIGIBLE, full stop.

| # | Hard gate | Fails when |
|---|---|---|
| 1 | Not excluded | `userId ∈ excludedWorkerIds` (e.g. just rejected) |
| 2 | Available | `availability !== "AVAILABLE"` (OFF_DUTY / SUSPENDED) |
| 3 | Department | `departmentId !== requirements.departmentCode` (dept mismatch) |
| 4 | Skills | missing any required skill |
| 5 | Equipment | missing any required equipment |
| 6 | Capacity | `activeAssignments ≥ maxActiveAssignments` |
| 7 | Service area | complaint has a ward, worker declares areas, and none covers it |

Gates 2, 3 are pre-filtered in SQL (`loadCandidatePool` queries only
`AVAILABLE` profiles of the required department); the remaining gates are
evaluated in-memory over that bounded per-department pool, and every failure
reason is preserved for the audit payload. Active-assignment counts come from a
single `assignment.groupBy` over the pool (open statuses `OFFERED / ACCEPTED /
IN_PROGRESS`) — no per-worker queries, no N+1.

## 5. Scoring (eligible candidates only)

Each factor is normalized to 0..1, multiplied by its weight, and recorded as a
line item `{ factor, points, max, note }`. Total = 100.

| Factor | Weight | Normalization |
|---|---|---|
| `skills` | 25 | covered required skills / total required skills (1.0 if none required) |
| `equipment` | 15 | covered required equipment / total required equipment |
| `serviceArea` | 15 | 1.0 if the worker covers the complaint ward (or ward unknown / worker declares none) |
| `workload` | 15 | `1 − active/maxActiveAssignments`, clamped 0..1 — lighter load wins |
| `distance` | 15 | linear `1 − d/10 000 m`; **0.5 (neutral) when the worker has no coordinates** |
| `capacity` | 10 | remaining slots / max slots — extra credit for headroom |
| `urgency` | 5 | fraction of the SLA window consumed, saturated at 75%; 1.0 when breached; 0 when no SLA clock |

**Weight rationale** (initial policy, not empirical): capability (skills +
equipment = 40) dominates because an incapable worker produces rework;
service area, workload, and distance (15 each) are the operational balancers —
locality, fairness across the team, and travel time carry equal weight; capacity
(10) mildly prefers workers with headroom so load spreads instead of
concentrating; urgency (5) is intentionally tiny — the **dispatch order is the
wrong lever for urgency** (priority/SLA escalation is a separate concern) and a
big urgency term would only distort capability ranking.

Notable normalization choices:

- **Distance**: `MAX_DISTANCE_M = 10 000` is the service radius beyond which
  proximity contributes 0. Workers without `baseLat/baseLng` get the neutral
  0.5 rather than being penalized for missing metadata — distance is a soft
  factor, not a hard gate (eligibility already covers area coverage).
- **Urgency**: `URGENCY_SATURATION = 0.75` — the factor tops out once 75 % of
  the SLA window is consumed; breach ⇒ 1.0. Units are window-relative (dueAt −
  createdAt), so it behaves identically for 4 h and 24 h SLAs.

## 6. Explainable decision

Every AUTO assignment stores the full decision as structured JSON in
`Assignment.decision` and `AgentActivity.detail`:

```json
{
  "policyVersion": "2026-09-29.1",
  "requirements": { "departmentCode": "PWD", "category": "POTHOLE",
                    "requiredSkills": ["ROAD_REPAIR"], "requiredEquipment": ["DRILL"],
                    "serviceArea": "Ward 1" },
  "selected": { "userId": "...", "employeeId": "DEMO-PWD-001",
                "name": "Road Repair Technician", "score": 95,
                "breakdown": [
                  { "factor": "skills",     "points": 25, "max": 25, "note": "1/1 required skills" },
                  { "factor": "equipment",  "points": 15, "max": 15, "note": "1/1 required equipment" },
                  { "factor": "serviceArea","points": 15, "max": 15, "note": "covers Ward 1" },
                  { "factor": "workload",   "points": 15, "max": 15, "note": "0/3 active assignments" },
                  { "factor": "capacity",   "points": 10, "max": 10, "note": "3 slot(s) free" },
                  { "factor": "distance",   "points": 15, "max": 15, "note": "0 m from complaint" },
                  { "factor": "urgency",    "points": 0,  "max": 5,  "note": "0% of SLA window consumed" }
                ] },
  "candidates": [ { "employeeId": "DEMO-PWD-001", "score": 95, "distanceM": 0 },
                  { "employeeId": "DEMO-PWD-002", "score": 88, "distanceM": 2140 } ],
  "ineligible": [ { "employeeId": "DEMO-SWM-002", "reasons": ["availability is OFF_DUTY"] } ],
  "consideredCount": 3
}
```

A senior engineer can reconstruct any selection: who was considered, who was
filtered and why, exactly how the winner's 95 was assembled, and under which
policy version. The payload carries employee IDs and scores only — no contact
details or internal user data beyond what the audit trail already holds.

## 7. Rejection → automatic reassignment

`rejectAssignment` (worker, on an `OFFERED`/`ACCEPTED` assignment):

1. Guard: only the assigned worker (403), only non-terminal status (409).
2. Close the row as `REJECTED` + `respondedAt` — **history preserved**.
3. Audit `REJECT` + complaint timeline entry.
4. Clear `Complaint.activeAssignmentId`.
5. **Budget check**: count of prior `mode: AUTO` assignments ≥
   `MAX_AUTO_ATTEMPTS` (5) ⇒ stop and audit `NO_ELIGIBLE_WORKER`
   ("manual intervention required") — no infinite reject/reassign loops.
6. Otherwise re-run the engine with `trigger: "REASSIGN"` and
   `excludedWorkerIds: [rejector]` — the rejector is a hard-ineligible
   candidate for this round.

## 8. Official override

`overrideAssignment(official, complaintId, workerUserId, reason)`:

- **OFFICIAL-only** (403 otherwise); target must be a verified `WORKER` with a
  profile (404 otherwise); complaint must not be `RESOLVED`/`CLOSED` (409).
- The previous active assignment is closed — `REASSIGNED` if it was
  `OFFERED`/`ACCEPTED`, else `CANCELLED` — with `closedAt`; its `decision`
  JSON is never modified.
- A new row is created with `mode: OVERRIDE`, `policyVersion: "manual"`, the
  official's `reason`, and a decision JSON carrying `previousAssignmentId`,
  `previousWorkerId`, `overriddenBy`.
- Audited as `AgentActivity` action `OVERRIDE` with the full detail, plus a
  complaint timeline entry.
- Works on complaints with **no** active assignment too (manual dispatch path
  for `NO_ELIGIBLE_WORKER` cases).

## 9. Audit trail

All assignment actions land in `AgentActivity` (agent `AssignmentAgent`) and
the complaint timeline:

| Action | When | Detail payload |
|---|---|---|
| `ASSIGN` | engine selects a worker | full decision JSON (§6) |
| `NO_ELIGIBLE_WORKER` | zero eligible candidates (or budget exhausted) | decision JSON with `ineligible[]` reasons / budget note |
| `REJECT` | worker rejects | worker, assignment, next steps |
| `OVERRIDE` | official overrides | previous assignment/worker/status, new worker, reason, official |
| `MANUAL_ASSIGN` | existing manual assign route | manual-mode compat path |

## 10. Concurrency

- The whole auto-assign runs inside **one Prisma interactive transaction**.
- The complaint row is the **serialization point**: the complaint is re-read
  *inside* the transaction, and `activeAssignmentId` non-null ⇒
  `ALREADY_ASSIGNED` without touching candidates. An earlier read outside the
  transaction is never trusted.
- The new `Assignment` + the `complaint.update` that sets the pointer commit
  atomically; `Complaint.activeAssignmentId` is `@unique`, so at the database
  level two committed active assignments for one complaint are impossible.
- Two racing auto-assigns for the same complaint: the loser observes the
  winner's pointer (or a serialization failure) and returns `ALREADY_ASSIGNED`
  — no duplicate offers.
- **Unit tests verify orchestration, read-ordering, and guard behavior against
  the mocked client. Physical transaction atomicity is only provable against a
  live PostgreSQL** (see limitations).

## 11. Performance

Candidate acquisition is exactly **two queries** regardless of team size: one
`workerProfile.findMany` (department + availability pushed into SQL) and one
`assignment.groupBy` for workload counts. All remaining evaluation is
in-memory over the bounded per-department pool. No per-worker queries, no
loading of all users. Remaining work (scoring + 4 writes) is constant.

## 12. Known limitations

- **Weights are an initial engineering policy**, not tuned against outcomes.
- The category → skills/equipment table is hand-maintained; new categories need
  a table entry (unknown categories degrade safely to "no demands").
- Reassignment budget counts `mode: AUTO` rows per complaint (max 5); override
  and manual assignments are not budgeted.
- Workload counts treat all open statuses equally (an `OFFERED` a worker never
  answers occupies a slot until rejected/overridden).
- Distance is base-location-based, not live GPS.
- Service-area match is exact ward-string equality; no spatial hierarchy.
- Physical transaction atomicity / unique-constraint behavior is **NOT TESTED**
  in this environment (no local Postgres — see `docs/PHASE2B_REPORT.md`).
- No notifications of any kind are sent in Phase 2B (explicitly out of scope).
