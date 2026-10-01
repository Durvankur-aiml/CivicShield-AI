# CivicShield AI — Phase 2A Report: Worker Domain Foundation

Date: 2026-09-29 · Scope: WorkerApplication + WorkerProfile + verification workflow ONLY.
Automatic worker assignment is explicitly NOT implemented (Phase 2B).

Legend: **VERIFIED** = command executed and passed in this environment ·
**NOT TESTED** = requires resources unavailable here (live PostgreSQL/Firebase) ·
**NOT IMPLEMENTED** = out of Phase 2A scope.

---

## 1. Executive Summary

The worker domain now exists as a verified foundation. A citizen submits a
WorkerApplication (employee ID + department + capability snapshot); an official
verifies it server-side; APPROVE runs in ONE database transaction —
WorkerProfile creation + User.role=WORKER + application→APPROVED — so no
intermediate state can persist. REJECT requires a reason and grants nothing.
Employee-ID uniqueness is enforced by database constraints with race-safe
P2002→409 handling. Every decision is audited via the established
AgentActivity mechanism (no contact data). A deterministic synthetic registry
of 8 workers (all 6 departments, diverse skills/equipment/availability/service
areas) seeds realistic data for Phase 2B/2C. All pre-existing functionality
remains intact (73 → 111 tests, all passing; existing 73 untouched).

## 2. Files Changed

**Modified (6):** `prisma/schema.prisma` (2 models + relations; no existing
model altered beyond adding back-relations) · `src/lib/constants.ts` (worker
taxonomies + zod schemas) · `src/app/api/official/workers/route.ts`
(profile-aware response; legacy shape preserved via `profile: null`) ·
`prisma/seed.ts` (registry hook) · `README.md` (stack row + test count) ·
`tests/helpers/prisma-mock.ts` (additive worker-model mocks; Phase 1 mocks
intact — proven by 73 pre-existing tests still passing).

**Added (9):** `prisma/worker-registry.ts` · `src/lib/workerDomain.ts` ·
`src/app/api/worker/apply/route.ts` · `src/app/api/worker/profile/route.ts` ·
`src/app/api/official/worker-applications/route.ts` ·
`tests/workerApplication.test.ts` (14) · `tests/workerReview.test.ts` (14) ·
`tests/workerRegistry.test.ts` (10) · `docs/WORKER_DOMAIN.md`.

**Deleted:** none.

## 3. Database / Schema Changes

- `WorkerProfile` — userId @unique, employeeId @unique, departmentId FK,
  designation, `skills String[]`, `equipment String[]`,
  `availability` (AVAILABLE|OFF_DUTY|SUSPENDED), `serviceAreas String[]`,
  baseLat/baseLng, maxActiveAssignments, phone/workEmail, approvedById,
  approvedAt, timestamps; indexes on departmentId + availability.
- `WorkerApplication` — applicantId FK, employeeId, departmentId FK,
  designation, skills/equipment/serviceAreas arrays, experience, phone,
  workEmail, status (PENDING|APPROVED|REJECTED), reviewedById/reviewedAt/
  rejectionReason, timestamps; `@@unique([employeeId, status])` +
  `@@unique([applicantId, status])` (live rows occupy the identity; REJECTED
  frees it), indexes on `[status, createdAt]` + departmentId.
- Arrays are PostgreSQL-native `String[]` (queryable/filterable for 2B/2C) —
  deliberately NOT a JSON blob, per the existing architecture's normalized
  conventions.
- **Schema workflow:** this project uses `prisma db push` (no migration
  history). Commands VERIFIED here: `prisma validate` (valid, with
  DATABASE_URL only) + `prisma generate`. `db push`/seed against a live
  database: **NOT TESTED** (no Postgres in this environment).

## 4. WorkerApplication Design

Lifecycle PENDING → APPROVED/REJECTED with reviewer, timestamp, and rejection
reason. Capability snapshot captured at submission for the reviewer;
the approved values are copied into WorkerProfile inside the transaction.
One live application per applicant and per employee ID (constraint-backed);
reapplication allowed only after rejection.

## 5. WorkerProfile Design

Verified operational record; never created outside the approval transaction.
Structured capability columns (skills/equipment/availability/service areas/
location/capacity) give Phase 2B/2C everything eligibility scoring needs
without schema changes. `approvedById` preserves the verification chain.

## 6. Role Transition Behavior

APPROVE (single `$transaction`): WorkerProfile.create → User.role=WORKER
(+ departmentId, phone) → application→APPROVED. Failure at any step rolls the
whole transaction back (Prisma interactive transaction). Idempotent
re-approval returns existing state with zero writes. P2002 races → 409 with
nothing persisted. The role transition can never exist without the profile
and vice versa (same transaction boundary).

## 7. Authorization Model

- Apply: requireUser + CITIZEN-only service guard (WORKER/OFFICIAL → 409).
- Review/list: requireRole("OFFICIAL") — server-side only; no client-supplied
  userId/role/reviewer is ever trusted (reviewer = session user).
- Worker profile: own record only, 404 when absent (no existence oracle for
  arbitrary users).
- Registry: officials only, via the existing guarded `/api/official/workers`.
- Unauthenticated: 401 (existing requireUser semantics).

## 8. Approval / Rejection Workflow

Documented in docs/WORKER_DOMAIN.md §Approval. Rate-limited apply (5/hour);
officials see the pending queue oldest-first; rejection requires reason
(zod min 5 + service re-check BEFORE any write); idempotent re-approval;
already-rejected applications refuse re-review (409).

## 9. Audit Trail

AgentActivity rows (agent "WorkerReview") on every decision: reviewer email
in summary; applicationId/employeeId/departmentCode/reason (reject) or
approvedUserId (approve) in detail JSON. Contact data never enters the audit
(test-verified). No audit row is written on failed approvals (test-verified).

## 10. Registry / Seed Mechanism

`prisma/worker-registry.ts`: 8 deterministic synthetic workers (DEMO-*
employee IDs, @civicshield.demo emails, generic role names — zero real
personal data) covering all six departments, 7+ skill taxonomy values,
equipment variety, all three availability states, service areas, and workload
capacities. Idempotent upserts on unique keys; fails loudly if departments
are missing (seed-order dependency). Hooked into `prisma/seed.ts`.

## 11. Security Considerations

Server-side RBAC preserved (requireUser/requireRole); session-derived
identity only; no client-controlled role/reviewer/applicant; DB-level
uniqueness; transactional approval; zod validation on all bodies
(employeeId normalization, taxonomy enums, phone/email formats, list caps);
vague 409 messages (no ID-owner disclosure); no contact data in logs/audit;
no real personal data in seed; Phase 1 hardening untouched (AUTH_SECRET
fail-closed, cron auth, headers, demo-mode guard).

## 12. Tests Added

- `tests/workerApplication.test.ts` (14) — zod validation (normalization,
  malformed IDs, unknown taxonomy values, bad phone/email, list caps);
  submission; non-citizen refusal; own-duplicate; employeeId-live; profile
  clash; P2002 race → 409; reapplication after rejection; error propagation;
  own-status + null.
- `tests/workerReview.test.ts` (14) — RBAC (citizen/worker 403, official OK,
  404 unknown, reject-without-reason 400 before writes); rejection records
  reviewer/time/reason + audit, no profile/role writes, no contact data in
  audit; approval in ONE $transaction with full data; idempotent re-approval;
  race → 409 + no audit; non-conflict failure propagates + no audit; own
  profile + 404; registry; pending list.
- `tests/workerRegistry.test.ts` (10) — synthetic-only identities; unique
  employee IDs; determinism (no Date/Function values, stable serialization);
  all 6 departments; capability/availability diversity; taxonomy conformance;
  upsert keying; capability data; missing-department failure; repeatability.

## 13. Exact Test Results (actual runs, this environment)

```text
npx vitest run                → Test Files 12 passed (12) · Tests 111 passed (111)
  tests/workerApplication.test.ts → 14/14
  tests/workerReview.test.ts      → 14/14
  tests/workerRegistry.test.ts    → 10/10
  (pre-existing 73 tests: all passing, untouched)
npx tsc --noEmit              → 0 errors
npm run lint                  → 0 problems
npm run build                 → ✓ Compiled successfully
```

## 14. TypeScript / Lint / Build Results

All PASS (see §13). No new warnings introduced.

## 15. Migration / DB Commands Actually Executed

- `DATABASE_URL=postgresql://… npx prisma validate` → "schema is valid" (VERIFIED)
- `DATABASE_URL=postgresql://… npx prisma generate` → client generated (VERIFIED)
- `npx prisma db push` / `npm run demo:reset -- --yes` / seed execution against
  a live PostgreSQL → **NOT TESTED** (no PostgreSQL or Firebase credentials
  available in this environment; documented limitation since Phase 1)

## 16. Known Limitations

1. Live-database verification (db push, seed execution, transactional
   rollback proof, E2E worker-onboarding flow) remains NOT TESTED here — the
   same operational gate documented in the Phase 1 report. The approval
   transaction's atomicity is enforced by Prisma interactive transactions and
   verified at the orchestration level; physical rollback is provable only on
   a live database.
2. Review UI is API-only in this phase (no frontend redesign allowed by
   scope); officials operate via the documented endpoints.
3. Registry workers have no Firebase accounts (synthetic assignment targets,
   consistent with the existing seeded staff rows; claimable via
   STAFF_EMAILS exactly like legacy staff).

## 17. Explicitly Unimplemented (future phases)

Automatic worker assignment, assignment scoring/ranking, workload balancing,
worker notifications (push/email/SMS), worker mobile dashboard, SLA
reassignment, dynamic priority, duplicate clustering, hotspot analytics,
PWA/offline, any new frontend design. None started.

## 18. Phase 2B Readiness Assessment

**READY (code foundation).** WorkerProfile carries every structured dimension
Phase 2B's scoring needs (department, skills, equipment, availability,
service areas, base location, capacity) with queryable indexes; the approval
pipeline guarantees profile integrity and the review chain; the registry
provides deterministic, diverse synthetic data; the audit mechanism is
established. One operational prerequisite before production claims: the
live-PostgreSQL E2E gate (as in Phase 1). No code-level blocker exists for
starting Phase 2B assignment scoring on top of this domain.
