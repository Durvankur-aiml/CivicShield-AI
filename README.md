# CivicShield AI

> **From Citizen Complaint to Verified Civic Action.**

An **agentic AI civic-response platform** built as an original hackathon
implementation. Most civic systems stop at *collecting* complaints. CivicShield
AI processes a complaint end-to-end: it analyzes the report, decides what
actions are required, executes those actions through tools, monitors the case
against its SLA — and **verifies the final resolution with AI** before a case
can close.

This is **not** a chatbot. A server-side Agent Orchestrator runs named agents
(Vision, Triage, Duplicate, Routing, Dispatch, Verification, SLA) that invoke
real tools, and every decision is persisted to an auditable **Agent Activity
log** surfaced in the UI.

---

## Problem → Solution

| Problem with typical civic portals | What CivicShield AI does |
|---|---|
| Complaints sit in a queue; humans triage by hand | AI pipeline classifies, scores severity/priority, and routes to the responsible department automatically — with explainable reasons |
| Duplicate reports create noise and wasted work | Duplicate intelligence (geo-proximity + category + time + text similarity) links *"potentially related complaint"* records instead of creating new cases |
| Workers mark tasks "done" with no proof | Workers must upload resolution evidence; the **AI Verification Agent** analyzes it and only then marks RESOLVED — otherwise the case is REOPENED / ESCALATED |
| No accountability on time | SLA clocks per severity (12/24/48/72h), OVERDUE flagging, escalation history |
| Decisions are opaque | Every agent step is logged with concise human-readable reasons (no hidden chain-of-thought) |

## Architecture (high level)

```
Citizen (photo + voice/text + GPS)
        │  multipart POST /api/complaints
        ▼
┌────────────────────────────────────────────────────────────┐
│ AGENT ORCHESTRATOR (server-side)                            │
│  VisionAgent    → analyze_image()      [YOLO service | dev] │
│  TriageAgent    → classify_issue(), calculate_severity(),   │
│                   calculate_priority()  [Bedrock | dev]     │
│  DuplicateAgent → find_nearby_complaints(), detect_duplicate()│
│  RoutingAgent   → find_department()                         │
│  DispatchAgent  → create_complaint(), notify_citizen()      │
│  VerificationAgent → verify_resolution()  (on evidence)     │
│  SLAAgent       → check_sla(), escalate_complaint()         │
└───────────────┬────────────────────────────────────────────┘
                ▼
        PostgreSQL (Prisma) + file storage
                ▼
React UI: Citizen · Official dashboard (map, table, SLA) · Worker
```

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the full design, and
**[DEMO.md](./DEMO.md)** for judge demonstration steps.

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend + Backend | **Next.js 16 (App Router), TypeScript, Tailwind CSS v4** | one app, one deploy |
| Database | **PostgreSQL (Prisma ORM)** — local Postgres for dev, Supabase Postgres for deployment | one canonical strategy; `demo:reset` syncs the schema and re-seeds DEMO data |
| AI — vision | **YOLOv8** via optional FastAPI microservice (`/vision-service`) | runs the CivicAI custom-trained `best.pt` when provided — see the model note below |
| AI — reasoning | **Amazon Bedrock** (Claude) | labeled deterministic rule-based provider without AWS credentials |
| Storage | Local disk driver behind a storage abstraction | S3 driver is a documented extension point |
| Map | **Leaflet + OpenStreetMap** (react-leaflet) | severity-coded risk map |
| Auth | **Google sign-in via Firebase Auth** — ID token verified server-side (Firebase Admin), CivicShield session JWT in httpOnly cookie | zod validation, rate limiting, upload validation; see [AUTHENTICATION.md](./AUTHENTICATION.md) |
| Tests | Vitest (unit) + end-to-end smoke script (`scripts/smoke.mjs`) | 336 unit tests, 58 e2e checks |
| Worker domain | WorkerApplication → official verification → WorkerProfile | Phase 2A foundation for automatic assignment — see [docs/WORKER_DOMAIN.md](./docs/WORKER_DOMAIN.md) |
| Assignment engine | Deterministic auto-assignment (eligibility → scoring → tie-break), reassignment, official override | Phase 2B — a policy engine, NOT an LLM — see [docs/ASSIGNMENT_ENGINE.md](./docs/ASSIGNMENT_ENGINE.md) |
| Operational workflow | In-app notifications (idempotent), worker accept/reject/start/complete, SLA warning/breach/escalation | Phase 3 — see [docs/PHASE3_REPORT.md](./docs/PHASE3_REPORT.md), [docs/NOTIFICATION_SYSTEM.md](./docs/NOTIFICATION_SYSTEM.md), [docs/SLA_ESCALATION.md](./docs/SLA_ESCALATION.md) |
| Geospatial reliability | Authoritative coordinates + accuracy + capture time + source; centralized accuracy policy; null-safe distance/map/duplicate; machine-readable geolocation errors | Phase 4 — coordinates are authoritative, address is descriptive — see [docs/GEOSPATIAL_RELIABILITY.md](./docs/GEOSPATIAL_RELIABILITY.md) |
| Verification honesty | Structured verification states (VERIFIED/FAILED/INCONCLUSIVE/UNAVAILABLE), provider states (REAL_YOLO/DEV_HINT/…), confidence kinds (MODEL/HEURISTIC), fail-safe holds, magic-byte upload checks | Phase 4 — only explicit VERIFIED can approve a repair; real inference requires the `best.pt` weight (absent here) — see [docs/VISION_VERIFICATION.md](./docs/VISION_VERIFICATION.md) |
| Civic intelligence | Official analytics APIs — volume/resolution/SLA/worker/assignment/verification/location metrics, deterministic grid hotspots, recurring-issue patterns, descriptive trends; OK/NO_DATA/INSUFFICIENT_DATA contract; every number derived from source records, nothing predicted | Phase 5 — see [docs/CIVIC_INTELLIGENCE.md](./docs/CIVIC_INTELLIGENCE.md), [docs/PHASE5_REPORT.md](./docs/PHASE5_REPORT.md) |

## Setup

```bash
npm install
cp .env.example .env          # fill values (see below)
npm run demo:reset -- --yes   # sync schema to PostgreSQL + seed DEMO data
npm run dev                   # http://localhost:3000
```

### Database setup (canonical: PostgreSQL everywhere)

1. Provision a PostgreSQL database — local (`docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16`),
   native install, or a free hosted dev database.
2. In `.env`: `DATABASE_URL="postgresql://postgres:postgres@localhost:5432/civicshield_dev"`
   (Supabase: use the connection string from Project Settings → Database; if it is a
   pooled connection, also set `DIRECT_URL` to the direct/non-pooled one — see `.env.example`).
3. `npx prisma db push` creates the schema; `npm run demo:reset -- --yes` does push + seed in one step.
4. Re-running `demo:reset` between rehearsals restores a known state. It always asks for
   confirmation (`--yes` skips) and refuses remote databases without it.

Authentication is **Google sign-in only** (Firebase). Fill the
`NEXT_PUBLIC_FIREBASE_*` vars plus one server-side Admin credential, then
sign in at `/login`. Full setup: [AUTHENTICATION.md](./AUTHENTICATION.md).
Every Google user is a normal citizen; add your Google email to
`STAFF_EMAILS` in `.env` to reach the official/worker dashboards
(server-side mapping — there is no signup role selection).

`npm run demo:reset` (safe dev-only command) resets the local demo database
to the seeded demo state — it always asks for confirmation (`--yes` skips)
and refuses REMOTE database URLs unless `--yes` is passed explicitly. Re-run
it between demo rehearsals.

Optional real vision:

```bash
cd vision-service
pip install -r requirements.txt       # Python 3.11–3.12
uvicorn main:app --port 8000
# then set YOLO_SERVICE_URL=http://localhost:8000 in .env
```

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string (local Postgres or Supabase) |
| `DIRECT_URL` | no | Direct (non-pooled) connection for Prisma CLI/schema operations on pooled setups |
| `AUTH_SECRET` | **yes** | JWT session signing secret — **fails closed in production** if missing/empty/short (<32 chars); no default exists |
| `NEXT_PUBLIC_FIREBASE_API_KEY` / `AUTH_DOMAIN` / `PROJECT_ID` / `STORAGE_BUCKET` / `MESSAGING_SENDER_ID` / `APP_ID` | yes | Firebase web config for Google sign-in (public identifiers, not secrets) |
| `FIREBASE_SERVICE_ACCOUNT_B64` (or `_PATH` / `GOOGLE_APPLICATION_CREDENTIALS`) | yes | server-side Firebase Admin credential — never commit |
| `STAFF_EMAILS` | no | server-side staff mapping `email:ROLE[:DEPT],…` (no UI role selection) |
| `MAX_UPLOAD_MB` | no (default 8) | upload size limit |
| `YOLO_SERVICE_URL` | no | enables the real YOLOv8 vision path |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` | no | enables Bedrock LLM triage |
| `BEDROCK_MODEL_ID` | no (default claude-3-haiku) | Bedrock model |
| `SLA_HOURS_CRITICAL/HIGH/MEDIUM/LOW` | no (12/24/48/72) | SLA policy |
| `CRON_SECRET` | yes for cron | protects `/api/cron/sla`; `vercel.json` schedules the sweep every 15 minutes and Vercel sends `Authorization: Bearer $CRON_SECRET` |
| `DEMO_MODE` | no | set `false` to disable the labeled ⏰ DEMO SLA controls; production builds refuse them unless `DEMO_MODE=true` |
| `RATE_LIMIT_MULTIPLIER` | no (default 1) | dev-only limiter scaling for test runs — never set in production |

No secrets are committed; `.env*` is gitignored. There are **no demo login
credentials** — authentication is real Google sign-in via Firebase. Seeded
staff rows exist only as assignment targets and are claimed automatically on
first login by a matching `STAFF_EMAILS` Google account.

### Running & deployment

```bash
npm run dev        # local development
npm run build      # production build (passes)
npm run lint       # eslint (clean)
npm test           # unit tests (336 passing)
node scripts/smoke.mjs http://localhost:3100   # end-to-end checks (58) against a running server
```

The scheduled SLA sweep ships in `vercel.json` (cron, every 15 minutes). It requires
`CRON_SECRET` to be set on the deployment — the endpoint rejects unauthenticated calls.

Deploy targets: Vercel (web app) + any Postgres (Supabase) + the vision
service on a small VM/container with your model weights. Scheduled SLA sweeps:
call `/api/cron/sla` with the `x-cron-secret` header from your scheduler.

## Vision model note (external dependency)

The production vision path uses the **CivicAI custom-trained YOLOv8 model
(`best.pt`)** — an external, custom-trained model dependency from the
[CivicAI project](https://github.com/Sujit-1509/CivicAI). The weight itself is
**not distributed** with that repository (verified: no releases; `model/`
holds only training-metric images) and is therefore **not included here**.
Obtain the exact file from the CivicAI author and place it at
`vision-service/model/best.pt` (or set `YOLO_MODEL_PATH`) — the service then
reports provider `yolo-service` with the model file name, and the UI shows a
**REAL YOLO MODEL** chip. Until the weight is provided, the labeled
development provider runs and is disclosed everywhere. The team should record
the author's permission to use the weight in `HACKATHON_CHECKLIST.md`.

## Honest AI policy (important)

Production AI results are **never simulated**. Every provider reports its own
id (`yolo-service`, `bedrock:…`, or `dev:hint` / `dev:rules` /
`dev:heuristic`), the active providers are visible at `/api/health/ai` and on
the landing page, and the Agent Activity log discloses which provider produced
each result. Without cloud credentials the demo still runs — through clearly
labeled development providers — so judges always know what they are looking at.

## Originality statement

CivicShield AI is an **original implementation inspired by civic-AI design
patterns**. No source code, schema, UI, or history was taken from any prior
project; open-source libraries are used under their licenses. Seeded records
are permanently marked `DEMO` in the UI; everything else in the database was
created by real user submissions.

## License

MIT
