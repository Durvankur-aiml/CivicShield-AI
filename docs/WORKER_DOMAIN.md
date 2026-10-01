# CivicShield AI — Worker Domain (Phase 2A)

Worker identity, verification, and registry — the foundation for Phase 2B/2C
automatic worker assignment. **Automatic assignment itself is NOT implemented
in this phase.**

## Identity model

```
User (auth identity: Firebase/Google, role CITIZEN | WORKER | OFFICIAL)
 └── CITIZEN submits WorkerApplication (employee ID + department + skills…)
        ↓
     OFFICIAL verifies (server-side RBAC)
        ↓  APPROVE (one transaction)         ↓ REJECT (reason required)
     WorkerProfile created                        no privileges granted
     User.role = WORKER                           application REJECTED
```

- **User** remains the authentication identity (Firebase session, existing
  role system). Nothing about login changes.
- **WorkerApplication** (`prisma/schema.prisma`) — PENDING → APPROVED /
  REJECTED. Snapshot of stated identity for review: employee ID, department,
  designation, skills, equipment, experience, service areas, phone, optional
  work email.
- **WorkerProfile** — the verified operational record. Created ONLY inside
  the approval transaction. Carries queryable capability data for future
  assignment: `employeeId` (unique), department, designation, `skills[]`,
  `equipment[]`, `availability` (AVAILABLE | OFF_DUTY | SUSPENDED),
  `serviceAreas[]`, `baseLat/baseLng`, `maxActiveAssignments`, contact fields,
  and the approving official.

## Employee ID uniqueness

- Format enforced by zod + regex: `PWD-014`, `SWM112`, `E102` (normalized to
  uppercase at validation — `pwd-014` and `PWD-014` are the same identity).
- **DB constraints are the authority:**
  `WorkerApplication.@@unique([employeeId, status])` and
  `WorkerProfile.employeeId @unique`. A live (PENDING or APPROVED) application
  occupies the ID; a REJECTED application frees it for corrected resubmission.
- Races surface as Prisma P2002 → the service returns a deliberately vague
  **409 "This employee ID is already registered or under review."** — never
  disclosing whether another person holds the ID.
- Email domain is NEVER proof of worker identity; `workEmail` is optional
  contact data only. Reviewer identity comes exclusively from the session.

## Approval / rejection flow

- `POST /api/worker/apply` (CITIZEN session required) → PENDING application.
  Rate-limited (5/hour). WORKER/OFFICIAL users are refused (409).
- `GET /api/worker/apply` → own application status.
- `GET /api/official/worker-applications` (OFFICIAL only) → pending queue,
  oldest first, including applicant identity.
- `POST /api/official/worker-applications`
  `{ applicationId, decision: APPROVE|REJECT, rejectionReason? }`:
  - **APPROVE** — one `$transaction`: WorkerProfile.create + User.role=WORKER
    (+ department/phone) + application→APPROVED. No intermediate state can
    persist. Re-approving is idempotent (returns existing profile, no writes).
    Duplicate-employeeId races lose cleanly with 409 and write nothing.
  - **REJECT** — reason required (zod min 5 chars, service-enforced);
    records reviewer + timestamp + reason; grants nothing.
- `GET /api/worker/profile` (session) → own verified profile (404 if absent).
- `GET /api/official/workers` — existing endpoint, now also returns
  `profile` per worker + a full `registry` array; legacy seeded workers
  without a profile still appear (`profile: null`), so existing UI keeps
  working.

## Audit trail

Every decision writes an `AgentActivity` row (`agent: "WorkerReview"`,
action `approve_worker_application` / `reject_worker_application`, reviewer
email in the summary, ids/codes/reason in the JSON detail). Contact data is
never written to the audit (tested).

## Synthetic worker registry (seed)

`prisma/worker-registry.ts` + one call from `prisma/seed.ts`: 8 deterministic
synthetic workers (`DEMO-*` employee IDs, `@civicshield.demo` emails, generic
role names — no real personal data) covering all six departments, 7+ skills,
equipment variety, all three availability states, service areas, and workload
capacities. Idempotent upserts keyed on unique fields; repeatable.

## Database commands (canonical workflow — db push, no migrations)

```bash
npx prisma generate                      # client regeneration after schema edits
npx prisma validate                      # schema check (DATABASE_URL set)
npm run demo:reset -- --yes              # sync schema (db push --force-reset) + seed
```

## Testing worker onboarding

```bash
npx vitest run tests/workerApplication.test.ts tests/workerReview.test.ts tests/workerRegistry.test.ts
npm test                                 # full suite (111 tests)
```

E2E against a live database (requires Postgres + Firebase env, as Phase 1):
provision DB → `npm run demo:reset -- --yes` → `npm run dev` → sign in as a
CITIZEN → `POST /api/worker/apply` → sign in as OFFICIAL → review endpoint →
verify role transition + `/api/worker/profile`.
