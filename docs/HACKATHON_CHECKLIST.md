# CivicShield AI — Hackathon Submission Checklist

Use this as the pre-submission gate. Nothing here may be faked — every item
must reflect actual, verifiable work.

## 1. Repository & history (rules compliance)

- [ ] Repo contains only this project (`civicshield/`), not the reference repos (`CivicAI-master`, `SAAAF-main` are local study material — **never push them**)
- [x] No fake/backdated/empty commits — history is chronological, honest, and made during the official window
- [x] No history rewrites (`rebase`/`amend`/force-push) after the deadline starts
- [ ] **Every technical team member makes ≥3 meaningful commits with their own Git identity** (see §7) — *the team's responsibility, not something an agent can do*
- [ ] README carries the originality statement (✅ present) and does NOT claim any merge of prior projects
- [ ] Reference repos are cited, if at all, only as "studied for design inspiration"

## 2. GitHub setup

- [ ] Create the GitHub repo; push `civicshield/` as the repo root (not nested inside another project)
- [ ] Add all teammates as collaborators
- [ ] Enable issues; file the known-limitations list from the final audit as issues (nice-to-have)
- [ ] Repo description + topics: `civictech`, `agentic-ai`, `nextjs`, `yolov8`, `bedrock`

## 3. Documentation (all present in repo)

- [x] `README.md` — problem, solution, architecture, stack, setup, env vars, AI architecture, deployment
- [x] `ARCHITECTURE.md` — AI pipeline, agent tools, data model, lifecycle, security, honest-AI contract
- [x] `DEMO.md` — exact 4-minute judge script incl. SLA demo controls
- [x] `HACKATHON_CHECKLIST.md` — this file
- [ ] Update the README "Live demo" placeholder with your deployed URL when available

## 4. Vision model weight (CivicAI `best.pt`) — REQUIRED before the real-model demo

- [ ] Obtain the exact `best.pt` from the CivicAI author (not publicly downloadable — verified; ask https://github.com/Sujit-1509 directly)
- [ ] Place it at `vision-service/model/best.pt`; confirm `GET :8000/health` shows `model_loaded: true` and record `model.names`
- [ ] Run `node scripts/test-yolo.mjs` with real pothole/garbage/water/streetlight photos; record actual class/confidence/bbox results
- [ ] **Record the author's permission to use the weight** (message/email screenshot); only then may the README say "used with permission"
- [ ] End-to-end: submit a real pothole photo and verify the Agent Activity panel shows the REAL YOLO MODEL chip with actual confidence

## 5. Deployment

- [ ] Deploy web app (Vercel or similar): set `DATABASE_URL` (Supabase Postgres), `AUTH_SECRET`, `CRON_SECRET`; **do not** set `RATE_LIMIT_MULTIPLIER` or leave `DEMO_MODE` enabled unless intended
- [ ] Run `npx prisma db push` + `npx prisma db seed` against the production/preview database
- [ ] Optional: deploy `vision-service/` with trained weights; set `YOLO_SERVICE_URL`
- [ ] Configure a cron hitting `/api/cron/sla` with the `x-cron-secret` header
- [ ] Verify the deployed app: login, submit, dashboard, verification flow

## 6. Demo video / PPT

- [ ] Record the 4-minute demo following `DEMO.md` (citizen → agents → official → worker → AI verification → reopen/escalate → SLA demo)
- [ ] Slide story: Problem → Solution → Live architecture → Agent pipeline → Honest-AI transparency → Impact → Roadmap
- [ ] Show the Agent Activity panel and the `/api/health/ai` provider panel — they are the "agentic" proof
- [ ] State clearly which AI providers were live during the demo

## 7. Final testing gate (re-run before submitting)

```bash
npm install
npx tsc --noEmit        # type check
npm run lint            # eslint
npm test                # 73 unit tests
npm run build           # production build
npm run demo:reset -- --yes   # clean demo database (PostgreSQL)
npm run dev             # then: node scripts/smoke.mjs http://localhost:3000  (58 checks)
```

All must pass. Record the date + results in the submission form.

## 8. Team contribution plan (each member commits with their OWN git identity)

Rules: commit real work you personally did and understand; no manufactured
commits; keep messages descriptive. Suggested ownership so each member has a
clear, genuine lane:

| Member | Area | Meaningful work they can own |
|---|---|---|
| A | Citizen frontend | Voice-capture edge cases (Firefox fallback), file-preview UX, i18n strings QA (हिंदी/मराठी), submit-page a11y pass |
| B | Agent/AI core | Tune severity keyword lists with real cases, add a Marathi keyword pack to `devLlm`, extend YOLO label mapping, duplicate-threshold experiments |
| C | Official dashboard & map | Map popups with severity chips, CSV export of the queue, filter persistence in URL params, mobile table layout |
| D | Worker flow, verification & testing | New smoke checks (close flow, escalation history), worker-page loading skeletons, verify-retry UX, docs screenshots |

Each area above has real, reviewable code changes — ideal commit material.

## 9. Submission links (fill before submitting)

- Repository: `________________`
- Live demo: `________________`
- Demo video: `________________`
- Slide deck: `________________`
