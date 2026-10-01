# CivicShield AI — Judge Demo Script

**Total time: ~4 minutes.** All demo accounts and seeded records are clearly
marked as demo data. Everything submitted during the demo is real data going
through the real pipeline.

## Before you start (one-time)

```bash
npm install
cp .env.example .env
npm run demo:reset -- --yes   # creates a clean, clearly-labeled demo database (PostgreSQL)
npm run dev            # http://localhost:3000
```

`npm run demo:reset` wipes **only the demo database** defined by
`DATABASE_URL` (it shows the target with credentials masked and requires
`--yes`, refusing remote databases without it) and re-seeds departments,
demo accounts, and DEMO-marked records. Use it
between rehearsals so the demo always starts from a known state.

Have two windows (or split-screen): one **incognito/private** window and one
normal window, so you can show citizen and official sessions side by side.
Keep a pothole photo and a "repaired road" photo handy (any two images; the
demo AI analyzes them).

**Open the landing page first** and point out the *Honest AI* panel: it shows
which AI providers are active right now (`yolo-service` / `bedrock` when
configured, or the clearly-labeled development providers). Production results
are never faked silently — say this out loud.

---

## Act 1 — Citizen reports a pothole (90s)

1. Sign in with **Continue with Google** (real Firebase authentication). For
   the citizen/official/worker windows use three Google accounts whose emails
   are listed in `STAFF_EMAILS` (citizen = any other Google account).
2. Click **Report an Issue**.
3. Attach the pothole photo. If the dev vision provider is active, an amber
   *"Simulated vision"* box appears — pick **Pothole** from it and say:
   *"this is the labeled development provider; with the YOLO service
   configured this select disappears and a real model runs."*
4. Click **🎙 Record voice complaint** and dictate one sentence (or type it):
   *"There is a deep dangerous pothole on the main road near the bus stand,
   two-wheelers skid every evening."*
5. Click **Use my location** (GPS coordinates appear).
6. Submit. **The Agent Activity panel plays the pipeline live:**
   - VisionAgent → *Pothole detected (87% confidence, provider …)*
   - TriageAgent → *Severity HIGH (score x/10)* with bullet reasons
     ("describes a safety hazard", "major road / public junction")
   - DuplicateAgent → **if you submit near a seeded demo pothole:**
     *"Potentially related complaint CS-2026-000001 — 12m away…"*
   - RoutingAgent → *Routed to Public Works Department*
   - DispatchAgent → *Complaint CS-2026-XXXXXX created* · *Citizen notified*
7. Click **Track this complaint** — the case page shows evidence, the full
   agent log, timeline, and `RECEIVED` status.

**Talking point:** no chatbot — named agents executed real tools and every
decision is persisted and auditable.

## Act 2 — Official dashboard (60s)

8. In the second window, sign in with Google as an **OFFICIAL** account (its
   email is listed in `STAFF_EMAILS` with `:OFFICIAL`).
9. Show the stat cards (Total / Open / In Progress / Verification / Resolved
   / Overdue / Escalated) and the **Civic Risk Map** — severity-colored
   markers, DEMO badges on seeded records.
10. Use a filter (e.g. Category = Pothole) — table and map update.
11. Find the complaint you just created (top of the priority queue — highest
    priority first). Point out its **SLA countdown** and department routing.
12. Click **Assign** → pick *Demo Worker (Roads)*.

## Act 3 — Worker fixes it (60s)

13. In the first window, sign out and back in as **Worker**.
14. The task appears with issue details, citizen's photo (evidence),
    location, and SLA. Click **Start work**, then **Upload resolution
    evidence →**.
15. Attach the "after repair" photo, add a note, **Submit for AI
    verification**.

**The differentiator moment:** the AI Verification Agent runs and returns a
structured verdict —
`✓ AI verified the resolution · confidence 91% · "after image is brighter
than before — consistent with a filled/dried issue"` — and the complaint
becomes **RESOLVED**. State plainly: *"a worker's 'done' button alone never
closes a case."*

## Act 3.5 — SLA demo without waiting hours (30s)

On the official dashboard, any active row has an amber **⏰ DEMO SLA** button
(dev mode only; production builds refuse it). It opens a clearly labeled
*DEMO / DEVELOPMENT MODE* dialog with two options:

- **Deadline approaching** — SLA countdown flips to *15m left* (warning state).
- **SLA breached** — sets the clock 1h past due and runs the same overdue
  sweep production would run on schedule: row flags **OVERDUE**, the HIGH
  severity case auto-**escalates**, the Overdue/Escalated stat cards update,
  and the case timeline records a labeled
  *"⏰ DEMO MODE: SLA clock …"* event plus an SLAAgent log entry.

Nothing is faked silently: every adjustment is disclosed in the timeline.

## Act 4 — The failure path (30s, optional but powerful)

16. Submit a second complaint as citizen (e.g. **Overflowing Waste**).
17. Official assigns it; worker starts it and submits a *photo that does not
    show the fix* (e.g. the same dark before-photo again).
18. Verification **fails** → the case flips to **REOPENED**, the citizen is
    notified, and because severity is HIGH it is **ESCALATED** — escalation
    history is on the case page. The official dashboard counters update.

---

## Q&A cheat-sheet

- **Where are the agent decisions?** Persisted in the `AgentActivity` table;
  rendered verbatim in every case page and the official dashboard feed.
- **What if YOLO/Bedrock aren't configured?** Clearly-labeled dev providers
  run instead; `/api/health/ai` and every log line disclose the provider.
- **Duplicate handling?** Geo + category + time + text-similarity scoring;
  matches are *linked* as "potentially related", not re-created.
- **SLA?** Severity-based hours (12/24/48/72, env-tunable), overdue sweep on
  dashboard load + `/api/cron/sla` for schedulers, escalation history.
- **Auth?** Real Google sign-in via Firebase; the ID token is verified
  server-side before a session cookie is issued; verified 401/403 paths.
- **Is the data real?** Seeded records are permanently badged `DEMO`;
  submissions made during the demo are genuine records in the database.
- **Tests?** 73 unit tests + a 58-check end-to-end smoke script
  (`node scripts/smoke.mjs http://localhost:3100`) + lint/typecheck/build.
