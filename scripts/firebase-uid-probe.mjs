/**
 * Firebase UID probe — for each UID passed as an argument, check whether it
 * exists in the Firebase project configured via FIREBASE_SERVICE_ACCOUNT_PATH
 * (or FIREBASE_SERVICE_ACCOUNT_B64). Prints the configured project id and,
 * per UID: found / not-found (+ email, displayName when found).
 *
 * Usage: node --env-file=.env scripts/firebase-uid-probe.mjs <uid> [uid...]
 * Read-only: no user records are modified.
 */
import path from "node:path";

const { initializeApp, cert, deleteApp } = await import("firebase-admin/app");
const { getAuth } = await import("firebase-admin/auth");

const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
const credential = b64
  ? cert(JSON.parse(Buffer.from(b64, "base64").toString("utf8")))
  : cert(path.isAbsolute(saPath) ? saPath : path.resolve(saPath));

const app = initializeApp({ credential });
const auth = getAuth(app);
console.log("Firebase project:", app.options.projectId ?? "(unknown)");

const uids = process.argv.slice(2);
if (uids.length === 0) {
  console.error("usage: node scripts/firebase-uid-probe.mjs <uid> [uid...]");
  process.exit(1);
}

for (const uid of uids) {
  try {
    const u = await auth.getUser(uid);
    console.log(`${uid.slice(0, 6)}… FOUND  email=${u.email ?? "-"} provider=${u.providerData.map((p) => p.providerId).join(",")}`);
  } catch (e) {
    const code = e?.errorInfo?.code ?? e?.code ?? e?.message;
    console.log(`${uid.slice(0, 6)}… NOT FOUND (${code})`);
  }
}

await deleteApp(app);
