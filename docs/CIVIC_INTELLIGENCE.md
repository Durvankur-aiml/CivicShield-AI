# Civic Intelligence — Analytics Architecture (Phase 5)

Backend/data intelligence layer. Goal: turn existing operational records into **trustworthy, explainable, deterministic** civic measurements — every number traces back to source rows, nothing is predicted, nothing is fabricated.

---

## 1. Architecture

```
Route (thin: requireRole → parseWindow → domain fn → JSON)
  ↓
src/lib/analytics/            (domain layer — no aggregation logic in route handlers)
  ├─ timeWindow.ts            window parsing/validation (presets + custom ranges)
  ├─ metricStatus.ts          response contract: value/sampleSize/status/envelope
  ├─ complaints.ts            volume, groupings, UTC-day time series
  ├─ resolution.ts            resolved/unresolved/rate/avg/median resolution time
  ├─ sla.ts                   state distribution (reuses slaStateFor), compliance, durations
  ├─ workers.ts               per-worker raw operational facts
  ├─ assignments.ts           assignment lifecycle/modes/acceptance/distance
  ├─ departments.ts           per-department operational rows
  ├─ verification.ts          Phase 4 result-state distribution + rates
  ├─ location.ts              coordinate coverage + accuracy distribution (Phase 4 policy)
  ├─ hotspots.ts              deterministic 250 m grid aggregation
  ├─ recurring.ts             category/department/area recurrence patterns
  ├─ trends.ts                current-vs-previous descriptive deltas
  └─ index.ts                 re-exports + overview parallel bundle
  ↓
Prisma aggregate/groupBy/count/findMany (bounded, indexed)
  ↓
Derived metrics — computed from source-of-truth records, never stored
```

Eight thin routes under `src/app/api/official/analytics/*` follow the repository pattern: authenticate → authorize → validate → call domain → return structured JSON.

## 2. Metric definitions

| Metric group | Definition |
|---|---|
| Volume | Counts of Complaint rows `createdAt ∈ [from, to)`; groupings by status/category/department (code via Department lookup). |
| Resolution time | `resolvedAt − createdAt` for complaints with `resolvedAt ∈ [from, to)` and status RESOLVED/CLOSED. Mean + deterministic lower-middle median. Negative durations (clock anomalies) are excluded, never averaged in. |
| Resolution rate | resolved / created in window; NO_DATA when nothing was created. |
| Unresolved | created-in-window minus resolved-in-window (floored at 0). |
| SLA distribution | `slaStateFor()` (Phase 3) over complaints created in the window — the same derivation used by operational APIs; no second state machine. |
| SLA compliance | (ON_TRACK + WARNING) / non-resolved cohort. |
| Time-to-assignment | complaint `assignedAt − createdAt` (open complaints only). |
| Time-to-acceptance | ACCEPTED assignment `respondedAt − createdAt`. |
| Time-to-completion | COMPLETED assignment `completedAt − startedAt`. |
| Acceptance rate | ACCEPTED / offered assignments in window. |
| Override rate | mode=OVERRIDE / offered in window. |
| Rejection-driven reassignments | status=REASSIGNED whose `previousAssignment` was REJECTED. |
| No-eligible-worker cases | AgentActivity rows (`agent=AssignmentAgent, action=NO_ELIGIBLE_WORKER`) — the engine's own audit trail is the source of truth. |
| Verification rates | success = VERIFIED/(VERIFIED+FAILED); availability = (VERIFIED+FAILED+INCONCLUSIVE)/all-verified; confidence averaged per provider so MODEL and HEURISTIC numbers are never mixed. |
| Location quality | coverage = with-coords/total; accuracy classified by the Phase 4 `accuracyLevel()` (GOOD ≤25 m, DEGRADED ≤150 m, POOR above; UNKNOWN = absent). |
| Trends | current-window vs immediately-preceding equal-length window deltas (see §5). |

## 3. Timestamp conventions

- Storage: Prisma `DateTime` (UTC instants).
- Filtering: UTC Date objects only; no server-local-time string parsing.
- **Windows are half-open `[from, to)`** — adjacent windows never overlap and sums are reproducible.
- Presets (`24h|7d|30d|90d`) are trailing windows ending at `to = now`.
- Custom ranges require both `from` and `to` (ISO 8601); `to` may not be in the future (60 s skew tolerated); max span 366 days.
- Series bucketing floors to the **UTC day** — display timezone conversion is a client concern.
- Null timestamps are excluded from duration math, never treated as zero.

## 4. Status definitions

Complaint/SLA/assignment status vocabularies are imported from the existing domains (`STATUSES`, `SLA_STATES`, `ASSIGNMENT_STATUS` in `src/lib/constants.ts`). SLA state is **derived** per Phase 3 (`slaStateFor`), not stored; the persisted `slaWarnedAt/slaBreachedAt` markers exist only for once-per-assignment idempotency.

## 5. Trends (descriptive, not predictive)

A trend is a measured change: `complaint_volume`, `resolutions`, `open_sla_breaches` (complaint-level OVERDUE marker, non-terminal), plus per-category deltas. The previous window is `[from − len, from)` — half-open continuity with the current window. Direction requires ≥ `MIN_SAMPLE` (2) records in **both** windows; otherwise `INSUFFICIENT_DATA` with change/changePct = null. A percentage is null when the previous window is 0 — no division by zero, no invented "∞% growth". Trends never extrapolate into the future.

## 6. Worker metrics

Raw operational measurements only: current active workload (ACCEPTED/IN_PROGRESS), completed/rejected/reassigned counts in window, avg completion hours (startedAt→completedAt) with sample size, availability, capacity. **No performance score, no "best/worst" ranking** — the payload describes; judging is left to officials. `rejections per worker` counts the worker's own REJECTED rows in the window (identity of the rejecting worker).

## 7. Assignment metrics

Counts by status and mode (AUTO/MANUAL/OVERRIDE) from Assignment rows; acceptance/override rates; rejection-driven reassignments via the `previousAssignment` relation filter; no-eligible-worker cases from AgentActivity audit; distance statistics from the engine's own `decision` JSON (`selected.distanceM` — the value the engine computed with the repo's single `haversineMeters`). Malformed decision records are excluded, never guessed. Sample bounded at 1000 (most recent, createdAt-ordered).

## 8. Verification metrics

Distribution over the Phase 4 `verificationResult` states; `neverVerified` (null result) is counted honestly as "never verified", not as a success or failure. Confidence is averaged **per provider** because MODEL confidence (real inference) and HEURISTIC confidence (labeled dev provider) must never be blended into one number.

## 9. Location metrics

Coordinate coverage (with/without), coverage rate, accuracy distribution via the Phase 4 central policy (`accuracyLevel` — no second threshold table), and location-source distribution (GPS/MANUAL/MAP_PIN/UNKNOWN). Coordinates remain authoritative; no metric derives coordinates from address text.

## 10. Hotspot methodology

- **Deterministic fixed grid**: cell size 250 m (`HOTSPOT_CELL_METERS`), keys = `floor((lat+90)/cellDeg)`, `floor((lng+180)/cellDeg)`. Each complaint belongs to exactly one cell.
- **Minimum threshold**: default 3 (`DEFAULT_MIN_HOTSPOT_COUNT`, overridable via `?minCount=` validated positive integer). A single complaint is never a hotspot.
- Only complaints with BOTH lat and lng present participate (coordinates authoritative; address text never used).
- Cell centers are exact cell midpoints; payload includes count, dominant category/severity/department, severity distribution, window, and a plain-language note — explainable facts, no opaque scores.
- Longitudes compress toward the poles in a lat/lng-degree grid (documented approximation for a municipal-scale demo; not a geodesic equal-area system).
- Boundary behavior is exact and deterministic: points on either side of a cell edge are different cells regardless of physical distance (test-pinned).

## 11. Recurring-issue methodology

Distinct from Phase 1 duplicate detection: duplicates ask "same incident?" (proximity+recency+text at submission time); recurrence asks "does this TYPE of issue keep occurring here/there?" retrospectively. Three deterministic groupings, each with documented minimums (defaults: category ≥ 5, area ≥ 3, validated positive-integer overrides): CATEGORY, CATEGORY_DEPARTMENT, AREA (grid-cell × category). Null coordinates never fabricate areas.

## 12. Privacy boundaries

- Official-only endpoints (`requireRole(req, "OFFICIAL")` on every route; RBAC proven by tests for citizen/worker denial).
- Worker identity = `employeeId` + display name only. No emails, phones, firebase UIDs, or session data (test-verified).
- No citizen personal data is queried by any analytics function; complaints are aggregated, never listed with reporter identities.
- Hotspots expose cell centers and counts — never raw complaint coordinates.

## 13. Performance considerations

- Aggregation-first: `count`/`groupBy`/indexed `findMany` with **selected columns only**; no loading of full complaint objects.
- Every query is bounded by the validated time window; per-row fetches (durations, spatial samples) carry explicit `take` caps (1000–5000) with commented justification.
- The overview endpoint runs all metric groups in **one parallel batch** (no sequential waterfalls); no N+1 anywhere.
- No caching introduced (spec §18: nothing measured as expensive yet, single-node demo scale). No Redis/ClickHouse/materialized views — the current dataset does not demonstrate the need.

## 14. Indexes

Three added, each tied to a specific query shape (spec §16):
- `Complaint.@@index([createdAt])` — EVERY windowed metric filters `createdAt ∈ [from, to)`; one index serves volume, resolution, verification, location, trends, and series fetches.
- `Assignment.@@index([createdAt])` — assignment windowed counts/groupBys.
- `AgentActivity.@@index([agent, action])` — no-eligible-worker metrics query the audit trail by agent+action (the engine's source-of-truth for that outcome).
- Rejected: resolvedAt/verifiedAt indexes — those filters run inside already-bounded created-in-window scans; departmentId/status/category/workerId indexes already existed.

## 15. Empty / insufficient-data behavior

Every derived value carries `{ value, sampleSize, status, unit? }`:
- `OK` — computed from real records (a legitimate **zero is OK**, e.g. "0 breaches").
- `NO_DATA` — nothing in scope (0/0 rates; empty windows; "no complaints that day" is an empty series, not padded zeros).
- `INSUFFICIENT_DATA` — records exist but too few for a meaningful value (rate from a single sample; trend direction with < 2 per window). Value is null; sampleSize says how many were seen.
- Durations with exactly one sample are reported OK with sampleSize 1 (a single real measurement — mean = median = that value — nothing is estimated); rates with one sample are INSUFFICIENT (a 0%/100% rate from one record is not meaningful). The distinction is deliberate and documented.
- Every payload carries an `envelope` (window + generatedAt, UTC ISO) so consumers can reproduce the numbers.

## 16. Limitations

- SQL-side bucketing/date-trunc and physical index usage NOT TESTED (no live PostgreSQL); builders are pinned by deterministic fixtures instead.
- Per-row fetch caps (1000–5000) mean very large datasets compute statistics over the most recent bounded sample — stated in each payload by sampleSize, never hidden.
- Department assignment attribution uses the complaint's department (routing decision), not per-assignment snapshots.
- Single-node in-memory rate limiting and no caching (consistent with existing architecture).
- The 250 m uniform grid compresses longitude at high latitudes (fine for municipal scale; a geodesic grid is a future extension).

## 17. What is NOT predictive

No forecasting, no extrapolation, no risk scores, no staffing recommendations, no ML, no LLM in the pipeline (spec §23 — none introduced). "Trend" means a measured delta between two past windows. Hotspots are counted grid cells, not modeled risk. Every insight payload returns the underlying facts so the UI can present them without hidden calculations.

## 18. Future extension points

- SQL-side time-bucketing (`date_trunc`) when PostgreSQL is available → replaces in-process series bucketing without changing response shapes.
- Cumulative/rolling window variants and department-scoped RBAC (official sees own department) — the domain functions take a window + thresholds; scoping is a where-clause change.
- Materialized summary tables if datasets outgrow bounded-sample statistics (the MetricResult contract already carries sampleSize to make degradation visible).
- AI natural-language summaries as a separate presentation layer, only with source metrics attached and clearly distinguishable (spec §23); core analytics never depends on it.
