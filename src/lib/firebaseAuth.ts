/**
 * Server-side identity resolution for Firebase-authenticated users.
 *
 * The ONLY way a request becomes authenticated is:
 *   Firebase ID token → verifyFirebaseIdToken() → trusted firebaseUid
 *   → find-or-create CivicShield User → SessionUser
 *
 * Role policy (no signup role selection anywhere in the UI):
 *   - Every Google account is a normal CITIZEN by default.
 *   - Privileged roles are granted ONLY through two server-side paths:
 *       1. STAFF_EMAILS allowlist ("a@x.com:OFFICIAL,b@x.com:WORKER" —
 *          the legacy/dev bootstrap for staff assignment targets), and
 *       2. the application flows: OFFICIAL via admin approval of an
 *          OfficialApplication, WORKER via official approval.
 *   - ADMIN is NOT assignable through STAFF_EMAILS (an allowlist typo must
 *     never mint an admin). Admins come only from the ADMIN_EMAILS
 *     environment bootstrap (see scripts/bootstrap-admin.mjs). An existing
 *     ADMIN is never demoted by a staff entry.
 *   - All allowlists live only on the server.
 */
import { prisma } from "./db";
import { ApiError, type SessionUser } from "./auth";
import type { VerifiedFirebaseUser } from "./firebaseAdmin";
import { ROLES } from "./constants";

export type StaffAssignment = { role: "CITIZEN" | "WORKER" | "OFFICIAL"; departmentCode?: string };

/**
 * Parse ADMIN_EMAILS (comma-separated emails) — the env-controlled bootstrap
 * list for the first admin(s). Server-only: an email on this list is promoted
 * to ADMIN at sign-in if the account exists. Parsed here so the policy is
 * testable in isolation from the database.
 */
export function parseAdminEmails(raw: string | undefined): Set<string> {
  const set = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const email = part.trim().toLowerCase();
    if (email.includes("@")) set.add(email);
  }
  return set;
}

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
    // ADMIN is deliberately NOT obtainable through STAFF_EMAILS: a typo in a
    // public deploy config must never silently mint an administrator.
    if (role === "ADMIN") continue;
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

  // 2. Account linking by verified email. This also REPAIRS rows whose
  //    firebaseUid went stale — e.g. after the Firebase project itself was
  //    replaced and the same Google account now signs in with a new uid
  //    (fixing only never-identified rows would leave such rows unlinked, and
  //    the subsequent create() would die on the unique email constraint).
  //    The guard is `fv.emailVerified`: a verified email is proof of ownership
  //    of the account, so relinking cannot hand the account to an attacker who
  //    merely controls an unverified address (account-takeover guard).
  let relinked = false;
  let unclaimableByEmail: unknown = null;
  if (!user && email) {
    const byEmail = await prisma.user.findUnique({ where: { email } });
    if (byEmail && fv.emailVerified && byEmail.firebaseUid !== fv.uid) {
      // Stored uid is null (never identified) or stale (old project): claim it.
      user = byEmail;
      relinked = true;
    } else if (byEmail) {
      unclaimableByEmail = byEmail;
    }
  }

  // 3. First login: create a new user. Default role CITIZEN. Privileged
  //    roles arrive only from the server-side paths (see header comment).
  if (!user) {
    if (unclaimableByEmail) {
      // The email is registered but we may not link it (token email not
      // verified): fail with a clear client error instead of letting the
      // create() below surface as a raw P2002 unique-constraint 500.
      throw new ApiError(403, "This email is already registered. Sign in with the account that owns it.");
    }
    const adminEmails = parseAdminEmails(process.env.ADMIN_EMAILS);
    const staff = email ? parseStaffEmails(process.env.STAFF_EMAILS).get(email) : undefined;
    const department = staff?.departmentCode
      ? await prisma.department.findUnique({ where: { code: staff.departmentCode } })
      : null;
    const role = email && adminEmails.has(email) ? "ADMIN" : (staff?.role ?? "CITIZEN");
    user = await prisma.user.create({
      data: {
        email: email ?? `${fv.uid}@users.noreply.civicshield.local`,
        name: fv.name ?? email?.split("@")[0] ?? "CivicShield User",
        image: fv.picture,
        firebaseUid: fv.uid,
        role,
        departmentId: department?.id ?? null,
      },
    });
    return toSessionUser(user);
  }

  // Returning user: keep data stable; refresh only volatile identity fields.
  // firebaseUid is persisted ONLY for the stale-uid repair above (a verified
  // email already proved ownership) so later logins hit the fast uid lookup;
  // it is never overwritten otherwise — that would let a verified-email
  // change hijack another Firebase identity.
  const staff = user.role === "ADMIN" ? undefined : email ? parseStaffEmails(process.env.STAFF_EMAILS).get(email) : undefined;
  let departmentId = user.departmentId;
  if (staff?.departmentCode && staff.role !== "CITIZEN") {
    const department = await prisma.department.findUnique({ where: { code: staff.departmentCode } });
    if (department && departmentId !== department.id) departmentId = department.id;
  }
  const data: { name?: string; image?: string | null; role?: string; departmentId?: string | null; firebaseUid?: string } = {};
  if (staff && staff.role !== user.role) data.role = staff.role;
  if (departmentId !== user.departmentId) data.departmentId = departmentId;
  if (fv.name && fv.name !== user.name) data.name = fv.name;
  if ((fv.picture ?? null) !== user.image) data.image = fv.picture ?? null;
  if (relinked && user.firebaseUid !== fv.uid) data.firebaseUid = fv.uid;
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
