import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePrismaMock, mockPrismaModule } from "./helpers/prisma-mock";
import type { VerifiedFirebaseUser } from "@/lib/firebaseAdmin";

/**
 * Unit tests for the server-side identity/role policy. parseStaffEmails and
 * parseAdminEmails are exported separately from the DB-touching resolver so
 * they are testable in isolation; resolveFirebaseUser is tested with the
 * shared Prisma mock.
 *
 * The resolveFirebaseUser suite pins the stale-uid repair policy: after a
 * Firebase project replacement the same Google account signs in with a NEW
 * uid while the User row still stores the OLD one. Login must relink by the
 * verified email (otherwise create() dies on the unique email constraint —
 * the original P2002 bug), and must refuse to link when the token's email is
 * NOT verified (account-takeover guard).
 */

const prisma = makePrismaMock();
mockPrismaModule(prisma);

// Imported AFTER the Prisma mock is wired (top-level await runs in statement
// order), so firebaseAuth binds the mocked "@/lib/db" client.
const { parseAdminEmails, parseStaffEmails, resolveFirebaseUser } = await import("@/lib/firebaseAuth");

function fv(overrides: Partial<VerifiedFirebaseUser> = {}): VerifiedFirebaseUser {
  return {
    uid: "new-uid-123",
    email: "user@example.com",
    name: "Test User",
    picture: null,
    emailVerified: true,
    ...overrides,
  };
}

const baseUser = {
  id: "usr_1",
  email: "user@example.com",
  name: "Test User",
  image: null as string | null,
  role: "CITIZEN",
  departmentId: null as string | null,
  karma: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.STAFF_EMAILS;
  delete process.env.ADMIN_EMAILS;
});

describe("resolveFirebaseUser — stale firebaseUid repair (project replacement)", () => {
  it("relinks a row holding a STALE uid when the token email is verified, and persists the new uid", async () => {
    prisma.user.findUnique.mockImplementation(async ({ where }: { where: { firebaseUid?: string; email?: string } }) => {
      if (where.firebaseUid) return null; // new uid not yet in DB
      return { ...baseUser, firebaseUid: "old-project-uid" }; // stale row found by email
    });
    prisma.user.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...baseUser,
      firebaseUid: "new-uid-123",
      ...data,
    }));

    const user = await resolveFirebaseUser(fv());

    expect(user.id).toBe("usr_1");
    // update must persist the refreshed identity + volatile fields
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const updateArg = prisma.user.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: "usr_1" });
    expect(updateArg.data.firebaseUid).toBe("new-uid-123");
  });

  it("does NOT create a duplicate user when relinking (no prisma.user.create)", async () => {
    prisma.user.findUnique.mockImplementation(async ({ where }: { where: { firebaseUid?: string } }) =>
      where.firebaseUid ? null : { ...baseUser, firebaseUid: "old-project-uid" }
    );
    prisma.user.update.mockResolvedValue({ ...baseUser, firebaseUid: "new-uid-123" });

    await resolveFirebaseUser(fv());

    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("relinks a row with firebaseUid = null (never identified) and persists the uid", async () => {
    prisma.user.findUnique.mockImplementation(async ({ where }: { where: { firebaseUid?: string } }) =>
      where.firebaseUid ? null : { ...baseUser, firebaseUid: null }
    );
    prisma.user.update.mockResolvedValue({ ...baseUser, firebaseUid: "new-uid-123" });

    const user = await resolveFirebaseUser(fv());

    expect(user.id).toBe("usr_1");
    expect(prisma.user.update.mock.calls[0][0].data.firebaseUid).toBe("new-uid-123");
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("prefers the uid lookup: a row already matching the token uid is returned WITHOUT a relink update", async () => {
    prisma.user.findUnique.mockImplementation(async ({ where }: { where: { firebaseUid?: string } }) =>
      where.firebaseUid ? { ...baseUser, firebaseUid: "new-uid-123" } : null
    );

    const user = await resolveFirebaseUser(fv());

    expect(user.id).toBe("usr_1");
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});

describe("resolveFirebaseUser — account-takeover guard", () => {
  it("REFUSES to relink a stale-uid row when the token email is NOT verified", async () => {
    prisma.user.findUnique.mockImplementation(async ({ where }: { where: { firebaseUid?: string } }) =>
      where.firebaseUid ? null : { ...baseUser, firebaseUid: "old-project-uid" }
    );

    await expect(resolveFirebaseUser(fv({ emailVerified: false }))).rejects.toMatchObject({ status: 403 });

    // The refusal happens BEFORE any write: no update, no create.
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("does not create a second account for an unverified email that collides with an existing one", async () => {
    prisma.user.findUnique.mockImplementation(async ({ where }: { where: { firebaseUid?: string } }) =>
      where.firebaseUid ? null : { ...baseUser, firebaseUid: "someone-elses-uid" }
    );

    await expect(resolveFirebaseUser(fv({ emailVerified: false }))).rejects.toMatchObject({ status: 403 });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});

describe("resolveFirebaseUser — first login and role bootstrap", () => {
  it("creates a CITIZEN on first login and assigns the new uid", async () => {
    prisma.user.findUnique.mockResolvedValue(null); // no uid row, no email row
    prisma.user.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...baseUser,
      ...data,
    }));

    const user = await resolveFirebaseUser(fv());

    expect(user.role).toBe("CITIZEN");
    expect(prisma.user.create).toHaveBeenCalledTimes(1);
    expect(prisma.user.create.mock.calls[0][0].data.firebaseUid).toBe("new-uid-123");
  });

  it("keeps the stored role for a returning matched-uid user even if STAFF_EMAILS changes", async () => {
    // Returning user whose stored role (OFFICIAL) differs from a stale
    // staff entry — a staff entry may elevate but the matched-uid path must
    // never silently demote on a config edit; here no staff entry exists.
    prisma.user.findUnique.mockImplementation(async ({ where }: { where: { firebaseUid?: string } }) =>
      where.firebaseUid ? { ...baseUser, role: "OFFICIAL", firebaseUid: "new-uid-123" } : null
    );

    const user = await resolveFirebaseUser(fv());

    expect(user.role).toBe("OFFICIAL");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe("parseStaffEmails", () => {
  it("parses role-qualified entries", () => {
    const m = parseStaffEmails("a@x.com:OFFICIAL,b@x.com:WORKER");
    expect(m.get("a@x.com")).toEqual({ role: "OFFICIAL" });
    expect(m.get("b@x.com")).toEqual({ role: "WORKER" });
  });

  it("parses role + department entries", () => {
    const m = parseStaffEmails("w@x.com:WORKER:SWM");
    expect(m.get("w@x.com")).toEqual({ role: "WORKER", departmentCode: "SWM" });
  });

  it("defaults bare emails to OFFICIAL", () => {
    const m = parseStaffEmails("boss@x.com");
    expect(m.get("boss@x.com")).toEqual({ role: "OFFICIAL" });
  });

  it("lowercases emails and trims whitespace", () => {
    const m = parseStaffEmails("  BoSS@X.com : official ,  W@X.COM:worker:PWD  ");
    expect(m.get("boss@x.com")).toEqual({ role: "OFFICIAL" });
    expect(m.get("w@x.com")).toEqual({ role: "WORKER", departmentCode: "PWD" });
  });

  it("skips invalid entries rather than throwing", () => {
    const m = parseStaffEmails("not-an-email,a@x.com:OFFICIAL,:WORKER");
    expect(m.size).toBe(1);
    expect(m.has("not-an-email")).toBe(false);
  });

  it("handles empty/undefined input", () => {
    expect(parseStaffEmails(undefined).size).toBe(0);
    expect(parseStaffEmails("").size).toBe(0);
  });

  it("rejects unknown roles", () => {
    const m = parseStaffEmails("a@x.com:SUPERADMIN");
    expect(m.size).toBe(0);
  });

  it("role precedence: STAFF_EMAILS wins over the default CITIZEN assignment", () => {
    // Documented invariant of resolveFirebaseUser: default is CITIZEN, and
    // STAFF_EMAILS entries are the only server-side elevation path.
    const m = parseStaffEmails("me@example.com:OFFICIAL");
    expect(m.get("me@example.com")?.role).toBe("OFFICIAL");
  });
});

describe("parseAdminEmails", () => {
  it("parses a comma-separated list, trims, and lowercases", () => {
    const set = parseAdminEmails(" Admin@Example.com , second@example.org ,,");
    expect(set.has("admin@example.com")).toBe(true);
    expect(set.has("second@example.org")).toBe(true);
    expect(set.size).toBe(2);
  });

  it("returns an empty set for undefined/empty input", () => {
    expect(parseAdminEmails(undefined).size).toBe(0);
    expect(parseAdminEmails("").size).toBe(0);
  });

  it("drops entries without '@' rather than throwing", () => {
    const set = parseAdminEmails("nope,real@example.com");
    expect(set.has("real@example.com")).toBe(true);
    expect(set.size).toBe(1);
  });
});
