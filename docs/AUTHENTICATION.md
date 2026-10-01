# CivicShield AI — Google Authentication

Real Google/Gmail sign-in via **Firebase Authentication**. This is the only
authentication path in the product — no email/password, no OTP, no phone, no
demo accounts, no user-chosen roles.

```
Browser                    Firebase                CivicShield server
───────                    ────────                ──────────────────
Continue with Google  ──▶  Google Sign-In
                           firebase user ──▶ ID token (JWT)
                                        ──▶  POST /api/auth/google {idToken}
                                             firebase-admin verifyIdToken()
                                             find-or-create User (firebaseUid)
                                             session JWT in httpOnly cookie
        ◀──────────────  authenticated application  ───────────────
```

## 1. Firebase project setup (one-time, manual)

1. Create a project at <https://console.firebase.google.com>.
2. **Build → Authentication → Get started → Sign-in method → Google → Enable.**
   Set a support email. Save.
3. **Build → Authentication → Settings → Authorized domains** — add:
   - `localhost` (already allowed by default for dev)
   - your production domain (e.g. `civicshield.vercel.app`)
4. **Project settings (gear) → General → Your apps → Web app** — register a web
   app and copy the config values into the `NEXT_PUBLIC_FIREBASE_*` env vars
   (see `.env.example`).
5. **Project settings → Service accounts → Generate new private key** — save the
   JSON **outside the repository** and expose it to the server via one of:
   - `FIREBASE_SERVICE_ACCOUNT_B64` (base64 of the JSON — recommended for hosting), or
   - `FIREBASE_SERVICE_ACCOUNT_PATH` (absolute path to the file), or
   - `GOOGLE_APPLICATION_CREDENTIALS` (standard ADC).

## 2. Environment variables

Public web config (safe for the browser — Firebase web API keys identify, they
do not authorize; all security is enforced server-side):

```
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=<project>.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
```

Server-side admin credential (exactly one method; never commit, never
`NEXT_PUBLIC_*`, never in source):

```
FIREBASE_SERVICE_ACCOUNT_B64=...   # or FIREBASE_SERVICE_ACCOUNT_PATH / ADC
```

Server-side staff mapping (optional — this is NOT user-facing role selection):

```
# "email:ROLE[:DEPT],…" — bare emails mean OFFICIAL. Roles: OFFICIAL | WORKER.
# STAFF_EMAILS=me@example.com:OFFICIAL,worker2@example.com:WORKER:SWM
```

Every Google user becomes a normal CITIZEN. Emails listed in `STAFF_EMAILS`
are mapped server-side at login so the official command center and worker
dashboards remain usable — there is still no signup role choice anywhere.

## 3. Identity & data model

`prisma/schema.prisma` — `User`:

- `firebaseUid String? @unique` — the verified external identity reference
- `email @unique`, `name`, `image`, `phone`, `role`, `departmentId`, `karma`
- `passwordHash String?` — nullable only for legacy/seed staff rows; **no
  password login path exists in the application**

First login: verified token → no user with that `firebaseUid` → if an existing
account with the same verified email has never had a Firebase identity, it is
linked (this is how seeded staff rows are claimed) → otherwise a new user is
created (role CITIZEN unless the server-side allowlist says otherwise).

Returning login: looked up **by `firebaseUid`**; the same Google account always
maps to the same CivicShield user — no duplicates. Only volatile identity
fields (name/avatar, allowlisted role/department) are refreshed.

## 4. Session handling

- The Firebase ID token is **never stored** by this app; it is exchanged once.
- The server issues its own session JWT (existing `jose` HS256, `AUTH_SECRET`)
  in an httpOnly, SameSite=Lax, Secure-in-production cookie (`cs_session`,
  `__Host-cs_session` in production), 7-day expiry.
- API routes call `requireUser()` / `requireRole()` exactly as before —
  unchanged, and no client-supplied user id/email/role is ever trusted.
- Logout clears both layers: `signOut()` in Firebase (browser) + cookie delete.

## 5. Protected endpoints

All previously protected endpoints keep their guards: complaints (create/list/
detail/status/assign/verify/close/escalate), files, stats, activity, workers,
cron, demo-SLA. Public by design: landing page, `/api/health/ai`,
`/api/auth/google` (itself rate-limited), `/api/auth/logout`.

## 6. Error handling

Firebase errors are mapped to friendly messages (popup closed/blocked, network,
unauthorized domain…); raw Firebase error codes are never shown. Server-side
verification failures return a generic 401 with the technical reason logged
server-side only. With no server credential configured the exchange endpoint
fails **closed** (503) — it can never fall back to trusting the client.

## 7. How to test Google login locally

1. Fill the `NEXT_PUBLIC_FIREBASE_*` vars and one server credential method.
2. `npm run dev` → open `/login` → the amber "not configured" notice disappears.
3. Click **Continue with Google** → choose an account.
4. You land on `/citizen`; refresh — still signed in (session cookie).
5. Submit a complaint; it is owned by your new user.
6. Sign out → redirected to `/login`; visiting `/citizen` afterwards shows the
   sign-in prompt; protected APIs return 401.
7. Sign in again with the same account → same user, no duplicate row
   (`User.firebaseUid` stable, `complaints.reporterId` unchanged).

## 8. Security notes

- Identity comes only from `verifyIdToken()` (revocation-checked) server-side.
- Rate-limited exchange endpoint; malformed bodies are 400, invalid tokens 401.
- Service-account JSON is gitignored (`.env` is too); only names live in
  `.env.example`.
- Add your deployment domain to Firebase **Authorized domains** or Google will
  reject the popup (`auth/unauthorized-domain`).
