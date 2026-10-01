/**
 * Mint a CivicShield session for a linked Firebase user by exercising the
 * REAL production auth path: admin custom token → Firebase ID token →
 * POST /api/auth/google → httpOnly session cookie.
 *
 * Usage: node scripts/mint-session.mjs <firebaseUid> [baseUrl]
 * Prints the session cookie (k=<name>; value) to stdout. Test/dev use only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const [uid, baseUrl = "http://localhost:3100"] = process.argv.slice(2);
if (!uid) {
  console.error("usage: node scripts/mint-session.mjs <firebaseUid> [baseUrl]");
  process.exit(1);
}

function envVal(file, key) {
  const m = readFileSync(file, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^"|"$/g, "") : "";
}

const apiKey = envVal(".env", "NEXT_PUBLIC_FIREBASE_API_KEY");
const saPath = envVal(".env", "FIREBASE_SERVICE_ACCOUNT_PATH");
const saFile = path.isAbsolute(saPath) ? saPath : path.resolve(saPath);

const { initializeApp, cert, deleteApp } = await import("firebase-admin/app");
const { getAuth } = await import("firebase-admin/auth");
const app = initializeApp({ credential: cert(saFile) });
const auth = getAuth(app);

try {
  const customToken = await auth.createCustomToken(uid);
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
