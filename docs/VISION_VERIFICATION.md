# Vision & Verification Architecture (Phase 4)

Workstream B of Phase 4. Goal: when someone asks *"what evidence supports this repair verification?"* the system answers with **actual evidence + actual provider + actual result + actual confidence (labeled) + explicit failure/inconclusive state** — never just "AI says it's fixed".

---

## 1. Audit summary — what was real before Phase 4

| Component | Status before Phase 4 |
|---|---|
| `vision-service/` FastAPI + Ultralytics YOLOv8 (`best.pt`) | Real inference path, honest 503 when weights missing — **weight file absent** |
| `YoloVisionProvider` / `YoloResolutionVerifier` (Node) | Real HTTP calls to the service, labeled `yolo-service` |
| `DevVisionProvider` (`dev:hint`) | Labeled simulated detection (hint-driven) |
| `DevResolutionVerifier` (`dev:heuristic`) | Labeled brightness/colorfulness heuristic |
| `beforeMime` propagation | Already fixed in Phase 1 (P0-4), regression-tested |
| Verification decision | Boolean only — `verified: true/false` (the Phase 4 gap) |

## 2. Provider states (machine-readable honesty)

`PROVIDER_STATES` in `src/lib/visionStates.ts`: **`REAL_YOLO | DEV_HINT | UNAVAILABLE | ERROR`**

- `providerStateFor(providerId)` derives the state; the repo's existing honesty convention (provider-id strings `dev:hint`, `dev:heuristic`, `yolo-service`) is preserved and extended, not replaced.
- `providerState` travels on every `VisionResult`; `GET /api/health/ai` now exposes `visionProviderState` and `verifierProviderState` so anyone can see at a glance whether results come from a real model.
- Development/mock output can never pass as a real model: dev results carry `providerState: "DEV_HINT"`, `confidenceKind: "HEURISTIC"`, and a visible note.

## 3. Confidence transparency (no fake confidence)

- `confidenceKind: MODEL | HEURISTIC | UNKNOWN` travels on every detection and verdict.
- Only the real service (`yolo-service`) produces `MODEL` confidence — numbers that came from actual inference.
- Dev providers label their numbers `HEURISTIC` (the long-standing simulated `0.87` hint value is now explicitly marked as such rather than presented as model output).
- Thresholds (e.g. the vision-service detection cutoff) are documented product policy in `vision-service/app.py`, not scientific constants.

## 4. Structured verification results

`VERIFICATION_RESULTS` in `src/lib/visionStates.ts`: **`VERIFIED | FAILED | INCONCLUSIVE | UNAVAILABLE`**

- `ResolutionVerdict` (the provider contract) now carries `verificationResult` alongside the legacy `verified` boolean, plus `confidenceKind`.
- Fail-safe derivation: `verificationResultFor()` maps legacy boolean verdicts — anything not explicitly verified is not treated as an approval, and an errored provider maps to `UNAVAILABLE`.
- `unavailableVerdict()` builds an explicit "could not run" verdict (`verified: false`, confidence 0, provider `unavailable`).

## 5. Outcome state machine (fail-safe)

`decisionForVerification()` in `src/lib/visionStates.ts` — a pure, unit-tested function consumed by the verify route:

| Result | Outcome | Escalation |
|---|---|---|
| `VERIFIED` | **RESOLVE** (karma +10, citizen notified) | — |
| `FAILED` | **REOPEN** (citizen notified) | Phase 3 policy preserved: `reopenedCount ≥ 2` or severity HIGH/CRITICAL |
| `INCONCLUSIVE` | **HOLD** at VERIFICATION | none — no approval, no punishment |
| `UNAVAILABLE` | **HOLD** at VERIFICATION | none — verifier could not run |

> **Fail-safe rule: only an explicit `VERIFIED` can approve a repair.** Verifier downtime, corrupt evidence, or inconclusive evidence can never auto-approve a case, and also never punish the worker for the system's own failure.

## 6. The real YOLO path (status: weight unavailable)

- The production path is fully wired end-to-end: upload → `YoloResolutionVerifier` → `POST {YOLO_SERVICE_URL}/verify` (multipart with BEFORE bytes + BEFORE MIME + AFTER bytes + category) → structured verdict.
- **The CivicAI `best.pt` weight is NOT present in this environment** (`vision-service/model/` contains only a README; repo-wide search finds no `*.pt`). Per the phase rules, no unrelated model was downloaded, no model architecture was changed, and no inference was simulated.
- **REAL YOLO INFERENCE NOT TESTED.** Enabling it: obtain the weight from the CivicAI project author, place it at `vision-service/model/best.pt` (or `YOLO_MODEL_PATH`), run the service (see `vision-service/README.md`), set `YOLO_SERVICE_URL`. The service itself still refuses to fabricate: with the weight missing it reports 503 + degraded health.
- The vision service's `/verify` now returns an explicit `result` field (`VERIFIED`/`FAILED`/`INCONCLUSIVE`) alongside the boolean; the Node provider honors it. Without a baseline image and without a clear signal, the service honestly reports `INCONCLUSIVE` instead of a pass.

## 7. Model loading & caching

- Service side (`app.py`): lazy one-time model load (`get_model()`), explicit `_model_error` reporting, no fallback model substitution. CPU inference unless the host actually provides a GPU — device is never claimed beyond reality.
- Node side: providers are stateless per-request HTTP clients; no model object is cached in Node (nothing to contaminate tests). No GPU is claimed — **GPU/CPU device behavior NOT TESTED** (no model present).

## 8. BEFORE/AFTER evidence path (regression-protected)

1. Citizen photo → `validateImage` (MIME/size) + **magic-byte inspection** (`inspectUploadImage`) → stored (`StoredFile`, DB primary) → `complaint.photoKey`.
2. Worker AFTER photo → same validation chain → `complaint.resolutionKey`.
3. Verify route loads the BEFORE image via `readImage(photoKey)` — **bytes and MIME travel together** (Phase 1 P0-4 regression, still tested).
4. Both images + category reach the provider as multipart parts; `tests/verifyRoute.test.ts` proves the actual BEFORE bytes from storage arrive at the verifier.

## 9. Image validation hardening (B5)

- `validateImage` (declared MIME + size) is preserved untouched.
- NEW: `inspectUploadImage` in `src/lib/storage.ts` sniffs the first bytes against JPEG/PNG/WebP/HEIC(ISOBMFF) signatures — a text/HTML/script payload renamed to `.jpg` is rejected with 400 before storage or verification. Client MIME alone is never trusted.
- The dev verifier also structurally inspects bytes before running its heuristic (`inspectImageBytes`), so garbage can never be "analyzed" into a verdict.

## 10. Failure handling inventory (B10)

| Failure | Behavior |
|---|---|
| Model weights missing (503) | Explicit `UNAVAILABLE` verdict → case HOLDS |
| Service error (5xx/other) | Thrown → visible in logs → pipeline returns explicit `UNAVAILABLE` (never a fake boolean) |
| Invalid/corrupt/unsupported image | 400 at upload; `INCONCLUSIVE` if it reaches a provider |
| Empty detections | `INCONCLUSIVE` (service) — nothing detected is not a pass |
| No BEFORE image | Heuristic/service policy lowers confidence; dev verifier reports `INCONCLUSIVE` |
| Inference timeout | `AbortSignal.timeout` → thrown → `UNAVAILABLE` → HOLD |

## 11. Audit trail (B12)

- Every verification run logs provider, result state, confidence + kind, reason, `beforeMime`, BEFORE availability (`beforeImageAvailable`) to `AgentActivity`; timeline events record the human-visible outcome.
- **No raw image bytes are ever logged** — verified by test.

## 12. Verification status

| Capability | Status |
|---|---|
| Provider states + honest labeling | **VERIFIED** (tests/visionStates.test.ts) |
| Structured result states + fail-safe route policy | **VERIFIED** (tests/verifyRoute.test.ts) |
| Magic-byte upload inspection | **VERIFIED** |
| BEFORE/AFTER bytes reaching the verifier incl. beforeMime | **VERIFIED** (regression suite + new evidence-path test) |
| Real YOLO inference | **NOT TESTED — MODEL UNAVAILABLE** (`best.pt` absent) |
| GPU/CPU device behavior | **NOT TESTED** |
| db push / live service round-trip | **NOT TESTED** (no live PostgreSQL/Docker; service not runnable without the weight) |
