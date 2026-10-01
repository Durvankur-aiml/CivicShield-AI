# CivicShield AI — Architecture

*Original design created during the hackathon window.*

## 1. System overview

CivicShield AI is a single Next.js 16 application (App Router) that contains
the React UI, the REST API (route handlers), the **Agent Orchestrator**, and
the AI provider layer. One process serves everything — a deliberate
hackathon trade-off for deployability and demo reliability.

```
src/
├── app/
│   ├── page.tsx                     # landing (problem, pipeline, transparency)
│   ├── login/                       # Google-only sign-in (Firebase popup)
│   ├── citizen/                     # submit wizard + my complaints
│   ├── official/                    # dashboard: stats, risk map, table, assign
│   ├── worker/                      # task board + evidence submission
│   ├── complaints/[id]/             # shared case view (all roles)
│   └── api/                         # REST handlers (thin; logic lives in lib/)
│       ├── auth/(google|logout|me)
│       ├── complaints/(route, [id]/{assign,status,verify,escalate,close})
│       ├── stats · activity · official/workers
│       ├── cron/sla · health/ai · files/[...key]
├── components/                      # AppShell, UI primitives, CivicMap, AgentActivityPanel
└── lib/
    ├── agent/orchestrator.ts        # pipeline planner + activity log writer
    ├── agent/tools.ts               # the agent's toolbelt
    ├── ai/                          # provider interfaces + implementations
    ├── severity.ts                  # explainable severity/priority engine
    ├── duplicate.ts                 # duplicate intelligence
    ├── auth.ts · api.ts · storage.ts · constants.ts · i18n.tsx · db.ts
vision-service/                      # optional FastAPI + YOLOv8 microservice
prisma/schema.prisma                 # data model
tests/ · scripts/smoke.mjs           # unit + end-to-end tests
```

## 2. AI pipeline

```
IMAGE ─→ YOLOv8 ─→ detections {label, confidence, bbox}
                     │ mapYoloLabel()
                     ▼
TEXT/VOICE ─→ LLM reasoning ─→ structured {summary, category, reasoning[]}
                     │
                     ▼
        category resolution (citizen hint > vision > LLM)
                     ▼
        severity engine (score 0..10, factor breakdown)
                     ▼
        duplicate intelligence (link or new case)
                     ▼
        priority (severity + nearby corroboration, 1..100)
                     ▼
        department routing (category → department table)
                     ▼
        create_complaint() + SLA clock + citizen notification
```

**Resolution verification** runs the same style of pipeline in reverse:

```
worker uploads AFTER image
  → verify_resolution() compares AFTER vs BEFORE + issue category
  → structured verdict { verified, confidence, reason, provider }
  → verified  → RESOLVED (+karma to reporter, citizen notified)
  → failed    → REOPENED → (repeat failures / HIGH+CRITICAL) → ESCALATED
```

### Providers — the honesty contract

| Capability | Production provider | Dev fallback (always labeled) |
|---|---|---|
| Vision | `yolo-service` (FastAPI + ultralytics) | `dev:hint` — uses an explicit, UI-disclosed demo hint or reports "no detection" |
| LLM triage | `bedrock:claude-3-haiku` | `dev:rules` — deterministic keyword triage incl. Hindi/Marathi hints |
| Verification | `yolo-service /verify` | `dev:heuristic` — before/after image-statistics heuristic |

Rules enforced in code:

1. Every result carries its `provider` id, surfaced in the UI and Agent
   Activity log; `/api/health/ai` reports active providers publicly.
2. If a production provider errors, the fallback runs and **records the
   failure in the log line** — results are never silently substituted.
3. The dev vision provider never invents a detection without an explicit
   human-supplied hint (and says so when idle).

## 3. Agent tools

The orchestrator composes these named tools (`src/lib/agent/tools.ts`):

| Tool | Agent | Purpose |
|---|---|---|
| `analyze_image` | VisionAgent | CV detection of civic issue (provider-routed) |
| `classify_issue` | TriageAgent | LLM structured classification of text/voice |
| `calculate_severity` | TriageAgent | explainable 0..10 severity from category baseline + urgency keywords + vision confidence + context |
| `calculate_priority` | TriageAgent | 1..100 queue priority (severity + nearby corroboration + location importance) |
| `find_nearby_complaints` | DuplicateAgent | recent open complaints in a bounding box (pre-filter) |
| `detect_duplicate` | DuplicateAgent | Haversine + category + recency + Jaccard text similarity → link or new case |
| `find_department` | RoutingAgent | category → responsible department with a human-readable reason |
| `create_complaint` | DispatchAgent | persist complaint, start SLA clock |
| `notify_citizen` | DispatchAgent | in-app notification timeline event (email/WhatsApp = extension points) |
| `assign_worker` | DispatchAgent | official-driven worker assignment |
| `verify_resolution` | VerificationAgent | structured after-image verdict |
| `check_sla` | SLAAgent | overdue sweep → OVERDUE flag + escalation |
| `escalate_complaint` | SLAAgent / VerificationAgent | level-bumped escalation history |
| `reopen_complaint` / `close_complaint` | VerificationAgent / Official | lifecycle transitions |

The orchestrator persists one `AgentActivity` row per tool invocation
(agent, action, one-line summary, compact structured detail). The UI renders
these rows — **concise decision explanations, never hidden chain-of-thought**:

```
12:14:02  VisionAgent    analyze_image        Pothole detected (87% confidence, provider dev:hint)
12:14:03  TriageAgent    calculate_severity   Severity HIGH (score 7.0/10)
                                        •  Description describes a safety hazard
                                        •  Located on a major road / public junction
12:14:03  DuplicateAgent detect_duplicate:match  Potentially related complaint CS-2026-000001 — 12m away…
12:14:04  RoutingAgent   find_department      Routed to Public Works Department
12:14:05  DispatchAgent  create_complaint     Complaint CS-2026-000042 created
```

## 4. Data model (Prisma)

- **User** — role `CITIZEN | WORKER | OFFICIAL`, department link, karma.
- **Department** — code (`PWD`, `SWM`, `ELECT`, `WATER`, `HEALTH`, `GEN`), routing target.
- **Complaint** — the aggregate root: classification fields (category,
  severity, priority), location, language + transcript, `source` (`CITIZEN` |
  `DEMO` — demo rows are always flagged), photo/resolution keys, AI
  confidence + summary, SLA (`slaHours`, `slaDueAt`, `isOverdue`),
  verification fields (verified, confidence, reason, verifiedAt),
  `escalationCount`, `reopenedCount`, `duplicateOfId` self-relation for
  linked duplicates.
- **TimelineEvent** — human-readable case history (created, status,
  assignment, evidence, verification, escalation, SLA, notifications).
- **AgentActivity** — the agent decision log (agent, action, summary, detail
  JSON, `runId` grouping a pipeline run).
- **Escalation** — level + reason history.PostgreSQL everywhere (Phase 1 canonical strategy): a local Postgres for
development and Supabase Postgres for deployment — same Prisma schema, no model
changes. Enum-like values are validated strings enforced by zod in
`src/lib/constants.ts` (kept provider-portable).

## 5. Frontend / backend contract

- **Auth**: `POST /api/auth/*` sets an httpOnly, SameSite=Lax JWT cookie
  (7-day expiry). `requireUser` / `requireRole` guards every API route.
- **Submission**: `POST /api/complaints` (multipart) — validates image
  MIME/size, stores via the storage abstraction, then runs the orchestrator
  and returns the created case + agent run id.
- **Reading**: `GET /api/complaints` is role-scoped (`mine` / `assigned` /
  `all`) with status/category/severity/department filters; `GET
  /api/complaints/:id` returns the full case incl. agent activity and
  timeline, with owner/assignee/official access checks.
- **Stats**: `GET /api/stats` (official) aggregates dashboard counters and
  lazily runs the SLA sweep (≤1/min) so overdue cases surface without a scheduler.
- **Map**: the dashboard passes filtered complaints to a client-only Leaflet
  map; markers are severity-colored circles with popup links into case pages.

## 6. Complaint lifecycle

```
RECEIVED ──assign──► ASSIGNED ──start──► IN_PROGRESS
    │                    │ reassign         │
    │                    ▼                  ▼ evidence
    │                 REOPENED ◄─────┐   VERIFICATION
    │                    │            │        │ AI verdict
    │                    │            ├────────┤
    │                    │            ▼        ▼ pass
    └── SLA breach ──► ESCALATED        (re-opened) RESOLVED ──official──► CLOSED
```

SLA hours by severity (env-tunable): CRITICAL 12 · HIGH 24 · MEDIUM 48 ·
LOW 72. The sweep flags `isOverdue`, writes an SLA timeline event, and
escalates HIGH/CRITICAL or repeatedly-breaching cases.

## 7. Security

- Authentication: Google sign-in via Firebase — the browser's Firebase ID
  token is verified server-side (Firebase Admin, revocation-checked) and
  exchanged for a signed session JWT in an httpOnly cookie (`__Host-` prefix
  in production). No password path exists; client-sent identity claims are
  never trusted. See AUTHENTICATION.md.
- RBAC on every route: citizens read/write only their own complaints; workers
  act only on assignments; officials administer (roles are server-assigned via
  the STAFF_EMAILS allowlist). Verified in the smoke test.
- Input validation with zod on all bodies; upload validation (MIME
  allow-list, size cap); path-traversal-safe file serving behind auth.
- In-memory sliding-window rate limits on login/register/submissions
  (single-node scope; Redis is the documented production upgrade).
- CORS on the vision service restricted via `ALLOWED_ORIGINS`.
- No secrets in code or repo (`env.example` template only).

## 8. Multilingual design

Complaints carry a `language` field (`en | hi | mr`). Voice intake uses the
browser Web Speech API with per-language locales (`en-IN`, `hi-IN`, `mr-IN`)
— no keys required — and the transcript flows into the same pipeline. The
rule-based LLM provider recognizes Hindi/Marathi keywords; the Bedrock prompt
is language-aware. UI chrome has an i18n dictionary (`src/lib/i18n.tsx`)
extensible by adding a language entry; server-side STT (e.g. Amazon
Transcribe) is a documented provider-slot extension.

## 9. Testing strategy

- **Unit (Vitest, 73 tests)** — severity/priority engine, SLA mapping,
  duplicate detection (distance/similarity/decisions), dev providers (hint
  mapping, Hindi/Marathi keyword triage, verifier heuristics), provider
  registry fallback behavior.
- **End-to-end (`scripts/smoke.mjs`, 37 checks)** — against a running server:
  auth (success/failure), full submission → 5-agent pipeline assertions →
  dashboard data → assignment → worker start → verification pass (RESOLVED)
  → verification failure (REOPENED/ESCALATED) → unauthorized access, invalid
  input, bad file type, cron protection.
- **Static** — `tsc --noEmit`, ESLint, `next build` (26 routes).

## 10. Demo controls (labeled, dev-only)

Two mechanisms exist purely for reliable judging, both transparent by design:

- **`npm run demo:reset`** — resets the local demo database to the
  seeded demo state (schema sync + seed). Guarded: shows the exact target
  (credentials masked) and requires `--yes`; refuses REMOTE `DATABASE_URL`
  targets without `--yes`, so a production database cannot be wiped accidentally.
- **`POST /api/demo/sla`** — officials-only SLA simulation (*deadline
  approaching* / *breach*). Disabled when `DEMO_MODE=false` and refused by
  production builds unless `DEMO_MODE=true`. Every use writes a labeled
  timeline event ("⏰ DEMO MODE: SLA clock …") and an SLAAgent activity entry;
  breach mode triggers the genuine overdue sweep, so what judges see
  (OVERDUE flag → escalation → history) is the real production code path.

## 11. Known trade-offs (hackathon scope)

- Local disk storage instead of S3 (abstraction in place).
- In-process rate limiting (single node).
- `notify_citizen` records in-app events; email/WhatsApp channels are
  extension points, not implemented.
- Dev verification heuristic is a byte-statistics proxy — real weights come
  from the YOLO service; both paths are always labeled.
- SLA sweep is lazy (stats-triggered) or cron-triggered; no background worker.
