# CivicShield AI — Phase 1 Foundation Hardening Report

Date: 2026-09-29 · Scope: P0 stabilization only (no V2 features) · Verified by test execution, not inspection alone.

---

## 1. Changes Made (file-by-file)

### Database configuration (P0-1)
- **`prisma/schema.prisma`** — Comment header rewritten: canonical strategy is **PostgreSQL everywhere** (local Postgres for dev, Supabase Postgres for deployment). The hard `directUrl = env("DIRECT_URL")` requirement is now **commented out** (Prisma resolves `env()` references eagerly, so an uncommented line makes every CLI command fail with P1012 whenever DIRECT_URL is unset — which is the default fresh-setup state). `.env.example` documents how to enable it for pooled Supabase setups. **No model changes.** Verified: `prisma validate` + `prisma generate` pass with ONLY `DATABASE_URL` set.
- **`.env.example`** — Full rewrite: PostgreSQL `DATABASE_URL` examples (local + Supabase pooled), optional `DIRECT_URL` with explanation, `AUTH_SECRET` marked REQUIRED/fail-closed, `CRON_SECRET` documented for both `Authorization: Bearer` (Vercel native) and `x-cron-secret`, test-script env vars (`TEST_USER_UID`, `CIVICSHIELD_ROLE_ACCOUNTS`), YOLO weight-availability note.
- **`scripts/demo-reset.mjs`** — Rewritten for the canonical strategy: `prisma db push --force-reset` + seed; shows the exact target with credentials masked; requires `--yes` for PostgreSQL (refuses REMOTE hosts without it); SQLite file URLs still work (legacy). The old guard *blocked all PostgreSQL*, making the documented workflow impossible.
- **Docs** (`README.md`, `docs/ARCHITECTURE.md`, `docs/DEMO.md`, `docs/HACKATHON_CHECKLIST.md`, `docs/DIAGRAMS.md`, `docs/PPT_CONTENT.md`) — every SQLite/`--force` reference replaced with the PostgreSQL strategy and the `--yes` flow; test counts updated (31→73 unit).

### AUTH_SECRET (P0-2)
- **`src/lib/auth.ts`** — `resolveSessionSecret()`: production **fails closed** on missing/empty/whitespace secret and rejects secrets < 32 chars; error messages never contain the secret. Development keeps an explicit, documented placeholder. Signing/verification resolve lazily (a module-load-time throw would have broken `next build`).

### Reference codes (P0-3)
- **`src/lib/refCode.ts`** (NEW) — high-water-mark allocation: next candidate = current year's MAX `refCode` sequence + 1 (never row counts); `withUniqueRefCode()` retries on unique-violation races (max 5 attempts); format unchanged (`CS-YYYY-NNNNNN`).
- **`src/lib/agent/tools.ts`** — `createComplaint()` refCode is now optional: omitted → safe allocation; explicit code (demo seeds/tests) honored as-is.
- **`src/lib/agent/orchestrator.ts`** — `count() + 1` removed; downstream log/return values use `complaint.refCode`.

### Verification MIME (P0-4)
- **`src/app/api/complaints/[id]/verify/route.ts`** — BEFORE image bytes **and** MIME now loaded from storage (`readImage`) and passed to `verifyResolution` (`beforeMime` was hardcoded `null`, silently disabling real before/after comparison). Dev verifier untouched; provider labeling untouched.

### SLA scheduler + robustness (P0-5, P0-6)
- **`vercel.json`** (NEW) — cron `*/15 * * * *` → `/api/cron/sla`.
- **`src/app/api/cron/sla/route.ts`** — timing-safe secret comparison (`node:crypto` `timingSafeEqual`); accepts `Authorization: Bearer $CRON_SECRET` (Vercel native), `x-cron-secret`, or OFFICIAL session; fail-closed when `CRON_SECRET` unset; response reports `checked/escalated/failed/ok`; secret never echoed.
- **`src/lib/agent/tools.ts`** — `SlaSweepResult` type (`{ refCode, escalated, error? }`); `checkSla()` wraps each complaint in try/catch: failure → logged safely (refCode + message only) + returned on that record → sweep continues. Idempotency filter (`isOverdue: false`) unchanged; escalation rules unchanged.

### Personal data removal (P0-7)
- **`scripts/verify-roles.mjs`** — two real Firebase UIDs + personal labels removed; accounts now parsed from `CIVICSHIELD_ROLE_ACCOUNTS` env (`uid:ROLE:Label,...`); default URL removed (baseUrl required).
- **`scripts/audit-walkthrough.mjs`** — real UID + email comment removed; identity from argv or `TEST_USER_UID` (fails with usage when absent).
- **`scripts/prod-auth-smoke.mjs`** — deployed-URL default removed (argument required).
- **`tests/firebaseAuth.test.ts`**, **`docs/AUTHENTICATION.md`** — `gmail.com` placeholders → IANA-reserved `example.com`.
- Verified: repo-wide grep for the removed identifiers = clean.

### Security hardening (§8)
- **`src/app/api/demo/sla/route.ts`** — demo controls now require explicit `DEMO_MODE=true` on **any deployed environment** (`NODE_ENV=production` **or** `VERCEL=1`/`VERCEL_ENV` present → covers Vercel previews); local dev unchanged; `DEMO_MODE=false` always refuses.
- **`next.config.ts`** — baseline headers on all routes: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(self), microphone=(self), geolocation=(self)`. No CSP (would require testing against Firebase/Leaflet/fonts — documented).
- **`src/app/api/files/[...key]/route.ts`** — explicit `nosniff` on served images. Key regex, auth requirement, traversal guard unchanged.

### Tests (§11, §12)
- **NEW `tests/helpers/prisma-mock.ts`** — shared mock Prisma client (`vi.hoisted` holder so `vi.mock` factories work), P2002 error factory.
- **NEW `tests/authSecret.test.ts`** (9) — prod valid/missing/empty/weak; no secret in errors; dev placeholder works; wrong-secret tokens rejected.
- **NEW `tests/refCode.test.ts`** (13) — formatting; high-water-mark from MAX (not counts; per-year; deletion-proof; 6-digit rollover); race retry; attempt budget; non-unique errors not swallowed; `createComplaint` allocation + explicit-code preservation + SLA clock.
- **NEW `tests/sla.test.ts`** (14) — sweep: overdue flag + event + escalation; no escalation for LOW/MEDIUM; idempotent query shape; multi-complaint processing; **per-complaint failure isolation** with logged error; total query failure propagates. Cron: Bearer + `x-cron-secret` accepted; wrong/empty/unset secret → 401; secret never echoed; partial failure → `ok:false` (still 200); GET/POST share the handler.
- **NEW `tests/yoloVerifier.test.ts`** (3) — provider WIRING: BEFORE bytes + MIME + AFTER + category in multipart; before omitted when absent; non-OK response throws. Header explicitly states real YOLO inference is NOT tested (weight unavailable).
- **NEW `tests/demoSla.test.ts`** (4) — 403 on production/Vercel-preview/`VERCEL=1` without `DEMO_MODE=true`; `DEMO_MODE=false` refused in dev.
- Pre-existing 31 tests: untouched and green (RBAC-adjacent suites included).

---

## 2. Bugs Fixed

**P0-1 — contradictory database configuration**
- Problem: schema demanded PostgreSQL + `DIRECT_URL`; every doc/script documented SQLite; `demo:reset` *refused* PostgreSQL → a fresh clone could not run the documented setup at all (`prisma validate` failed first).
- Root cause: partial migration to Postgres/Supabase left docs+scripts on the old SQLite story.
- Fix: one canonical strategy (PostgreSQL everywhere), schema comment aligned, `DIRECT_URL` optional, `demo:reset` rewritten, docs synced.
- Verification: `prisma validate` + `prisma generate` clean with a PostgreSQL URL and no `DIRECT_URL`; guard behavior executed live (masked target + `--yes` requirement); repo-wide SQLite-grep clean in app/docs/scripts.

**P0-2 — known fallback session secret**
- Problem/Risk: `AUTH_SECRET ?? "civicshield-dev-secret-change-me"` let an unset production secret sign forgeable admin sessions.
- Fix: fail-closed in production (+ ≥32-char minimum); documented dev placeholder only.
- Verification: 9 unit tests cover every acceptance case; secret never appears in error output (tested).

**P0-3 — race-condition reference codes**
- Problem: `count()+1` → duplicates under concurrency (unique-violation 500s) and reuse after deletions.
- Root cause: sequence derived from mutable row count.
- Fix: MAX-based high-water mark + DB unique-constraint arbitration + bounded retry.
- Verification: 13 unit tests (sequential, race-interleaved retries, seeded-code preservation, reset behavior modeled via explicit-code path). Note honestly recorded in §6: true multi-connection concurrency must be confirmed by the E2E run on real Postgres.

**P0-4 — BEFORE image never sent to the real verifier**
- Problem: `beforeMime: null` in the verify route → `YoloResolutionVerifier` skipped the `before` multipart part → real before/after comparison silently disabled.
- Root cause: storage read returned bytes but the MIME was discarded at the call site.
- Fix: bytes + MIME propagated together.
- Verification: 3 wiring tests prove the multipart contains before+after with correct MIMEs and category; failures still surface (labeled fallback untouched).

**P0-5 — SLA sweep had no production trigger**
- Problem: sweep only ran via dashboard loads / manual call / demo button.
- Fix: `vercel.json` cron (15 min) + hardened, timing-safe, dual-header authentication on the endpoint.
- Verification: 8 cron-auth tests incl. fail-closed behavior.

**P0-6 — one bad record could abort the sweep**
- Fix: per-complaint try/catch; errors logged with refCode and returned per record.
- Verification: dedicated isolation test (bad record processed as `error`, good record still handled; error observably logged, no secrets).

**P0-7 — real personal identifiers committed**
- Fix: env-configurable identities; identifiers scrubbed; grep-verified clean.

---

## 3. Database Changes

- **Migration name:** none — this project has no migration history (schema is applied via `prisma db push`); introducing one was correctly out of scope.
- **Schema changes:** NONE to models. Only the `datasource` block (removed the hard `directUrl` requirement) and the header comment changed. `prisma generate` + `validate` verified.
- **Migration safety:** N/A (no DDL change) — zero risk to the existing production database.
- **Seed/reset:** `seed.ts` untouched (already provider-agnostic; seeded codes `CS-2026-000001…6` preserved). `demo-reset.mjs` rewritten as described; targets the configured PostgreSQL and re-seeds identically.

---

## 4. Security Changes

1. AUTH_SECRET fail-closed in production (+ length policy, no secret leakage). 2. Cron endpoint: timing-safe comparison, Vercel-native Bearer support, fail-closed without `CRON_SECRET`. 3. Demo SLA controls default-secure on all deployed environments incl. previews. 4. Baseline security headers app-wide + `nosniff` on image serving. 5. All real personal identifiers removed from committed scripts; test identities now env-configured. 6. Verified preserved: RBAC guards, httpOnly `__Host-` cookie session, zod validation, upload MIME/size allowlist, path-traversal-safe file keys, labeled AI-provider fallbacks.

---

## 5. Test Results (actual runs, this environment)

```text
Typecheck (tsc --noEmit): PASS (0 errors)
Lint (eslint):            PASS (0 problems)
Unit tests (vitest):      73/73 passed (9 files; 31 pre-existing + 42 new)
Production build:         PASS (next build, 26 routes compile)
E2E smoke (scripts/smoke.mjs): NOT RUN — see Remaining Issues #1
```

---

## 6. Remaining Issues

1. **E2E smoke suite not executed here.** It requires a live PostgreSQL `DATABASE_URL`, a running server, and Firebase env credentials. This environment has no Postgres/Docker and no secrets (and none may be invented per Rule 5). The suite is compatible with the new configuration (no SQLite assumptions; only `demo-reset` had them). **Required gate before deployment:** provision Postgres → `npm run demo:reset -- --yes` → `npm run dev` → `node scripts/smoke.mjs`.
2. **Real YOLO inference remains untested** — `best.pt` is not obtainable here (documented in `vision-service/README.md`). What IS now tested: the provider wiring, including the fixed BEFORE-MIME propagation. The dev-provider honesty labeling is unchanged.
3. **True concurrent-submission safety** is enforced by the DB unique constraint + retry (unit-tested at the boundary); the final multi-connection proof lands with the E2E run on real Postgres.
4. `requireLiveUser()` session revocation is still dead code (audit item; behavior-preserving scope excluded it) — Phase 2 candidate.
5. Magic-byte upload validation documented as an improvement, deliberately not implemented (§8.4 instruction).
6. Pre-existing accepted trade-offs left untouched by design: in-memory rate limiter with `x-forwarded-for` keying; side-effectful `/api/stats` GET (lazy sweep); personal-email privacy note — no other regressions found.
7. **Operator action required on deploy:** set `DATABASE_URL`, `AUTH_SECRET`, `CRON_SECRET` (and Firebase vars). `vercel.json` cron will 401 until `CRON_SECRET` exists on the deployment — intentional.

---

## 7. Files Modified (17)

`prisma/schema.prisma` · `.env.example` · `src/lib/auth.ts` · `src/lib/agent/tools.ts` · `src/lib/agent/orchestrator.ts` · `src/app/api/complaints/[id]/verify/route.ts` · `src/app/api/cron/sla/route.ts` · `src/app/api/demo/sla/route.ts` · `src/app/api/files/[...key]/route.ts` · `next.config.ts` · `scripts/demo-reset.mjs` · `scripts/verify-roles.mjs` · `scripts/audit-walkthrough.mjs` · `scripts/prod-auth-smoke.mjs` · `README.md` · `docs/ARCHITECTURE.md` · `docs/DEMO.md` · `docs/HACKATHON_CHECKLIST.md` · `docs/DIAGRAMS.md` · `docs/PPT_CONTENT.md` · `docs/AUTHENTICATION.md` · `tests/firebaseAuth.test.ts`

## 8. Files Added (8)

`src/lib/refCode.ts` · `vercel.json` · `tests/helpers/prisma-mock.ts` · `tests/authSecret.test.ts` · `tests/refCode.test.ts` · `tests/sla.test.ts` · `tests/yoloVerifier.test.ts` · `tests/demoSla.test.ts` · (this report: `docs/PHASE1_REPORT.md`)

## 9. Files Deleted

None.

---

## 10. V2 Readiness

**Phase 2 — Worker Domain + Automatic Assignment: CONDITIONALLY READY.**

All code-level P0 blockers are fixed and unit-verified; the repository is internally consistent and reproducible. What remains before the gate is green is exactly one thing: **the E2E smoke run against a real PostgreSQL database with Firebase env configured** (Remaining Issue #1) — an environment/operations step, not a code step. Once that passes, Phase 2 schema work (WorkerProfile, Assignment, Notification) can begin immediately on a stable foundation: the canonical database, fail-closed auth, safe refCodes (which Phase 2's assignment flow will reuse), a scheduled SLA heartbeat (which Phase 2's escalation ladder will extend), and a clean personal-data-free repo are all in place.
