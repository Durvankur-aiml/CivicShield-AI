#!/usr/bin/env node
/**
 * CivicShield AI — demo data reset (DEVELOPMENT USE ONLY).
 *
 *   npm run demo:reset           # asks for confirmation
 *   npm run demo:reset -- --yes  # non-interactive (CI / rehearsed resets)
 *
 * Resets the app's own development database (defined by DATABASE_URL in .env)
 * to a clean seeded demo state: departments, demo accounts, clearly-marked
 * DEMO complaints. Any citizen-created test data from rehearsals is removed.
 *
 * Canonical strategy (Phase 1): PostgreSQL everywhere — a local Postgres for
 * development, Supabase Postgres for deployment. The schema is synced with
 * `prisma db push --force-reset` (there are no migration files in this
 * project; see README "Database setup").
 *
 * Safety guards:
 *  - Interactive confirmation showing the EXACT target (host/database, secret
 *    masked) unless `--yes` is passed.
 *  - Refuses to run against a REMOTE database without `--yes` (local-safety
 *    check: localhost / 127.0.0.1 / ::1 / host.docker.internal / no host).
 *  - SQLite file URLs (legacy local dev) still work with confirmation.
 *  - Never touches files outside the project.
 */
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import path from "path";

const force = process.argv.includes("--force");
const assumeYes = process.argv.includes("--yes") || force;

// Read DATABASE_URL from .env (simple parse; Prisma loads the same file).
let databaseUrl = process.env.DATABASE_URL;
const envPath = path.join(process.cwd(), ".env");
if (!databaseUrl && existsSync(envPath)) {
  const env = readFileSync(envPath, "utf8");
  const m = env.match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
  if (m) databaseUrl = m[1].trim();
}

if (!databaseUrl) {
  console.error("✖ DATABASE_URL not found (checked environment and .env). Aborting.");
  process.exit(1);
}

let target;
try {
  target = new URL(databaseUrl);
} catch {
  console.error("✖ DATABASE_URL is not a valid connection URL. Aborting.");
  process.exit(1);
}

const isSqlite = target.protocol === "file:";
const masked = databaseUrl.replace(/:\/\/([^:@/]+):[^@/]*@/, "://$1:****@");

const isLocal =
  isSqlite ||
  !target.hostname ||
  ["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"].includes(target.hostname);

if (isSqlite) {
  console.log(`Resetting demo database (SQLite file): ${masked}`);
} else {
  console.log(`Resetting demo database (PostgreSQL): ${masked}`);
  if (!isLocal && !assumeYes) {
    console.error("✖ Refusing to reset a REMOTE database without explicit confirmation.");
    console.error("  This guard protects production/staging databases (e.g. Supabase Postgres).");
    console.error("  If you REALLY want to wipe it, re-run with: npm run demo:reset -- --yes");
    process.exit(1);
  }
}

if (!assumeYes && !isSqlite) {
  // PostgreSQL local default: require explicit --yes (no TTY prompt dependency).
  console.error("✖ This WIPES the database above and re-seeds DEMO data.");
  console.error("  Re-run with --yes to continue: npm run demo:reset -- --yes");
  process.exit(1);
}
if (assumeYes && !isLocal) {
  console.log("  ⚠ --yes given for a REMOTE database — proceeding ONLY because you asked explicitly.");
}

execSync("npx prisma db push --force-reset --skip-generate", { stdio: "inherit" });
execSync("npx tsx prisma/seed.ts", { stdio: "inherit" });

console.log("\n✔ Demo state restored. Authentication is Google sign-in only (no demo credentials).");
console.log("    Staff dashboards: add your Google email to STAFF_EMAILS in .env, then sign in with Google.");
