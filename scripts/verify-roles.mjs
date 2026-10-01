/**
 * Role verification: signs in configured Google-linked accounts through the
 * production auth chain and reports their applied roles + role-scoped access.
 *
 * Usage: node --env-file=.env scripts/verify-roles.mjs [baseUrl]
 *
 * Accounts are read from the CIVICSHIELD_ROLE_ACCOUNTS environment variable
 * (NEVER hardcode personal Firebase UIDs or emails here):
 *   CIVICSHIELD_ROLE_ACCOUNTS="<firebaseUid>:OFFICIAL:LabelA,<uid>:WORKER:LabelB"
 * A bare uid ("<uid>") is treated as OFFICIAL, mirroring STAFF_EMAILS.
 */
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";

const BASE = process.argv[2];
if (!BASE) {
  console.error("usage: node scripts/verify-roles.mjs <baseUrl>   (e.g. http://localhost:3000)");
  process.exit(1);
}
const env = {};
for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}
const saPath = env.FIREBASE_SERVICE_ACCOUNT_PATH.replace(/^["']|["']$/g, "");
const saResolved = path.isAbsolute(saPath) ? saPath : path.resolve(saPath);
if (!existsSync(saResolved)) {
  console.error("service account not found at", saResolved);
  process.exit(1);
}

const { initializeApp, cert, deleteApp } = await import("firebase-admin/app");
const { getAuth } = await import("firebase-admin/auth");
const app = initializeApp({ credential: cert(saResolved) });
const auth = getAuth(app);

const ROLES = { OFFICIAL: "OFFICIAL", WORKER: "WORKER" };

function parseRoleAccounts(raw) {
  const accounts = [];
  for (const part of (raw ?? "").split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const [uid, roleRaw, labelRaw] = entry.split(":").map((s) => s.trim());
    if (!uid) continue;
    const role = (roleRaw || "OFFICIAL").toUpperCase();
    if (!Object.values(ROLES).includes(role)) continue;
    accounts.push({ label: labelRaw || uid.slice(0, 6), uid, expected: role });
  }
  return accounts;
}

const ACCOUNTS = parseRoleAccounts(process.env.CIVICSHIELD_ROLE_ACCOUNTS);
if (ACCOUNTS.length === 0) {
  console.error(
    "No accounts configured. Set CIVICSHIELD_ROLE_ACCOUNTS=\"<firebaseUid>:OFFICIAL:LabelA,<uid>:WORKER:LabelB\" in .env (never commit real UIDs)."
  );
  process.exit(1);
}

try {
  for (const { label, uid, expected } of ACCOUNTS) {
    const ct = await auth.createCustomToken(uid);
    const ex = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${env.NEXT_PUBLIC_FIREBASE_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: ct, returnSecureToken: true }) }
    );
    const exj = await ex.json();
    const r = await fetch(`${BASE}/api/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: exj.idToken }),
    });
    const j = await r.json().catch(() => ({}));
    const cookie = (r.headers.getSetCookie?.() ?? []).find((c) => c.includes("cs_session="))?.split(";")[0];
    const role = j.user?.role ?? `HTTP ${r.status}`;
    const ok = role === expected ? "OK" : "MISMATCH";
    let extra = "";
    if (cookie && role === "OFFICIAL") {
      const w = await fetch(`${BASE}/api/official/workers`, { headers: { cookie } });
      extra = ` | workers list HTTP ${w.status}`;
    }
    if (cookie && role === "WORKER") {
      const a = await fetch(`${BASE}/api/complaints?scope=assigned`, { headers: { cookie } });
      extra = ` | assigned-task list HTTP ${a.status}`;
    }
    console.log(`${label} -> role: ${role} (expected ${expected}) [${ok}]${extra}`);
  }
} finally {
  await deleteApp(app);
}
