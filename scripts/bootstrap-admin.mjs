#!/usr/bin/env node
/**
 * CivicShield AI — ADMIN bootstrap (ENV-CONTROLLED, SERVER-SIDE ONLY).
 *
 * Creates/promotes the FIRST admin(s) configured in ADMIN_EMAILS. There is no
 * "become admin" anywhere in the product; this script is the only provisioning
 * path besides the ADMIN_EMAILS sign-in hook in src/lib/firebaseAuth.ts.
 *
 * Usage:
 *   ADMIN_EMAILS="admin@example.com" node --env-file=.env scripts/bootstrap-admin.mjs
 *
 * Behavior:
 *  - Requires explicit ADMIN_EMAILS configuration (never accepts arbitrary
 *    emails from argv/browser — an operator edits the env, not a prompt).
 *  - Promotes ONLY the configured accounts, only if the User already exists
 *    (the operator must have signed in with Google once — we never fabricate
 *    accounts and never touch Firebase).
 *  - Idempotent: already-ADMIN accounts are skipped; re-running is safe.
 *  - Refuses to run in production against a remote DB without --yes
 *    (same local-safety guard as demo-reset.mjs). Never exposes secrets —
 *    connection strings are masked in output.
 */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const assumeYes = process.argv.includes("--yes");

// Load DATABASE_URL from .env if not already in the environment (Prisma does
// the same; this only drives the local-safety check and the client itself).
if (!process.env.DATABASE_URL && existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*)$/);
    if (m && m[1] === "DATABASE_URL") {
      process.env.DATABASE_URL = m[2].trim().replace(/^["']|["']$/g, "");
      break;
    }
  }
}
if (!process.env.DATABASE_URL) {
  console.error("✖ DATABASE_URL not found (checked environment and .env). Aborting.");
  process.exit(1);
}

const target = (() => {
  try {
    return new URL(process.env.DATABASE_URL);
  } catch {
    console.error("✖ DATABASE_URL is not a valid connection URL. Aborting.");
    process.exit(1);
  }
})();
const isLocal =
  !target.hostname ||
  ["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"].includes(target.hostname);
if (!isLocal && !assumeYes) {
  console.error("✖ Refusing to run against a REMOTE database without --yes.");
  console.error("  Re-run with: node scripts/bootstrap-admin.mjs --yes");
  process.exit(1);
}

const adminEmails = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s.includes("@"));
if (adminEmails.length === 0) {
  console.error("✖ No admins configured. Set ADMIN_EMAILS=\"admin@example.com[,second@example.com]\" in .env (never commit real emails to the repo).");
  process.exit(1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const masked = process.env.DATABASE_URL.replace(/:\/\/([^:@/]+):[^@/]*@/, "://$1:****@");
console.log(`Bootstrapping admins on ${masked}`);

try {
  for (const email of adminEmails) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, name: true, role: true } });
    if (!user) {
      console.log(`  – ${email}: account not found. The operator must sign in with Google once (creating the CITIZEN account), then re-run this script.`);
      continue;
    }
    if (user.role === "ADMIN") {
      console.log(`  ✓ ${email}: already ADMIN (idempotent skip).`);
      continue;
    }
    await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
    console.log(`  ✓ ${email}: ${user.role} → ADMIN (${user.name}).`);
  }
  console.log("\nDone. Admins are also re-asserted at sign-in via ADMIN_EMAILS in src/lib/firebaseAuth.ts.");
} finally {
  await prisma.$disconnect();
}
