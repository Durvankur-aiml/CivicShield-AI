# Deploy checklist — CivicShield AI on your own infrastructure

Everything below reflects the standalone-setup pass (own Firebase project
`civicshield-ai-32a2b`, own Supabase `meoncjdfhmsktnwwgsku`). **Never** run
`prisma db push --force-reset` or `prisma migrate reset` against either
database — it destroys data.

## 0. Do this first: rotate the leaked database password

The Supabase password appeared in pasted terminal output and a screenshot.

1. Supabase dashboard → project `meoncjdfhmsktnwwgsku` → **Project Settings →
   Database → Reset database password**.
2. Update **both** URLs in `.env` (and in every deploy target) with the new
   password — `DATABASE_URL` (port 6543, `?pgbouncer=true`) and `DIRECT_URL`
   (port 5432).
3. Verify: `node --env-file=.env scripts/dbcheck.mjs` must print
   `projectRef=meoncjdfhmsktnwwgsku` and the user rows.
4. Old-paste hygiene: the previously pasted password is now invalid; nothing
   else to revoke. Never paste full URLs with credentials again.

## 1. Environment — one source of truth

`.env.local` was removed: `.env` alone already points at the new database
(verified with `scripts/dbcheck.mjs` run with only `.env` loaded). Keep a
single `.env` locally, and configure the same variables on the host. The
`.env` file itself is gitignored — never commit it; `.env.example` documents
every variable.

Production environment must set:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | new DB, port **6543**, `?pgbouncer=true` |
| `DIRECT_URL` | new DB, port **5432** (Prisma CLI / schema push) |
| `NEXT_PUBLIC_FIREBASE_*` (6 vars) | the `civicshield-ai-32a2b` web config |
| `AUTH_SECRET` | **required** — `openssl rand -hex 32`; the app fails closed without it (≥32 chars enforced) |
| `FIREBASE_SERVICE_ACCOUNT_B64` | base64 of the service-account JSON (method 1 below) |
| `STAFF_EMAILS` | optional allowlist `"email:ROLE[:DEPT],…"` — omit for launch |
| `ADMIN_EMAILS` | optional; grants ADMIN at sign-in (ADMIN can never come from STAFF_EMAILS) |
| `CRON_SECRET` | required only if you enable the `/api/cron/sla` schedule (`vercel.json`) |

**Do NOT set `RATE_LIMIT_MULTIPLIER` in production** — it is a dev-only rate
limit relaxer (the app comment says so too). Never set
`FIREBASE_SERVICE_ACCOUNT_PATH` to a Windows path on a host.

## 2. Firebase Admin credentials on the host

The absolute Windows path (`secrets/firebase-admin.json`) will not exist on a
deploy target. Three supported methods, in priority order
(see `src/lib/firebaseAdmin.ts`):

1. `FIREBASE_SERVICE_ACCOUNT_B64` — the full service-account JSON, base64
   encoded, as one env var (recommended; verified working end-to-end in this
   pass):
   - Git Bash: `base64 -w0 service-account.json` → paste as the env value
   - PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("service-account.json"))`
2. `FIREBASE_SERVICE_ACCOUNT_PATH` — path to the JSON on the host.
3. `GOOGLE_APPLICATION_CREDENTIALS` — standard Google ADC.

With no credential the server fails closed (sign-in returns 503), so a missing
variable can never silently weaken auth.

## 3. Firebase console (project `civicshield-ai-32a2b`)

- **Authentication → Settings → Authorized domains**: add the deployed domain
  (and any preview domain). Google sign-in from a non-authorized domain fails
  in the browser before any API call.
- Keep the web API key public (it is an identifier, not a secret); security is
  server-side via the Admin SDK.
- Optional hardening: restrict the OAuth client to your domains in Google Cloud
  Console (Credentials → OAuth client).

## 4. Hosting region

Database is in **Tokyo** (`aws-0-ap-northeast-1`). Host the app in Tokyo or
Singapore. Cold-connection latency from India was measured at ~5.7s for the
landing probe — the landing page tolerates up to 10s (`DB_PROBE_MS` in
`src/app/page.tsx`) but same-region hosting removes the risk entirely. Node
processes keep Prisma's connection pool warm after the first request.

## 5. Database on first deploy

- Run `npx prisma db push` **once** from the deploy machine only if
  `prisma db pull`/Studio shows drift. The new DB already matches
  `schema.prisma` (verified via db pull + this app running against it).
- Never `--force-reset`; never `migrate reset`. `npm run demo:reset` is
  dev-only and destructive — do not point it at Supabase.
- Seeded data currently in the new DB: 6 departments, 4 users, 3 complaints.
  `ADMIN_EMAILS` bootstrap promotes at sign-in; departments can be re-seeded
  selectively with `prisma/seed.ts` if ever empty.

## 6. Smoke-test the deployment

1. `GET /` — no amber "Live database unreachable" banner; counts non-zero.
2. Google sign-in → `GET /api/auth/me` → HTTP 200 with the right role.
3. Submit a complaint with photo + location; confirm it appears in the
   citizen list and the official/worker queues.
4. If cron is configured: hit `/api/cron/sla` with the bearer secret once.

`scripts/mint-session.mjs <firebaseUid> [baseUrl] [--email <addr>]` exercises
the real `/api/auth/google` flow without a browser (test/dev only).
`scripts/dbcheck.mjs` prints which database a machine is pointed at (masked;
never prints passwords).

## 7. Stale-uid self-healing (what changed and why)

`resolveFirebaseUser` (`src/lib/firebaseAuth.ts`) now relinks an existing
account when the ID token's email is **verified** — including rows whose
`firebaseUid` went stale after the Firebase project replacement. Guard rails:

- Unverified-token emails can never claim an existing account (403, no
  create/update) — the account-takeover guard.
- `firebaseUid` is persisted only during that verified repair; it is never
  overwritten elsewhere.
- ADMIN rows are never demoted by relinking or by `STAFF_EMAILS`.

Consequence: all four existing rows (whose uids predate the new project) heal
on their owners' first sign-in — no one-off scripts like the old `fix-uid.js`
(which is now deleted along with `diag.js`/`diag2.js`).

## 8. Friend's database (old project)

The old DB (`wkvslqqinezsquxrslsf`) may have had a uid nulled by the earlier
one-off script. No action needed: under the friend's own Firebase project the
same verified-email relink logic re-attaches the account on next sign-in, and
if his checkout gets this code the repair applies there automatically.
