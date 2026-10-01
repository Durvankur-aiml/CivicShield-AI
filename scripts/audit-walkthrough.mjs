/**
 * Audit/demo walkthrough — exercises the REAL end-to-end flow against any
 * environment (local dev or the deployed Vercel app):
 *
 *   1. Mint a session for a linked Firebase user (real token exchange)
 *   2. Submit a complaint WITH a photo (agent pipeline + DB image storage)
 *   3. Fetch the complaint detail
 *   4. Fetch the stored image through the authenticated files route
 *
 * Usage: node --env-file=.env scripts/audit-walkthrough.mjs [baseUrl] [uid]
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const BASE = process.argv[2] || "http://localhost:3100";
// Test identity — NEVER hardcode a personal Firebase UID here.
// Pass as argv[3] or set TEST_USER_UID in .env (see .env.example).
const UID = process.argv[3] || process.env.TEST_USER_UID || "";
if (!UID) {
  console.error("usage: node scripts/audit-walkthrough.mjs [baseUrl] <firebaseUid>   (or set TEST_USER_UID)");
  process.exit(1);
}

function envVal(key, file = ".env") {
  const m = readFileSync(file, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^"|"$/g, "") : "";
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

// 1) Session via the real auth chain
const apiKey = envVal("NEXT_PUBLIC_FIREBASE_API_KEY");
const saPath = envVal("FIREBASE_SERVICE_ACCOUNT_PATH");
const saFile = path.isAbsolute(saPath) ? saPath : path.resolve(saPath);
const { initializeApp, cert, deleteApp } = await import("firebase-admin/app");
const { getAuth } = await import("firebase-admin/auth");
const app = initializeApp({ credential: cert(saFile) });
const auth = getAuth(app);

try {
  const customToken = await auth.createCustomToken(UID);
  const ex = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const exj = await ex.json();
  check("firebase id token minted", Boolean(exj.idToken));

  const r = await fetch(`${BASE}/api/auth/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: exj.idToken }),
  });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((c) => c.includes("cs_session="))?.split(";")[0];
  check("session exchanged", r.status === 200 && Boolean(cookie), `HTTP ${r.status}`);

  // 2) Submit complaint WITH photo
  const photo = readFileSync("scripts/fixtures/pothole.jpg");
  const form = new FormData();
  form.append("description", "Audit walkthrough: deep pothole on the main road, photo attached for verification");
  form.append("lat", "16.7050");
  form.append("lng", "74.2400");
  form.append("address", "Main Road, Kolhapur");
  form.append("photo", new Blob([photo], { type: "image/jpeg" }), "pothole.jpg");

  const sub = await fetch(`${BASE}/api/complaints`, { method: "POST", headers: { cookie }, body: form });
  const subj = await sub.json().catch(() => ({}));
  const c = subj.complaint ?? {};
  check("complaint created (photo upload)", sub.status === 201, `${c.refCode ?? JSON.stringify(subj).slice(0, 120)}`);
  check("agent pipeline ran", Boolean(c.agentRunId), `run=${c.agentRunId ?? "none"}`);
  check("category assigned", Boolean(c.category), `${c.category ?? "?"} / ${c.severity ?? "?"} / priority ${c.priority ?? "?"}`);
  check("department routed", Boolean(c.departmentCode), c.departmentCode ?? "none");

  // 3) Detail
  const detail = await fetch(`${BASE}/api/complaints/${c.complaintId}`, { headers: { cookie } });
  const dj = await detail.json().catch(() => ({}));
  check("detail fetch 200", detail.status === 200);
  const photoKey = dj.complaint?.photoKey;
  check("photo stored + linked", Boolean(photoKey), photoKey ?? "no photoKey");

  // 4) Image serves back through the authenticated route
  if (photoKey) {
    const img = await fetch(`${BASE}/api/files/${photoKey}`, { headers: { cookie } });
    const buf = await img.arrayBuffer();
    check("image serves back", img.status === 200 && buf.byteLength > 1000, `${img.status}, ${buf.byteLength} bytes, ${img.headers.get("content-type")}`);
  }

  console.log(`\n${results.filter((x) => x.ok).length}/${results.length} checks passed against ${BASE}`);
  if (c.complaintId) console.log("complaint:", `${BASE}/complaints/${c.complaintId}`);
  process.exit(results.every((x) => x.ok) ? 0 : 1);
} finally {
  await deleteApp(app);
}
