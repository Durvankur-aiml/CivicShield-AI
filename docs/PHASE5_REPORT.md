# PHASE 5 REPORT — Civic Intelligence / Analytics

Status: **COMPLETE (code-level VERIFIED; live-DB-dependent items explicitly NOT TESTED)**
Date: 2026-09-30
Starting state: Phase 1–4 complete, 283/283 tests, tsc/lint/build/prisma PASS.

---

## 1. Executive summary

Phase 5 added a deterministic, explainable civic-intelligence layer over the existing operational data — without touching the Phase 1–4 contracts. A new domain (`src/lib/analytics/`, 13 modules) derives every metric from source-of-truth records via bounded, indexed Prisma aggregation; nothing is denormalized, nothing is predicted, nothing is fabricated. Eight official-only API endpoints expose volume, resolution, SLA, worker, assignment, verification, location, hotspot, recurring-issue, and trend analytics, with a strict response contract distinguishing real zeros from NO_DATA from INSUFFICIENT_DATA. Hotspots use a fixed 250 m grid over Phase 4 authoritative coordinates with a documented minimum threshold. Three justified indexes were added. Tests grew from 283 to 336 (+53), all green; TypeScript, ESLint (0/0), production build, and Prisma validate/generate all PASS. Live SQL behavior remains NOT TESTED (no PostgreSQL), stated rather than papered over.

## 2. Starting state

283/283 vitest (21 files), tsc PASS, ESLint 0 errors/0 warnings, build PASS, prisma validate+generate PASS. Phase 1–4 contracts: auth/RBAC, worker domain, assignment engine (policy 2026-09-29.1), notifications, SLA derivation (`slaStateFor`), Phase 4 coordinate authority + verification states. No analytics beyond the legacy `GET /api/stats` dashboard counts existed.

## 3. Repository/schema audit (before coding)

- All 9 models inspected field-by-field (User, WorkerProfile, WorkerApplication, Department, Complaint, Assignment, Notification, StoredFile, TimelineEvent/AgentActivity/Escalation).
- Lifecycle statuses (8 complaint statuses), assignment statuses (7) and modes (3), Phase 3 `slaStateFor` derivation, Phase 4 `accuracyLevel` policy, verification result states — all identified and **reused, never duplicated**.
- Assignment engine's NO_ELIGIBLE_WORKER outcome audited: it writes AgentActivity + TimelineEvent + official notifications, **no Assignment row** — so that metric must (and does) count AgentActivity audit rows.
- Existing indexes inventoried (status, category, departmentId, assignedToId, lat/lng, workerId+status, agent runId/complaintId, recipientId+readAt).
- Legacy `/api/stats` reviewed (kept untouched; it remains the lightweight dashboard endpoint).
- Prisma 6 `groupBy` cannot bucket by date → documented application-side series bucketing with bounded selects.

## 4. Architecture changes

Added `src/lib/analytics/` domain layer (see docs/CIVIC_INTELLIGENCE.md §1) and 8 route files under `src/app/api/official/analytics/`. Routes are thin (auth → window validation → domain call → JSON); `TimeWindowError` extends the shared `ApiError` so error mapping flows through the existing `handleRouteError`. No changes to any Phase 1–4 domain file.

## 5. Analytics domain

Small testable functions per metric group; each module exports a pure `build*` assembly function (fixture-testable) beside its I/O function. Response contract in `metricStatus.ts`: `MetricResult { value, sampleSize, status, unit? }`, `safeMean/safeMedian/safeRate` (zero-division, NaN, negative-duration guards), `durationMetric`, and a UTC `envelope` on every payload.

## 6. Complaint analytics

Total/status/category/department counts via `count`/`groupBy`; department codes resolved through Department lookup; UTC-day time series from a bounded indexed `createdAt`-only fetch (bucketing is application-side because Prisma 6 lacks date truncation — documented; empty buckets are not padded). **VERIFIED** (unit builders); SQL grouping **NOT TESTED**.

## 7. Resolution analytics

Resolved/unresolved/reopened counts, resolution rate, average + median resolution time over lifecycle timestamps; clock anomalies (negative durations) excluded; 0/0 → NO_DATA. **VERIFIED** (unit); **NOT TESTED** against live data.

## 8. SLA analytics

State distribution computed by importing the Phase 3 `slaStateFor` itself — the same single derivation used operationally (zero drift possible); compliance rate over the non-resolved cohort; time-to-assignment/acceptance/completion duration metrics. Phase 3 thresholds untouched. **VERIFIED** (unit, including escalation/warning boundary states).

## 9. Worker analytics

Per-worker raw facts only: active workload, completed/rejected/reassigned counts, avg completion hours with sample size, availability/capacity; minimal identity (employeeId + name); **no performance score, no rankings** (spec §10). **VERIFIED** (unit incl. privacy assertion).

## 10. Assignment analytics

Status/mode counts, acceptance + override rates, rejection-driven reassignments (relation filter on `previousAssignment.status = REJECTED`), no-eligible-worker cases from the engine's AgentActivity audit, distance statistics from the engine decision JSON (malformed records excluded, never guessed). **VERIFIED** (unit).

## 11. Verification analytics

Distribution over Phase 4 states; success/availability rates; `neverVerified` counted honestly; confidence averaged **per provider** so MODEL and HEURISTIC numbers never blend. **VERIFIED** (unit).

## 12. Location analytics

Coordinate coverage/rate; accuracy distribution reusing the Phase 4 `accuracyLevel` policy (no second threshold table); source distribution. **VERIFIED** (unit).

## 13. Hotspot analytics

Deterministic 250 m grid (documented key derivation), default minimum 3 complaints (validated `?minCount` override), authoritative coordinates only, dominant category/severity/department + severity distribution, deterministic ordering, explainable plain-language note. Boundary-exact behavior test-pinned; no ML, no risk scores. **VERIFIED** (pure clustering); live spatial aggregation **NOT TESTED**.

## 14. Recurring issue analytics

CATEGORY / CATEGORY_DEPARTMENT / AREA (grid-cell × category) groupings with documented minimums (5/5/3 defaults, validated overrides); explicitly distinct from Phase 1 incident-level duplicate detection; null coordinates never fabricate areas. **VERIFIED** (pure aggregation).

## 15. Department analytics

Per-department volume, open backlog (all-time operational backlog vs window volume — both labeled), resolution rate, SLA breaches + compliance, avg resolution time, assignment acceptance rate attributed via the complaint's own `departmentId` (bounded joined fetch), reassignments, per-department volume series. **Descriptive only — no best/worst ranking** (asserted by test). **VERIFIED** (unit).

## 16. API changes

8 new GET endpoints (all `runtime = "nodejs"`, all officials-only):
`/api/official/analytics/overview` · `/trends` · `/categories` (recurring) · `/departments` · `/workers` · `/hotspots` · `/verification` · `/location`
Common query contract: `?window=24h|7d|30d|90d` or `?from=&to=` (ISO, validated, bounded 366 days); thresholds (`minCategory`, `minArea`, `minCount`) validated positive integers. Malformed input → 400 with a helpful message. Legacy `/api/stats` untouched. All routes present in the production build manifest. **VERIFIED** (route tests + build).

## 17. Database/index changes

No schema fields/models added (derive-before-store). Three indexes added, each justified (spec §16):
- `Complaint.@@index([createdAt])` — every windowed metric filters createdAt.
- `Assignment.@@index([createdAt])` — assignment windowed counts.
- `AgentActivity.@@index([agent, action])` — no-eligible-worker audit metric.
Rejected: resolvedAt/verifiedAt (run inside bounded window scans; existing status/department/category/workerId indexes suffice). **prisma validate PASS, generate PASS; db push/migration NOT TESTED** (no live PostgreSQL).

## 18. Privacy

Official-only RBAC enforced on every endpoint (test-proven for citizen/worker denial). Worker analytics expose employeeId + display name only — test asserts no emails/phones in payloads. No citizen personal data is queried; complaints are aggregated, never listed with reporter identities; hotspots expose cell centers + counts, never raw coordinates. **VERIFIED**.

## 19. Performance

Aggregation-first (count/groupBy, selected columns only); every query bounded by the validated window; per-row fetches carry explicit `take` caps (1000–5000, commented); overview runs all groups in one parallel batch; no N+1 (structural: no per-row queries exist anywhere in the domain). No caching, no external analytics stores — nothing measured as expensive at this scale (spec §18 honored). **VERIFIED** (code structure + integrity sweep); real-world load **NOT TESTED**.

## 20. Test coverage

53 new tests across 3 suites:
- `tests/analytics.test.ts` (31): metric contract (real zero vs NO_DATA vs INSUFFICIENT_DATA), time windows (presets, custom validation, half-open semantics, UTC bucketing incl. +05:30 boundary), volume groupings, resolution (rates, anomalies, zero-division), SLA distribution via `slaStateFor` (all five states, compliance, empty cohort), worker facts + NO_DATA + privacy, assignment modes/rates/distance (malformed decision JSON excluded), department rows incl. honest NO_DATA, verification rates + per-provider confidence, location coverage/accuracy, trend direction + MIN_SAMPLE semantics.
- `tests/analyticsSpatial.test.ts` (12): grid cell stability, clustering vs non-clustering, threshold behavior (incl. exact boundary adjacency), custom thresholds, dominant majority derivation, deterministic ordering, empty scopes, category/area/department recurrence, coordinate-less handling.
- `tests/analyticsRoutes.test.ts` (10): RBAC on all 8 endpoints, window/threshold validation 400s, empty-database honesty (NO_DATA not fake zeros), deterministic envelopes, worker privacy, hotspot payload explainability.
Shared prisma mock extended additively (`complaint.groupBy`, `department.findMany`, `agentActivity.count`).

## 21. Regression results

Full suite after Phase 5: **336/336 passed (24 files)** — all 283 Phase 1–4 tests intact and green; no existing test modified beyond the additive mock helpers.

## 22. Security validation

All endpoints behind `requireRole(req, "OFFICIAL")`; identity from the Phase 1 session layer (no client-supplied identity); query parameters validated (window presets/custom ranges/thresholds) with 400s; no raw SQL string interpolation (Prisma parameterized queries only); no personal-data exposure (privacy tests); no new secrets or external services. **VERIFIED** (route tests); production penetration surface unchanged.

## 23. Build validation

- `npx tsc --noEmit`: **PASS** (0 errors)
- `npm run lint` (eslint): **PASS — 0 errors, 0 warnings**
- `npm run build`: **PASS** — all 8 analytics routes present in the route manifest
- `npx prisma validate`: **PASS** · `npx prisma generate`: **PASS**

## 24. What was NOT tested

- **Live PostgreSQL aggregation** — count/groupBy/index behavior against a real database (no Docker/Postgres in this environment). All aggregation SQL is NOT TESTED; the pure metric builders are verified instead.
- **db push / migration / seed** — NOT TESTED.
- **E2E/smoke over the new endpoints** — NOT TESTED (scripts/smoke.mjs requires a running server + DB).
- **Production-scale analytics load** — NOT TESTED.
- Timezone display behavior in a real browser — backend UTC convention is unit-verified; client rendering NOT TESTED.

## 25. What was NOT implemented

- Predictive analytics, forecasting, staffing recommendations, risk scores, ML models, LLM summaries (spec §23/§28 — explicitly out of scope).
- Caching, Redis, materialized views, external analytics databases (no demonstrated need).
- Frontend analytics dashboards / redesign (later phase).
- Department-scoped RBAC filtering (official sees own department only) — noted as an extension point.
- Cumulative/rolling window presets beyond the four documented ones.

## 26. Known limitations

- Prisma 6 cannot bucket by date in SQL → series bucketing is application-side over a bounded, column-selective fetch (documented; sampleSize exposed).
- Per-row statistics (durations, spatial samples) compute over the most recent bounded sample on very large datasets — sampleSize makes this visible rather than hiding it.
- Department assignment attribution follows the complaint's routing department, not per-assignment snapshots.
- Uniform degree grid compresses longitude toward the poles (fine for municipal scale).
- "Open backlog" metrics are all-time by design (operational backlog ≠ window volume); both are labeled in the payload.

## 27. Phase 5 completion status

| Area | Status |
|---|---|
| Analytics domain (13 modules, derive-before-store) | VERIFIED |
| 8 official analytics endpoints (RBAC + validation) | VERIFIED |
| Response contract (OK/NO_DATA/INSUFFICIENT_DATA) | VERIFIED |
| Hotspot + recurring methodology (deterministic) | VERIFIED |
| 3 justified indexes; validate/generate PASS | VERIFIED (client) / NOT TESTED (db push) |
| Tests 336/336 · tsc 0 errors · lint 0/0 · build PASS | VERIFIED |
| Live DB / E2E / load | NOT TESTED |
| Predictive / ML / LLM analytics | NOT IMPLEMENTED (deliberate) |

---

### Honesty statement

Every VERIFIED label corresponds to an actually executed command against the final code state (vitest, tsc, eslint, next build, prisma validate/generate). Every NOT TESTED / NOT IMPLEMENTED label reflects a genuine environmental or scope limitation.
