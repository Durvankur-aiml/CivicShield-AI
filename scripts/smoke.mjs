/**
 * CivicShield AI — end-to-end smoke test.
 * Usage: node scripts/smoke.mjs [baseUrl]
 * Exercises: auth → submit → agent pipeline → detail → official assign →
 * worker start → evidence upload → AI verification → authz/invalid-input checks.
 *
 * Authentication note: production auth is Google/Firebase-only. This suite
 * does NOT use any demo login (none exists). Instead it mints its own test
 * session cookies locally — signed with the server's own AUTH_SECRET for real
 * seeded user rows — an ISOLATED TEST MECHANISM that requires file access to
 * the repo and never ships in the app. The /api/auth/google exchange path is
 * separately covered by negative tests in section 1.
 */
import { createSigner } from "../tests/helpers/session-signer.mjs";
const signSession = createSigner();
const BASE = process.argv[2] ?? "http://localhost:3100";

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

const jars = {};
async function call(who, path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  if (jars[who]) headers.cookie = jars[who];
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    opts.body = JSON.stringify(opts.json);
    opts.method = opts.method ?? "POST";
  }
  const res = await fetch(`${BASE}${path}`, { ...opts, headers, redirect: "manual" });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) {
    const [pair] = c.split(";");
    if (pair.startsWith("cs_session=")) jars[who] = pair;
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

function jpegFixture(kind) {
  const fill = kind === "bright" ? 200 : 12;
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  return new Blob([Buffer.concat([head, Buffer.alloc(80_000, fill), Buffer.from([0xff, 0xd9])])], { type: "image/jpeg" });
}

async function main() {
  console.log(`\nCivicShield AI smoke test → ${BASE}\n`);

  // ── 0. Provider transparency ────────────────────────────────────────────
  console.log("[0] AI provider transparency");
  const health = await call("anon", "/api/health/ai");
  check("GET /api/health/ai is public", health.status === 200);
  check("providers are disclosed", Boolean(health.data?.providers?.vision));

  // ── 1. Auth ─────────────────────────────────────────────────────────────
  console.log("[1] Authentication");
  // Google exchange endpoint: fail-closed negatives (no real Google account
  // is available in CI; positive-path verification is a documented manual step).
  const googleNoToken = await call("anon", "/api/auth/google", { json: {} });
  check("google exchange without token rejected (400)", googleNoToken.status === 400, `got ${googleNoToken.status}`);
  const googleBadToken = await call("anon", "/api/auth/google", { json: { idToken: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.fake.token" } });
  check("google exchange rejects invalid token (401/503)", [401, 503].includes(googleBadToken.status), `got ${googleBadToken.status}`);
  const loginRemoved = await call("anon", "/api/auth/login", { json: { email: "x@x.com", password: "y" } });
  check("demo password login removed (404)", loginRemoved.status === 404, `got ${loginRemoved.status}`);

  // Isolated test sessions (require repo file access; not an app feature).
  // Pre-populate the cookie jars, then verify each session resolves a live user.
  jars.official = `cs_session=${await signSession("official@civicshield.demo", "OFFICIAL")}`;
  jars.citizen = `cs_session=${await signSession("citizen@civicshield.demo", "CITIZEN")}`;
  jars.worker = `cs_session=${await signSession("worker@civicshield.demo", "WORKER")}`;
  const official = await call("official", "/api/auth/me");
  check("official test session works", official.status === 200 && official.data.user.role === "OFFICIAL", JSON.stringify(official.data));
  const citizen = await call("citizen", "/api/auth/me");
  check("citizen test session works", citizen.status === 200 && citizen.data.user.role === "CITIZEN");
  const worker = await call("worker", "/api/auth/me");
  check("worker test session works", worker.status === 200 && worker.data.user.role === "WORKER");

  // ── 2. Citizen submits complaint (photo + demo vision hint) ─────────────
  console.log("[2] Complaint submission → agent pipeline");
  const fd = new FormData();
  fd.set("description", "Deep dangerous pothole on the main road near the bus stand, two-wheelers skid every evening");
  fd.set("lat", "16.6952");
  fd.set("lng", "74.4574");
  fd.set("address", "Smoke test junction");
  fd.set("language", "en");
  fd.set("demoHint", "Pothole");
  fd.set("photo", jpegFixture("dark"), "pothole.jpg");
  const created = await call("citizen", "/api/complaints", { method: "POST", body: fd });
  check("complaint created (201)", created.status === 201, JSON.stringify(created.data));
  const c = created.data?.complaint ?? {};
  check("category = POTHOLE", c.category === "POTHOLE");
  check("severity HIGH/CRITICAL (danger language)", ["HIGH", "CRITICAL"].includes(c.severity), `got ${c.severity}`);
  check("routed to PWD", c.departmentCode === "PWD");
  check("duplicate linked to CS-2026-000001", c.duplicateOfRef === "CS-2026-000001", `got ${c.duplicateOfRef}`);

  const detail = await call("citizen", `/api/complaints/${c.complaintId}`);
  const acts = detail.data?.complaint?.agentActivities ?? [];
  check("detail fetch", detail.status === 200);
  const agents = new Set(acts.map((a) => a.agent));
  check("VisionAgent logged", agents.has("VisionAgent"));
  check("TriageAgent logged", agents.has("TriageAgent"));
  check("DuplicateAgent logged", agents.has("DuplicateAgent"));
  check("RoutingAgent logged", agents.has("RoutingAgent"));
  check("DispatchAgent logged", agents.has("DispatchAgent"));

  // ── 3. Official dashboard data ──────────────────────────────────────────
  console.log("[3] Official dashboard data");
  const list = await call("official", "/api/complaints?scope=all&status=RECEIVED");
  check("official sees complaint list", list.status === 200 && Array.isArray(list.data.complaints));
  const stats = await call("official", "/api/stats");
  check("stats endpoint", stats.status === 200 && typeof stats.data.totals?.total === "number");
  const workers = await call("official", "/api/official/workers");
  check("worker list for assignment", workers.status === 200 && workers.data.users?.length >= 3);
  const roadsWorker = workers.data.users.find((w) => w.name.includes("Roads")) ?? workers.data.users[0];

  // ── 4. Assignment + worker flow ─────────────────────────────────────────
  console.log("[4] Assignment → worker flow");
  const assign = await call("official", `/api/complaints/${c.complaintId}/assign`, { json: { workerId: roadsWorker.id } });
  check("official assigns worker", assign.status === 200 && assign.data.status === "ASSIGNED", JSON.stringify(assign.data));

  const citizenAssign = await call("citizen", `/api/complaints/${c.complaintId}/assign`, { json: { workerId: roadsWorker.id } });
  check("citizen cannot assign (403)", citizenAssign.status === 403);

  const accept = await call("worker", `/api/complaints/${c.complaintId}/status`, { json: { action: "accept" } });
  check("worker accepts assignment", accept.status === 200, JSON.stringify(accept.data));
  const start = await call("worker", `/api/complaints/${c.complaintId}/status`, { json: { action: "start" } });
  check("worker starts work", start.status === 200 && start.data.status === "IN_PROGRESS");

  // ── 5. Resolution evidence → AI verification ────────────────────────────
  console.log("[5] AI resolution verification");
  const vfd = new FormData();
  vfd.set("afterImage", jpegFixture("bright"), "after.jpg");
  vfd.set("note", "Filled and compacted");
  const verify = await call("worker", `/api/complaints/${c.complaintId}/verify`, { method: "POST", body: vfd });
  check("verification ran", verify.status === 200, JSON.stringify(verify.data));
  check("verdict verified=true", verify.data?.verdict?.verified === true);
  check("complaint RESOLVED", verify.data?.status === "RESOLVED");
  check("verdict carries provider label", Boolean(verify.data?.verdict?.provider));

  const after = await call("citizen", `/api/complaints/${c.complaintId}`);
  check("citizen sees verified complaint", after.data?.complaint?.verified === true);
  check("timeline recorded verification", (after.data?.complaint?.events ?? []).some((e) => e.type === "VERIFICATION"));

  // ── 6. Failed verification → REOPENED ───────────────────────────────────
  console.log("[6] Failed verification path");
  const fd2 = new FormData();
  fd2.set("description", "Overflowing waste bin near the hospital gate, smell is unbearable");
  fd2.set("lat", "16.6876");
  fd2.set("lng", "74.4499");
  fd2.set("demoHint", "Overflowing Waste");
  const created2 = await call("citizen", "/api/complaints", { method: "POST", body: fd2 });
  check("second complaint created", created2.status === 201);
  const c2 = created2.data?.complaint ?? {};
  const workers2 = (await call("official", "/api/official/workers")).data.users;
  const anyWorker = workers2.find((w) => w.name.includes("Roads")) ?? workers2[0];
  await call("official", `/api/complaints/${c2.complaintId}/assign`, { json: { workerId: anyWorker.id } });
  await call("worker", `/api/complaints/${c2.complaintId}/status`, { json: { action: "start" } });
  const vfd2 = new FormData();
  vfd2.set("afterImage", jpegFixture("dark"), "still-dark.jpg");
  const verify2 = await call("worker", `/api/complaints/${c2.complaintId}/verify`, { method: "POST", body: vfd2 });
  check("failed verification → not verified", verify2.data?.verdict?.verified === false, JSON.stringify(verify2.data?.verdict));
  check("status REOPENED or ESCALATED (high severity)", ["REOPENED", "ESCALATED"].includes(verify2.data?.status), `got ${verify2.data?.status}`);

  // ── 7. Validation & authz negative tests ────────────────────────────────
  console.log("[7] Validation & authorization");
  const anon = await call("anon", "/api/complaints?scope=all");
  check("unauthenticated list blocked (401)", anon.status === 401);
  const citizenAll = await call("citizen", "/api/complaints?scope=all");
  check("citizen cannot list all (403)", citizenAll.status === 403);
  const badInput = await call("citizen", "/api/complaints", {
    method: "POST",
    body: (() => { const f = new FormData(); f.set("description", "short"); f.set("lat", "200"); f.set("lng", "999"); return f; })(),
  });
  check("invalid input rejected (400)", badInput.status === 400);
  const badFile = await call("citizen", "/api/complaints", {
    method: "POST",
    body: (() => {
      const f = new FormData();
      f.set("description", "Testing file type validation for the smoke test");
      f.set("lat", "16.7"); f.set("lng", "74.45");
      f.set("photo", new Blob([Buffer.alloc(1000, 1)], { type: "application/zip" }), "evil.zip");
      return f;
    })(),
  });
  check("non-image upload rejected (400)", badFile.status === 400);
  const noSecret = await call("anon", "/api/cron/sla");
  check("SLA cron without secret blocked (401)", noSecret.status === 401);

  // Extended negatives (audit phase 3)
  console.log("[8] Extended negative tests");
  const noGps = await call("citizen", "/api/complaints", {
    method: "POST",
    body: (() => { const f = new FormData(); f.set("description", "Testing missing GPS coordinates validation"); return f; })(),
  });
  check("missing GPS rejected (400)", noGps.status === 400, JSON.stringify(noGps.data));

  const nanGps = await call("citizen", "/api/complaints", {
    method: "POST",
    body: (() => { const f = new FormData(); f.set("description", "Testing non-numeric GPS validation behavior"); f.set("lat", "not-a-number"); f.set("lng", "74.45"); return f; })(),
  });
  check("non-numeric GPS rejected (400)", nanGps.status === 400, JSON.stringify(nanGps.data));

  const missing = await call("citizen", "/api/complaints/cs_nonexistent_123");
  check("nonexistent complaint (404)", missing.status === 404);

  const fd3 = new FormData();
  fd3.set("description", "Received-status complaint for transition validation testing");
  fd3.set("lat", "16.7051"); fd3.set("lng", "74.4602");
  const created3 = await call("citizen", "/api/complaints", { method: "POST", body: fd3 });
  const c3 = created3.data?.complaint ?? {};
  check("third complaint created for transition tests", created3.status === 201, JSON.stringify(created3.data));

  // Nonexistent worker on a fresh (non-terminal) complaint → 404, not 500.
  const badWorker = await call("official", `/api/complaints/${c3.complaintId}/assign`, { json: { workerId: "cs_nonexistent_worker" } });
  check("nonexistent worker assignment (404, not 500)", badWorker.status === 404, `got ${badWorker.status}`);
  // Unassigned worker → authorization first (403). Official bypasses the
  // assignee check, so the STATUS guard itself returns 409 for RECEIVED.
  const startReceived = await call("worker", `/api/complaints/${c3.complaintId}/status`, { json: { action: "start" } });
  check("unassigned worker cannot start (403, authz before state)", startReceived.status === 403, `got ${startReceived.status}`);
  const startReceivedOfficial = await call("official", `/api/complaints/${c3.complaintId}/status`, { json: { action: "start" } });
  check("start work on RECEIVED complaint blocked (409)", startReceivedOfficial.status === 409, `got ${startReceivedOfficial.status}`);
  const verifyReceived = await call("official", `/api/complaints/${c3.complaintId}/verify`, {
    method: "POST",
    body: (() => { const f = new FormData(); f.set("afterImage", jpegFixture("bright"), "x.jpg"); return f; })(),
  });
  check("evidence on RECEIVED complaint blocked (409)", verifyReceived.status === 409, `got ${verifyReceived.status}`);

  const unassignedVerify = await call("worker", `/api/complaints/${c3.complaintId}/assign`, { json: { workerId: "x" } });
  check("worker cannot assign (403)", unassignedVerify.status === 403, `got ${unassignedVerify.status}`);

  const bigImage = await call("citizen", "/api/complaints", {
    method: "POST",
    body: (() => {
      const f = new FormData();
      f.set("description", "Testing oversized image upload rejection behavior");
      f.set("lat", "16.706"); f.set("lng", "74.461");
      f.set("photo", new Blob([Buffer.alloc(9 * 1024 * 1024, 7)], { type: "image/jpeg" }), "big.jpg");
      return f;
    })(),
  });
  check("oversized image rejected (400)", bigImage.status === 400, `got ${bigImage.status}`);

  const workerStats = await call("worker", "/api/stats");
  check("worker cannot read official stats (403)", workerStats.status === 403);
  const citizenWorkers = await call("citizen", "/api/official/workers");
  check("citizen cannot list workers (403)", citizenWorkers.status === 403);

  const malformed = await fetch(`${BASE}/api/auth/google`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
  });
  check("malformed JSON handled safely (400)", malformed.status === 400, `got ${malformed.status}`);

  // SLA demo controls (audit phase 8)
  console.log("[9] DEMO SLA simulation (labeled dev control)");
  const anonDemo = await call("anon", "/api/demo/sla", { json: { complaintId: c3.complaintId, mode: "breach" } });
  check("demo SLA requires auth (401/403)", [401, 403].includes(anonDemo.status), `got ${anonDemo.status}`);
  const demoBreach = await call("official", "/api/demo/sla", { json: { complaintId: c3.complaintId, mode: "breach" } });
  check("official triggers demo breach", demoBreach.status === 200 && demoBreach.data?.ok === true, JSON.stringify(demoBreach.data));
  const overdueCheck = await call("official", "/api/stats");
  check("overdue counter reflects breach", overdueCheck.data?.totals?.overdue >= 1, JSON.stringify(overdueCheck.data?.totals));
  const c3after = await call("citizen", `/api/complaints/${c3.complaintId}`);
  check("breach labeled in timeline", (c3after.data?.complaint?.events ?? []).some((e) => e.title?.includes("DEMO MODE")));
  const demoWarning = await call("official", "/api/demo/sla", { json: { complaintId: c3.complaintId, mode: "warning" } });
  check("official triggers demo warning", demoWarning.status === 200);

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Smoke test crashed:", e);
  process.exit(1);
});
