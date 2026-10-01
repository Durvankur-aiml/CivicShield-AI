# CivicShield AI — PPT Content (based on the actual implementation)

> Use this as slide-by-slide source material. All numbers/features reflect the real codebase
> (commit `c90caa8`). Do not claim features that are not listed here.

---

## Slide 1 — Title
- **CivicShield AI**
- *"From Citizen Complaint to Verified Civic Action."*
- Agentic AI civic-response platform
- Team members · Hackathon name · Date

## Slide 2 — The Problem
- Most civic systems stop at *collecting* complaints
- No verification a reported issue is real, urgent, or actually fixed
- Manual routing wastes days; workers self-declare "resolved" with no proof
- Duplicates flood departments; SLAs slip silently

## Slide 3 — Our Solution
- One platform where a complaint is **understood → decided → acted on → verified**
- Not a chatbot: an **orchestrated agent pipeline** where named agents run real tools and every decision is logged and auditable
- Honesty built in: every AI result carries its provider label — production models are never faked

## Slide 4 — How It Works (flow diagram slide)

```
Citizen (photo + voice + text + GPS)
  ↓ VisionAgent       → image analyzed
  ↓ TriageAgent       → category, severity, priority (explainable)
  ↓ DuplicateAgent    → related reports linked
  ↓ RoutingAgent      → responsible department
  ↓ DispatchAgent     → case created, SLA clock starts, citizen notified
  ↓ Official          → risk map + priority queue → assigns worker
  ↓ Worker            → accepts, starts, uploads resolution evidence
  ↓ VerificationAgent → AI checks the repair → RESOLVED or REOPENED/ESCALATED
```

## Slide 5 — What Makes It Agentic
- 7 named agents, real tools: `analyze_image`, `classify`, `detect_duplicate`,
  `find_department`, `create_complaint`, `verify_resolution`, `check_sla`, …
- Structured outputs only — concise decision reasons shown
  (e.g., "HIGH priority: severe issue detected, high confidence"), never hidden chain-of-thought
- Every decision persisted to an **Agent Activity log** visible to citizens, officials and judges

## Slide 6 — Key Features
- Photo/voice/text intake in **English, Hindi, Marathi**
- **Duplicate intelligence** (distance + category + recency + text similarity)
- **Civic Risk Map** (Leaflet + OpenStreetMap) with severity-coded markers and filters
- **SLA clocks** (12/24/48/72h by severity) with overdue sweep and escalation history
- **AI resolution verification** — a worker's claim alone never closes a case
- Karma points for citizens whose verified reports lead to fixes

## Slide 7 — AI Transparency (judge differentiator)
- Every AI result labeled: `yolo-service` (real model) vs `dev:heuristic` (labeled development provider)
- `/api/health/ai` discloses active providers
- Designed for real YOLOv8: the vision service refuses to fake results if weights are missing
- Seeded demo records are explicitly badged **DEMO** in the UI

## Slide 8 — Tech Stack
- Next.js 16 + TypeScript + Tailwind CSS v4 (single full-stack app)
- Prisma + PostgreSQL (Supabase in production; local Postgres in dev)
- Leaflet + OpenStreetMap
- Pluggable AI providers (YOLOv8 vision service, Amazon Bedrock)
- RBAC (Citizen / Worker / Official), httpOnly-cookie auth, Zod validation, rate limiting

## Slide 9 — Demo Flow (what judges will see)
1. Citizen logs in, uploads pothole photo + GPS
2. Agent pipeline runs — vision, triage, duplicate check, routing
3. Complaint `CS-2026-XXXXXX` created with priority + SLA
4. Official dashboard: risk map, stats, assign worker
5. Worker uploads repair photo
6. **Verification Agent** verifies → case closes (or fails → reopened/escalated)

## Slide 10 — Testing & Quality
- 23 unit tests (severity engine, duplicate detection, provider fallback)
- 56 end-to-end API checks: full lifecycle + security negatives (401/403/400/404/409/413/429)
- Typecheck, ESLint, production build all clean

## Slide 11 — Impact & Future Scope
- Cuts complaint-to-action time; kills duplicate cases; makes accountability provable
- Next: real YOLO weights in the production path, WhatsApp/SMS notifications, S3 storage,
  city analytics, multilingual LLM triage

## Slide 12 — Team & Contributions
- Who built what — genuine commit history in the repo
  (backend core, frontend, tests, vision service, docs, audit)

---

### Accuracy notes (do not contradict on slides)
- The database contains **demo-seeded + live-submitted** complaints; seeded records are badged DEMO.
- Active AI providers are the **labeled development providers** (YOLO weights pending placement at
  `vision-service/model/best.pt`); the production path activates automatically when configured.
- Deployment for the demo is local (port 3100); production deployment is a checklist item.
