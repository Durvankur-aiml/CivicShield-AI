import { describe, expect, it } from "vitest";
import { parseAdminEmails, parseStaffEmails } from "@/lib/firebaseAuth";

/**
 * Phase 2 — role bootstrap tests: ADMIN_EMAILS parsing and the deliberate
 * ADMIN-skip in STAFF_EMAILS (no user-facing or config-driven path to ADMIN
 * except the dedicated, explicit ADMIN_EMAILS channel).
 */
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
    expect(parseAdminEmails("nope").size).toBe(0);
    expect(parseAdminEmails("not-an-email,real@example.com").has("real@example.com")).toBe(true);
    expect(parseAdminEmails("not-an-email,real@example.com").size).toBe(1);
  });

  it("keeps exact entries without de-duplicating differently-cased twins", () => {
    // parseAdminEmails lowercases before adding, so case twins collapse.
    const set = parseAdminEmails("A@x.com,a@x.com");
    expect(set.size).toBe(1);
  });
});

describe("STAFF_EMAILS must never mint an ADMIN", () => {
  it("skips ADMIN entries in STAFF_EMAILS", () => {
    const m = parseStaffEmails("root@x.com:ADMIN,ok@x.com:OFFICIAL");
    expect(m.has("root@x.com")).toBe(false);
    expect(m.get("ok@x.com")).toEqual({ role: "OFFICIAL" });
  });

  it("skips lowercase admin entries too", () => {
    const m = parseStaffEmails("root@x.com:admin");
    expect(m.size).toBe(0);
  });

  it("does not treat ADMIN as an unknown-role failure for other entries", () => {
    const m = parseStaffEmails("root@x.com:ADMIN,w@x.com:WORKER:PWD");
    expect(m.get("w@x.com")).toEqual({ role: "WORKER", departmentCode: "PWD" });
    expect(m.size).toBe(1);
  });
});
