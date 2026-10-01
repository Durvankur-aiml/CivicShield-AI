/**
 * TEST-ONLY session signer for the smoke suite (scripts/smoke.mjs).
 *
 * Production has NO demo login and NO auth bypass: identity always comes from
 * a server-verified Firebase ID token. This helper exists so the automated
 * E2E suite can still exercise protected endpoints: it signs session JWTs
 * locally with the server's own AUTH_SECRET for real seeded DB rows.
 *
 * It is isolated by design:
 *  - lives in tests/helpers, imported only by scripts/smoke.mjs
 *  - requires local file + env access (impossible for an external attacker)
 *  - is never imported by any application code path
 */
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

let cachedKey = null;

async function loadAuthSecret() {
  if (cachedKey) return cachedKey;
  // Read AUTH_SECRET from the project .env (same value the server uses).
  const envPath = path.join(process.cwd(), ".env");
  const env = readFileSync(envPath, "utf8");
  const m = env.match(/^AUTH_SECRET\s*=\s*"?([^"\r\n]+)"?/m);
  if (!m) throw new Error("AUTH_SECRET not found in civicshield/.env — cannot mint test sessions.");
  cachedKey = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(m[1].trim()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return cachedKey;
}

const enc = new TextEncoder();

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

async function signJwt(payload) {
  const key = await loadAuthSecret();
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, exp: now + 3600, ...payload };
  const data = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(body)))}`;
  const sig = await webcrypto.subtle.sign("HMAC", key, enc.encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

/**
 * Create a signer bound to a base URL: signSession(email, role) → session JWT.
 */
export function createSigner() {
  return async function signSession(email, role) {
    // Look up the real seeded user row (keeps FKs valid for created complaints).
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    try {
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) throw new Error(`No seeded user ${email} — run npm run demo:reset first.`);
      return await signJwt({
        id: user.id,
        email: user.email,
        name: user.name,
        role,
        departmentId: user.departmentId ?? null,
      });
    } finally {
      await prisma.$disconnect();
    }
  };
}
