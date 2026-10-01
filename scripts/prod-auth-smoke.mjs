/**
 * Production auth smoke test — verifies the REAL Google-auth backend chain
 * against the deployed Vercel app without needing a human Google popup:
 *
 *   Firebase custom token → ID token (same thing a completed Google sign-in
 *   produces) → POST /api/auth/google → CivicShield session → duplicate login
 *   → /api/auth/me → logout → 401 → cleanup (test user removed everywhere).
 *
 * Usage: node scripts/prod-auth-smoke.mjs <baseUrl>   (e.g. https://your-app.vercel.app)
 *
 * Requires .env (local service-account file for minting) and
 * .env.vercel-test (npx vercel env pull) for the production DATABASE_URL.
 * ONLY the test user it created is deleted — no other data is touched.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const BASE = process.argv[2];
if (!BASE) {
  console.error("usage: node scripts/prod-auth-smoke.mjs <baseUrl>");
  process.exit(1);
}

function readEnv(file) {
  const out = {};
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  } catch { /* optional */ }
  return out;
}

const localEnv = readEnv(".env");
const vercelEnv = readEnv(".env.vercel-test");
const env = { ...localEnv, ...vercelEnv };

const apiKey = env.NEXT_PUBLIC_FIREBASE_API_KEY;
const saPath = env.FIREBASE_SERVICE_ACCOUNT_PATH;
const prodDbUrl = vercelEnv.DATABASE_URL || (vercelEnv.POSTGRES_URL ? vercelEnv.POSTGRES_URL : env.DATABASE_URL);

if (!apiKey || !saPath) {
  console.error("Missing NEXT_PUBLIC_FIREBASE_API_KEY or FIREBASE_SERVICE_ACCOUNT_PATH in env");
  process.exit(1);
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

// 1) Mint a real Firebase ID token (custom-token exchange = post-Google state)
const saFile = path.isAbsolute(saPath) ? saPath : path.resolve(saPath);
const { initializeApp, cert, deleteApp } = await import("firebase-admin/app");
const { getAuth } = await import("firebase-admin/auth");
const app = initializeApp({ credential: cert(saFile) });
const auth = getAuth(app);

const suffix = Date.now();
const uid = `prod-smoke-${suffix}`;
const email = `${uid}@civicshield-test.local`;

const customToken = await auth.createCustomToken(uid, { email });
const exRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: customToken, returnSecureToken: true }),
});
const exJson = await exRes.json();
if (!exJson.idToken) {
  console.error("Token exchange failed:", JSON.stringify(exJson).slice(0, 200));
  process.exit(1);
}
console.log(`Testing ${BASE} as firebase uid ${uid}`);

try {
  // 2) First sign-in
  const r1 = await fetch(`${BASE}/api/auth/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: exJson.idToken }),
  });
  const j1 = await r1.json().catch(() => ({}));
  const setCookies = r1.headers.getSetCookie ? r1.headers.getSetCookie() : [];
  check("first sign-in 200", r1.status === 200, `role=${j1.user?.role}`);
  check("session cookie set", setCookies.some((c) => c.startsWith("cs_session=") || c.startsWith("__Host-cs_session=")));
  const userId1 = j1.user?.id;
  const cookie = (setCookies.find((c) => c.includes("cs_session=")) || "").split(";")[0];

  // 3) Duplicate sign-in → same user, no duplicate row
  const r2 = await fetch(`${BASE}/api/auth/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: exJson.idToken }),
  });
  const j2 = await r2.json().catch(() => ({}));
  check("duplicate sign-in 200", r2.status === 200);
  check("same userId (no duplicate user)", Boolean(userId1) && j2.user?.id === userId1);

  // 4) Session works
  const r3 = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } });
  const j3 = await r3.json().catch(() => ({}));
  check("/api/auth/me 200", r3.status === 200, `email=${(j3.user?.email || "").slice(0, 18)}…`);

  // 5) Logout kills the session
  const r4 = await fetch(`${BASE}/api/auth/logout`, { method: "POST", headers: { cookie } });
  const cleared = (r4.headers.getSetCookie ? r4.headers.getSetCookie() : []).join(" ");
  check("logout 200", r4.status === 200);
  const afterCookie = (cleared.match(/cs_session=([^;]*)/) ? cleared.match(/cs_session=([^;]*)/)[0] : cookie).split(";")[0];
  const r5 = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: afterCookie } });
  check("/api/auth/me after logout 401", r5.status === 401);

  // 6) Unauthenticated + garbage-token negatives
  const r6 = await fetch(`${BASE}/api/auth/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: "totally-invalid-token-0123456789" }),
  });
  check("invalid token → 401", r6.status === 401);
  const r7 = await fetch(`${BASE}/api/auth/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nope: true }),
  });
  check("malformed body → 400", r7.status === 400);

  // 7) Cleanup: remove the CivicShield test user from the PRODUCTION db
  if (prodDbUrl) {
    process.env.DATABASE_URL_URL_ONLY = prodDbUrl;
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient({ datasources: { db: { url: prodDbUrl } } });
    const found = await prisma.user.count({ where: { firebaseUid: uid } });
    await prisma.user.deleteMany({ where: { firebaseUid: uid } });
    await prisma.$disconnect();
    check("prod db cleanup (exactly 1 test user row)", found === 1, `rows=${found}`);
  } else {
    console.log("SKIP  prod db cleanup — no DATABASE_URL in pulled env (delete manually if needed)");
  }
  check("firebase test user deleted", Boolean(await auth.deleteUser(uid).then(() => true).catch(() => false)));
} finally {
  await deleteApp(app);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
