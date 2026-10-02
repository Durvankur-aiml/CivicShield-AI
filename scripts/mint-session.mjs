/**
 * Mint a CivicShield session for a linked Firebase user by exercising the
 * REAL production auth path: admin custom token → Firebase ID token →
 * POST /api/auth/google → httpOnly session cookie.
 *
 * Usage: node scripts/mint-session.mjs <firebaseUid> [baseUrl] [--email <addr>]
 *
 * --email attaches { email, email_verified: true, name } custom claims to the
 * custom token, simulating a Google sign-in for that address (the custom token
 * itself carries no email). This exercises the by-email account-linking /
 * stale-uid repair path in resolveFirebaseUser without a browser.
 *
 * Prints the session cookie (k=<name>; value) to stdout. Test/dev use only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const uid = argv[0];
const rest = argv.slice(1);
const emailIdx = rest.indexOf("--email");
const email = emailIdx !== -1 ? rest[emailIdx + 1] : undefined;
if (emailIdx !== -1) rest.splice(emailIdx, email === undefined ? 1 : 2);
const baseUrl = rest.find((a) => !a.startsWith("--")) ?? "http://localhost:3100";
if (!uid) {
  console.error("usage: node scripts/mint-session.mjs <firebaseUid> [baseUrl] [--email <addr>]");
  process.exit(1);
}

function envVal(file, key) {
  const m = readFileSync(file, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^"|"$/g, "") : "";
}

const apiKey = envVal(".env", "NEXT_PUBLIC_FIREBASE_API_KEY");

// Process env wins over the .env file (mirrors how the Next.js server resolves
// credentials, incl. the deployment-first FIREBASE_SERVICE_ACCOUNT_B64).
const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64 || envVal(".env", "FIREBASE_SERVICE_ACCOUNT_B64");
const saPathRaw = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || envVal(".env", "FIREBASE_SERVICE_ACCOUNT_PATH");
const saFile = path.isAbsolute(saPathRaw) ? saPathRaw : path.resolve(saPathRaw);

const { initializeApp, cert, deleteApp } = await import("firebase-admin/app");
const { getAuth } = await import("firebase-admin/auth");
const app = initializeApp({
  credential: b64 ? cert(JSON.parse(Buffer.from(b64, "base64").toString("utf8"))) : cert(saFile),
});
const auth = getAuth(app);

const claims = email ? { email, email_verified: true, name: email.split("@")[0] } : undefined;

try {
  const customToken = await auth.createCustomToken(uid, claims);
  const ex = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const exj = await ex.json();
  if (!exj.idToken) throw new Error("token exchange failed: " + JSON.stringify(exj).slice(0, 150));

  const r = await fetch(`${baseUrl}/api/auth/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: exj.idToken }),
  });
  const body = await r.json().catch(() => ({}));
  const cookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  const session = cookies.find((c) => c.startsWith("cs_session=") || c.startsWith("__Host-cs_session="));
  if (!session) throw new Error(`no session cookie (HTTP ${r.status}): ` + JSON.stringify(body).slice(0, 200));
  console.log(session.split(";")[0]);
} finally {
  await deleteApp(app);
}
