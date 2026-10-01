import { afterEach, describe, expect, it, vi } from "vitest";
import { makePrismaMock, mockPrismaModule } from "./helpers/prisma-mock";

/**
 * Regression tests for Phase 1 P0-2: AUTH_SECRET fail-closed handling.
 * The real resolveSessionSecret / createSessionToken / readSessionToken run
 * here; only the Prisma boundary is mocked (unused by these paths).
 */

const prisma = makePrismaMock();
mockPrismaModule(prisma);

const auth = await import("@/lib/auth");

const SESSION_USER = {
  id: "u1",
  email: "user@example.com",
  name: "Test User",
  role: "CITIZEN" as const,
  departmentId: null,
};

/**
 * process.env.NODE_ENV is typed read-only; vi.stubEnv is the sanctioned way
 * to control it per-test (restored automatically via vi.unstubAllEnvs).
 */
function withEnv(vars: { NODE_ENV?: string; AUTH_SECRET?: string }) {
  if (vars.NODE_ENV !== undefined) vi.stubEnv("NODE_ENV", vars.NODE_ENV);
  if (vars.AUTH_SECRET !== undefined) vi.stubEnv("AUTH_SECRET", vars.AUTH_SECRET);
  else vi.stubEnv("AUTH_SECRET", "");
}

describe("AUTH_SECRET hardening (P0-2)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("production + valid AUTH_SECRET → signing and verification work", async () => {
    withEnv({ NODE_ENV: "production", AUTH_SECRET: "x".repeat(64) });
    const token = await auth.createSessionToken(SESSION_USER);
    const parsed = await auth.readSessionToken(token);
    expect(parsed?.id).toBe("u1");
    expect(parsed?.role).toBe("CITIZEN");
  });

  it("production + missing AUTH_SECRET → fails safely (no token can be signed)", async () => {
    withEnv({ NODE_ENV: "production" });
    await expect(auth.createSessionToken(SESSION_USER)).rejects.toThrow(/AUTH_SECRET is not configured/);
  });

  it("production + empty/whitespace AUTH_SECRET → fails safely", async () => {
    withEnv({ NODE_ENV: "production", AUTH_SECRET: "   " });
    await expect(auth.createSessionToken(SESSION_USER)).rejects.toThrow(/AUTH_SECRET is not configured/);
  });

  it("production + weak (<32 chars) AUTH_SECRET → fails safely", async () => {
    withEnv({ NODE_ENV: "production", AUTH_SECRET: "short-secret" });
    await expect(auth.createSessionToken(SESSION_USER)).rejects.toThrow(/too weak for production/);
  });

  it("error messages never contain the secret value (weak-secret path)", async () => {
    // "weak" (<32 chars) triggers the minimum-length error, exercising the
    // throw path while keeping the secret value out of the message.
    withEnv({ NODE_ENV: "production", AUTH_SECRET: "super-secret-value" });
    let message = "";
    try {
      await auth.createSessionToken(SESSION_USER);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/too weak for production/);
    expect(message).not.toContain("super-secret-value");
  });

  it("development + unset AUTH_SECRET → documented dev placeholder keeps local/test flows working", async () => {
    withEnv({ NODE_ENV: "development" });
    const token = await auth.createSessionToken(SESSION_USER);
    const parsed = await auth.readSessionToken(token);
    expect(parsed?.id).toBe("u1");
  });

  it("development + weak AUTH_SECRET is still accepted (dev convenience only)", async () => {
    withEnv({ NODE_ENV: "development", AUTH_SECRET: "dev-secret" });
    const token = await auth.createSessionToken(SESSION_USER);
    await expect(auth.readSessionToken(token)).resolves.toBeTruthy();
  });

  it("tokens signed in production are verified with the same configured secret", async () => {
    withEnv({ NODE_ENV: "production", AUTH_SECRET: "y".repeat(40) });
    const token = await auth.createSessionToken(SESSION_USER);
    expect(await auth.readSessionToken(token)).toBeTruthy();
    // A token from a different secret must fail verification (returns null).
    withEnv({ NODE_ENV: "production", AUTH_SECRET: "z".repeat(40) });
    expect(await auth.readSessionToken(token)).toBeNull();
  });
});
