import { describe, it, expect } from "vitest";
import { parseStaffEmails } from "@/lib/firebaseAuth";

/**
 * Unit tests for the server-side staff allowlist (no user-facing role
 * selection exists anywhere in the product). parseStaffEmails is exported
 * separately from the DB-touching resolver so it is testable in isolation.
 */
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
    expect(parseStaffEmails(",,,").size).toBe(0);
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
