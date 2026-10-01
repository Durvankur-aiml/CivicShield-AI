/**
 * Server-side identity resolution for Firebase-authenticated users.
 *
 * The ONLY way a request becomes authenticated is:
 *   Firebase ID token → verifyFirebaseIdToken() → trusted firebaseUid
 *   → find-or-create CivicShield User → SessionUser
 *
 * Role policy (no signup role selection anywhere in the UI):
 *   - Every Google account is a normal CITIZEN by default.
 *   - Emails listed in STAFF_EMAILS ("a@x.com:OFFICIAL,b@x.com:WORKER"
 *     or bare emails meaning OFFICIAL) are server-assigned that role at
 *     login time. The allowlist lives only on the server.
 */
import { prisma } from "./db";
import type { SessionUser } from "./auth";
import type { VerifiedFirebaseUser } from "./firebaseAdmin";
import { ROLES } from "./constants";

export type StaffAssignment = { role: "CITIZEN" | "WORKER" | "OFFICIAL"; departmentCode?: string };

/**
 * Parse STAFF_EMAILS: "official@x.com:OFFICIAL,worker@x.com:WORKER:PWD".
 * Bare entries map to OFFICIAL. Invalid entries are skipped (logged once).
 */
export function parseStaffEmails(raw: string | undefined): Map<string, StaffAssignment> {
  const map = new Map<string, StaffAssignment>();
  for (const part of (raw ?? "").split(",")) {
    const entry = part.trim().toLowerCase();
    if (!entry) continue;
    const [emailRaw, roleRaw, deptRaw] = entry.split(":").map((s) => s.trim());
    if (!emailRaw || !emailRaw.includes("@")) continue;
    const role = (roleRaw ?? "OFFICIAL").toUpperCase();
    if (!ROLES.includes(role as (typeof ROLES)[number])) continue;
    // Department codes are stored uppercase (PWD/SWM/…); keep them intact.
    const departmentCode = deptRaw ? deptRaw.toUpperCase() : undefined;
    map.set(emailRaw, { role: role as StaffAssignment["role"], departmentCode });
  }
  return map;
}

/** Resolve (or create) the CivicShield user for a verified Firebase identity. */
export async function resolveFirebaseUser(fv: VerifiedFirebaseUser): Promise<SessionUser> {
  const email = fv.email?.toLowerCase() ?? null;

  // 1. Primary lookup: verified firebaseUid (stable across email changes).
  let user = await prisma.user.findUnique({ where: { firebaseUid: fv.uid } });

  // 2. Account linking: an existing account with the same verified email that
  //    has never had a Firebase identity claims this login (preserves the
  //    seeded staff rows and their complaint/assignment history).
  if (!user && email) {
    const byEmail = await prisma.user.findUnique({ where: { email } });
    if (byEmail && !byEmail.firebaseUid) user = byEmail;
  }

  // 3. First login: create a new user. Default role CITIZEN; staff emails are
  //    mapped server-side (no user-chosen roles anywhere in the product).
  if (!user) {
    const staff = email ? parseStaffEmails(process.env.STAFF_EMAILS).get(email) : undefined;
    const department = staff?.departmentCode
      ? await prisma.department.findUnique({ where: { code: staff.departmentCode } })
      : null;
    user = await prisma.user.create({
      data: {
        email: email ?? `${fv.uid}@users.noreply.civicshield.local`,
        name: fv.name ?? email?.split("@")[0] ?? "CivicShield User",
        image: fv.picture,
        firebaseUid: fv.uid,
        role: staff?.role ?? "CITIZEN",
        departmentId: department?.id ?? null,
      },
    });
    return toSessionUser(user);
  }

  // Returning user: keep data stable; refresh only volatile identity fields.
  const staff = email ? parseStaffEmails(process.env.STAFF_EMAILS).get(email) : undefined;
  let departmentId = user.departmentId;
  if (staff?.departmentCode && staff.role !== "CITIZEN") {
    const department = await prisma.department.findUnique({ where: { code: staff.departmentCode } });
    if (department && departmentId !== department.id) departmentId = department.id;
  }
  const data: { name?: string; image?: string | null; role?: string; departmentId?: string | null } = {};
  if (staff && staff.role !== user.role) data.role = staff.role;
  if (departmentId !== user.departmentId) data.departmentId = departmentId;
  if (fv.name && fv.name !== user.name) data.name = fv.name;
  if ((fv.picture ?? null) !== user.image) data.image = fv.picture ?? null;
  if (Object.keys(data).length > 0) {
    user = await prisma.user.update({ where: { id: user.id }, data });
  }
  return toSessionUser(user);
}

function toSessionUser(u: {
  id: string;
  email: string;
  name: string;
  role: string;
  departmentId: string | null;
}): SessionUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role as SessionUser["role"],
    departmentId: u.departmentId,
  };
}
