# PHASE 4 REPORT — Geospatial Reliability + Real Vision/Verification

Status: **COMPLETE (code-level VERIFIED; live-DB and real-model items explicitly NOT TESTED)**
Date: 2026-09-30
Baseline at start: Phase 1–3 complete, 216/216 tests, tsc/lint/build/prisma PASS.

---

## 1. Executive summary

Phase 4 delivered two independent workstreams over the Phase 1–3 architecture.

**Workstream A — Geospatial reliability.** The complaint location pipeline was audited end-to-end (browser capture → submit form → API validation → persistence → duplicate/map/assignment consumption). A central location domain (`src/lib/location.ts`) now owns coordinate validation (lat −90..90, lng −180..180, finite, NaN/Infinity rejected server-side), a centralized accuracy policy (GOOD/DEGRADED/POOR/UNKNOWN), canonical source taxonomy (GPS/MANUAL/MAP_PIN/UNKNOWN), capture-time handling, and machine-readable geolocation error codes. Coordinates are authoritative; address is descriptive. The submit flow's silent fallback to hardcoded demo coordinates on geolocation failure was **removed**. Complaint coordinates became nullable first-class state with null-safe duplicate, assignment-distance, and map handling. A reverse-geocode provider boundary exists with a noop default (no external provider added). Schema gained `accuracyMeters`, `locationSource`, `locationCapturedAt`.

**Workstream B — Vision/verification honesty.** The full vision stack was audited: real YOLOv8 FastAPI service (weight-gated, refuses to fabricate), labeled Node dev providers, and the Phase 1 beforeMime regression fix. The boolean-only verification decision was replaced by an explicit, fail-safe state machine — **VERIFIED / FAILED / INCONCLUSIVE / UNAVAILABLE** — with `decisionForVerification()` proving only VERIFIED resolves a case. Provider states (`REAL_YOLO/DEV_HINT/UNAVAILABLE/ERROR`) and confidence kinds (`MODEL/HEURISTIC/UNKNOWN`) make honesty machine-readable; dev output can never pass as model output. Uploads are now magic-byte-inspected (client MIME no longer trusted alone). The Python service `/verify` returns explicit result states. **`best.pt` is NOT present**, so per the phase rules no model was fabricated, downloaded, or substituted — the real path is wired, gated, and documented; real inference remains NOT TESTED.

**Verification:** 283/283 vitest (21 files, +67 Phase 4 tests), tsc PASS, ESLint 0 errors/0 warnings, production build PASS, prisma validate + generate PASS. Live DB/E2E/real-GPS/real-YOLO: NOT TESTED (see §23).

## 2. Initial location audit findings

- **Single geolocation call site**: `src/app/citizen/submit/page.tsx` — `navigator.geolocation.getCurrentPosition`, `enableHighAccuracy: true`.
- **BUG (fixed)**: on geolocation error the page silently substituted hardcoded demo coordinates (16.6952, 74.4574) — fabricated GPS precision and a falsified complaint location. The same fallback applied when the user never pressed "Use my location".
- **GAP (fixed)**: `position.coords.accuracy` and `pos.timestamp` were discarded; no source concept existed.
- **No reverse geocoding anywhere** (verified by repo-wide grep) — address was free-typed text only.
- **Canonical order already consistent**: `(lat, lng)` across app + DB; no lat/lng swap found. Haversine existed once (`src/lib/duplicate.ts`), already reused by assignment scoring.
- **Latent risk (fixed)**: `Number(form.get("lat"))` coercion patterns could produce `NaN`/out-of-range from garbage input; zod `.min/.max` alone accepts `NaN`.
- **Hardcoded coordinates inventory**: submit page fallback (removed) + map viewport default (legitimate; now centralized as `DEMO_MAP_CENTER`).
- **Assignment distance already null-safe for workers** (`baseLat/baseLng` optional) but not for complaint coordinates (fixed).

## 3. Location architecture

```
Browser (navigator.geolocation)
  ├─ success → {latitude, longitude, accuracy, timestamp} — validated client-side
  └─ error   → machine-readable code, NO fallback location, retry/landmark offered
        ↓ (only if coordinates exist)
POST /api/complaints (multipart)
  ├─ parseCoordinateField → absent | number | INVALID
  ├─ validateLat/validateLng → 400 INVALID_COORDINATES on garbage/range/NaN/Infinity
  ├─ complaintInput (zod, finite + range + accuracy ≥ 0)
  ├─ normalizeLocation → {lat, lng, accuracyMeters (clamped), source (canonical), capturedAt}
  ├─ describeCoordinatesCached (optional address metadata; never touches coordinates)
  └─ orchestrateNewComplaint → createComplaint (all fields persisted verbatim)
        ↓
Consumers (all null-safe): duplicate.ts · assignmentDomain.ts · CivicMap.tsx · detail UI
```

New modules: `src/lib/location.ts` (policy), `src/lib/geocode.ts` (provider boundary). `src/lib/constants.ts` holds the thresholds/taxonomies. **VERIFIED** (typecheck + tests).

## 4. Coordinate authority

- `Complaint.lat/lng` (nullable) are the single source of truth for "where".
- Address is display metadata: reverse geocoding fills `address`/`ward` only when the citizen typed none, and can never modify coordinates; no code path parses addresses into coordinates.
- Detail UI labels the address "(descriptive)" and shows exact stored coordinates separately. **VERIFIED** (tests/location.test.ts: authority + isolation tests).

## 5. Accuracy policy

Centralized in `src/lib/constants.ts`: `ACCURACY_GOOD_METERS = 25`, `ACCURACY_DEGRADED_METERS = 150`, `ACCURACY_MAX_METERS = 10 000`. Classifier `accuracyLevel()`/`isUsableAccuracy()` in `src/lib/location.ts`. Zero `accuracy > N` comparisons exist outside these files (grep-verified). Thresholds are **documented product policy, not scientific truth**. The UI badge shows the true device-reported `±N m` color-coded by the same policy. **VERIFIED**.

## 6. Timestamp/source handling

- `locationCapturedAt` preserves `pos.timestamp` (ISO). `isLocationFresh()` (30-minute policy window) treats unknown age and future timestamps as not fresh. **VERIFIED**.
- `LOCATION_SOURCES = GPS | MANUAL | MAP_PIN | UNKNOWN`; unknown/hostile values normalize to `UNKNOWN` honestly. The submit flow sets `GPS` only from a real reading. **VERIFIED**. MAP_PIN capture UI: **NOT IMPLEMENTED** (taxonomy ready).

## 7. Reverse geocoding behavior

Provider boundary (`ReverseGeocoder` interface, `getReverseGeocoder()` seam) with **noop default** — no external service was configured (spec A10). Contract (code + tests): returns address metadata only, never throws, failure → `null` with coordinates fully intact; TTL cache (10 min / 500 entries) prevents repeated lookups; cache keys are rounded but **stored data is never rounded**. **VERIFIED**; real provider: **NOT IMPLEMENTED** (deliberate).

## 8. Map behavior

`CivicMap` renders `CircleMarker` from the **exact stored lat/lng** — no rounding, no city-center snapping, no address-based geocoding. Location-less complaints are not plotted; the count chip reflects plotted reality. The only default is the `DEMO_MAP_CENTER` **viewport** center. **VERIFIED** (component logic; visual rendering in a live browser NOT TESTED).

## 9. Distance behavior

Single implementation (`haversineMeters`) reused; argument order pinned by test. Duplicate matching requires coordinates on both sides (else no match — no invented proximity). Assignment engine: complaint coordinates null → distance factor neutral (0.5 × weight, explicit note "no complaint coordinates — neutral"); **Phase 2B weights and policy version unchanged** (weights regression test still green). Worker distance uses `baseLat/baseLng` as before. **VERIFIED**.

## 10. Privacy considerations

- No precise coordinates in logs: AgentActivity details carry refCodes/verdict metadata only; verified by test that audit payloads stay small and byte-free.
- UI displays coordinates rounded (5–6 dp); address is the human-facing location.
- No new coordinate-bearing endpoints; existing RBAC scoping untouched (citizens = own complaints; workers = assigned; officials per Phase 1 rules).
- Geocode cache stores address metadata only.

## 11. Vision architecture

```
Uploads: validateImage (MIME+size) → inspectUploadImage (magic bytes) → StoredFile
Citizen flow: photo → VisionProvider (yolo-service | dev:hint) → VisionResult{provider, providerState, detections, category, confidence, confidenceKind, model?, note}
Resolution flow: BEFORE(bytes+mime from storage) + AFTER(bytes+mime) + category
  → ResolutionVerifier (yolo-service | dev:heuristic | unavailable)
  → ResolutionVerdict{verified, verificationResult, confidence, confidenceKind, reason, provider}
  → decisionForVerification → RESOLVE | REOPEN(+escalate) | HOLD
  → persisted: status + verified + verificationResult + confidence + reason + provider + verifiedAt
```

Route stays thin: auth → authorize → validate → domain/policy → structured JSON. **VERIFIED**.

## 12. Provider states

`REAL_YOLO | DEV_HINT | UNAVAILABLE | ERROR` (`src/lib/visionStates.ts`), derived from the repo's existing provider-id convention (`yolo-service`, `dev:*`) — extended, not replaced. Exposed on `VisionResult.providerState` and `GET /api/health/ai` (`visionProviderState`, `verifierProviderState`). Dev providers self-label `DEV_HINT` on every result; the fallback wrapper preserves the label even when the primary provider fails. **VERIFIED**.

## 13. Real YOLO status

**REAL YOLO INFERENCE NOT TESTED — MODEL UNAVAILABLE.** `best.pt` is absent (`vision-service/model/` contains only a README; repo-wide `*.pt`/`*.onnx` search empty). Per rules: no unrelated model downloaded, no architecture changed, no demo-pass hacks. The correct integration exists: service runs actual Ultralytics inference from `model.names` when the weight is placed at `YOLO_MODEL_PATH` and refuses (503/degraded) otherwise; the Node provider maps a 503 to an explicit `UNAVAILABLE` verdict. Enabling = drop the weight + run uvicorn + set `YOLO_SERVICE_URL`.

## 14. Model loading behavior

Service: lazy single load, explicit `_model_error`, honest 503 on missing weight/ultralytics, CPU unless the host actually provides a GPU (device claims follow reality; **device behavior NOT TESTED**). Node: stateless HTTP clients; no model caching introduced (nothing to contaminate tests); no GPU forced. If a weight is later added, caching happens solely in the service process — safe and documented.

## 15. BEFORE/AFTER behavior

Complete path proven by tests: citizen photo bytes persist (`photoKey`); verify route loads them via `readImage` and sends **actual BEFORE bytes with BEFORE MIME** plus AFTER bytes and category as multipart parts (Phase 1 P0-4 regression intact + new byte-level evidence test). Filenames/metadata are never compared as a substitute for content; dev-verifier policy compares structural statistics of the actual bytes. **VERIFIED**.

## 16. Verification states

`VERIFIED | FAILED | INCONCLUSIVE | UNAVAILABLE` on `ResolutionVerdict.verificationResult` and `Complaint.verificationResult`. Fail-safe derivation maps legacy boolean verdicts; `UNAVAILABLE` is a distinct first-class state (`provider: "unavailable"`). Outcome machine (pure, unit-tested):

| State | Outcome | Escalation |
|---|---|---|
| VERIFIED | RESOLVED (karma +10, citizen notified) | — |
| FAILED | REOPENED (citizen notified) | reopenedCount ≥ 2 or HIGH/CRITICAL (Phase 3 policy preserved) |
| INCONCLUSIVE | HOLD at VERIFICATION (manual review, citizen informed) | none |
| UNAVAILABLE | HOLD at VERIFICATION (manual review, citizen informed) | none |

**VERIFIED** (visionStates + verifyRoute suites).

## 17. Failure handling

Model missing → explicit UNAVAILABLE (Node) / 503+degraded health (service). Service 5xx → thrown, visible, then UNAVAILABLE — never a fabricated boolean. Corrupt/invalid/unsupported images → 400 at upload, INCONCLUSIVE at providers. Empty detections → INCONCLUSIVE (nothing seen is not a pass). Missing BEFORE → confidence reduced / INCONCLUSIVE per provider. Inference timeout → abort → UNAVAILABLE. **No failure path auto-approves a repair** — each is test-enumerated. **VERIFIED**.

## 18. Security considerations

- Magic-byte upload inspection added (`inspectUploadImage`): renamed executables/HTML/scripts rejected before storage or inference; declared-MIME + size validation preserved. **VERIFIED**.
- Server-side coordinate validation with machine-readable 400s; hostile accuracy claims clamped; hostile coordinate claims rejected. **VERIFIED**.
- Identity still derives exclusively from the authenticated session (`requireUser`); no client-controlled identity introduced. **VERIFIED** (existing auth suite + route guards unchanged).
- No raw image bytes in logs; verdict/audit payloads bounded. **VERIFIED** (test).
- Known gap from the Phase 1 audit: full image decode validation (e.g. pixel-dimension bombs) remains beyond magic-byte sniffing; documented here as an explicit remaining item, not silently ignored.

## 19. Database changes

`prisma/schema.prisma`, `Complaint` only:
- `lat`/`lng`: `Float` → **`Float?`** (location-less complaints are valid; downstream null-safety implemented).
- Added `accuracyMeters Float?`, `locationSource String?`, `locationCapturedAt DateTime?`, `verificationResult String?` (null = never verified; values VERIFIED/FAILED/INCONCLUSIVE/UNAVAILABLE).
- No indexes removed; existing `@@index([lat, lng])` retained; no relationships touched. `prisma validate` PASS, `prisma generate` PASS.
- **db push NOT TESTED / migration NOT TESTED / physical constraint behavior NOT TESTED** (no live PostgreSQL/Docker in this environment).

## 20. Tests

New suites (67 tests):
- `tests/location.test.ts` (29): valid/invalid coords, NaN/Infinity, types, canonical haversine order, form-field parsing, accuracy classes + boundaries + UNKNOWN honesty, usability, normalization (preserve/clamp/timestamp validity), freshness, browser error-code mapping, complaintInput contract (with/without coordinates, invalid), duplicate null-safety (both sides), engine distance neutrality + unchanged behavior, reverse-geocode isolation + metadata-only contract, single hardcoded-coordinate inventory.
- `tests/visionStates.test.ts` (28): provider states, health exposure, result-state mapping, unavailable verdict, route outcome policy (incl. escalation matrix), magic-byte matrix (JPEG/PNG/WebP/HEIC, renamed HTML/PDF, truncated, unsupported ISOBMFF), dev-provider honesty (no fabrication, HEURISTIC labeling), dev-verifier INCONCLUSIVE paths (no-before, corrupt before/after), real-provider boundary (503→UNAVAILABLE, INCONCLUSIVE preservation, VERIFIED+MODEL kind, 5xx visible), audit hygiene, confidence labeling.
- `tests/verifyRoute.test.ts` (10): full route state machine — RESOLVED/REOPENED/HOLD outcomes, escalation matrix, no karma on hold, status untouched on HOLD, BEFORE bytes+MIME reaching the verifier, byte-free audit, legacy boolean mapping, magic-byte 400.

Modified: `tests/ai.test.ts` (fixtures now carry valid JPEG headers — the dev verifier structurally inspects bytes; assertions unchanged), `tests/helpers/prisma-mock.ts` (additive `storedFile` model). No existing test deleted or weakened; yoloVerifier beforeMime regression suite untouched and green.

## 21. Exact test results

- `npx vitest run` (final state): **21 files, 283/283 passed, 0 failed** (216 baseline + 67 Phase 4).
- Phase 4 suites individually: location 29/29 · visionStates 28/28 · verifyRoute 10/10.
- During development one baseline failure appeared (ai.test.ts) due to new structural inspection of synthetic byte fixtures; fixed by giving fixtures real JPEG headers — behavioral assertions unchanged.

## 22. TypeScript/lint/build

- `npx tsc --noEmit`: **PASS** (0 errors).
- `npm run lint` (eslint): **PASS — 0 errors, 0 warnings**.
- `npm run build` (prisma generate && next build): **PASS**; route manifest intact (`/api/complaints`, `/api/complaints/[id]/verify`, `/api/health/ai`, worker/SLA/notification routes, pages).
- `npx prisma validate`: **PASS**. `npx prisma generate`: **PASS** (client v6.19.3).

## 23. Live DB/E2E status

Environment has no live PostgreSQL/Docker. Therefore, honestly and permanently for this phase:
- **db push / migrations: NOT TESTED.**
- **Seed: NOT TESTED.**
- **E2E smoke (`scripts/smoke.mjs`): NOT TESTED.**
- **Physical transaction/constraint behavior (nullable-cooldown, indexes): NOT TESTED.**
- **Browser GPS integration (real device sensors, permission prompts): NOT TESTED** (module-boundary behavior verified by tests instead).
- **Real YOLO inference: NOT TESTED — MODEL UNAVAILABLE.**
- Python service runtime: not executed here; changes are syntax-consistent and policy-documented. **NOT TESTED.**

## 24. Known limitations

- No reverse-geocode provider is configured: complaints without a typed address keep coordinates-only until one is registered at the seam.
- Map-pin selection UI does not exist; `MAP_PIN`/`MANUAL` sources are defined but not yet produced by any UI.
- Magic-byte sniffing is signature-level; it does not decode pixels (dimension-bomb/malformed-body edge cases pass through to the vision stage, which fails safely INCONCLUSIVE/UNAVAILABLE).
- Accuracy thresholds are product policy for a municipal demo, not empirically derived.
- The in-memory rate limiter, notification writer, and geocode cache remain single-process (unchanged scope).
- Vision-service `/verify` state policy (FAILED without baseline when the issue is clearly visible) is documented product policy, not scientifically validated.

## 25. Explicitly unimplemented work

- Real reverse-geocoding provider integration (boundary ready, noop default).
- Map-pin / manual-coordinate capture UI and MANUAL/MAP_PIN source flows.
- Real YOLO inference execution (blocked solely on the absent `best.pt` weight).
- GPU enablement/device documentation (no model to load).
- Any Phase 5+ work: hotspot analytics, predictive analytics, city-wide clustering, advanced GIS, route optimization, worker navigation, frontend redesign (Stitch), Jitter, new notification providers, new assignment scoring policy — **none started** (repo grep clean).

## 26. Phase 5 readiness

- **Complaints now carry trustworthy physical evidence dimensions**: coordinates (authoritative, nullable, validated) + accuracy + capture time + source, and structured verification outcomes — the exact primitives hotspot/clustering/predictive analytics would consume, already null-safe and auditable.
- **Clean seams**: provider boundaries (vision, geocode), centralized policies (accuracy, verification outcomes), typed state vocabularies (`LOCATION_SOURCES`, `ACCURACY_LEVELS`, `PROVIDER_STATES`, `VERIFICATION_RESULTS`) — Phase 5 can build on these without re-architecture.
- **Honest gaps to close first**: a real geocode provider, map-pin capture, and (for any analytics credibility) a populated live database — all explicitly listed in §25.
- **Stability**: 283 green tests, typed end-to-end, lint-clean build — regression safety net in place for the next phase.

---

### Honesty statement

Every VERIFIED label above corresponds to an actually executed command against the final code state (vitest, tsc, eslint, next build, prisma validate/generate — outputs in §21–§22). Every NOT TESTED / NOT IMPLEMENTED label reflects a genuine environmental or scope limitation, stated rather than papered over.
