/**
 * DB diagnostic — prints WHICH database DATABASE_URL points to (host + project
 * ref only, never the password) and a masked summary of User rows + counts.
 *
 * Usage:
 *   node --env-file=.env --env-file=.env.local scripts/dbcheck.mjs
 *   node --env-file=.env scripts/dbcheck.mjs            # simulate what fix-uid.js saw
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const maskUid = (uid) => (uid ? `${uid.slice(0, 6)}…` : "null");

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  const projectRef = (url.username.split(".")[1] ?? url.username) || "?";
  console.log(`DB: host=${url.hostname} port=${url.port} projectRef=${projectRef}`);

  const users = await prisma.user.findMany({
    select: { id: true, email: true, role: true, firebaseUid: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`users (${users.length}):`);
  for (const u of users) {
    console.log(`  ${u.email} | ${u.role} | firebaseUid=${maskUid(u.firebaseUid)} | id=${u.id}`);
  }

  const [complaints, departments, activities] = await Promise.all([
    prisma.complaint.count(),
    prisma.department.count(),
    prisma.agentActivity.count(),
  ]);
  console.log(`counts: complaints=${complaints} departments=${departments} agentActivities=${activities}`);
}

main()
  .catch((e) => {
    console.error("DB CHECK FAILED:", e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
