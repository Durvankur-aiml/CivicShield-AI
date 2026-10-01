import { SignJWT, jwtVerify } from "jose";
import { prisma } from "./db";
import { ROLES } from "./constants";

/**
 * Application session layer.
 *
 * Identity flow: Google sign-in happens in the browser via Firebase; the
 * verified Firebase ID token is exchanged (POST /api/auth/google) for a
 * short-lived CivicShield session JWT stored in an httpOnly cookie. API
 * routes call requireUser()/requireRole() exactly as before — they never see
 * Google specifics, and no client-supplied user id is ever trusted.
 */
/**
 * Session-signing secret resolution — FAILS CLOSED.
 *
 * Production requires an explicitly configured AUTH_SECRET: there is no
 * default and no fallback, so a misconfigured deployment can never sign
 * sessions with a publicly known key. The secret value itself is never
 * included in any error message or log.
 *
 * Outside production (development/test), an explicit, documented placeholder
 * keeps local setup and the test suites runnable without weakening the
 * production path in any way.
 */
export function resolveSessionSecret(): Uint8Array {
  const value = process.env.AUTH_SECRET?.trim() ?? "";
  if (!value) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "AUTH_SECRET is not configured. Set a strong random value (e.g. `openssl rand -hex 32`) in the production environment."
      );
    }
    // Documented development-only placeholder. Never active in production.
    return new TextEncoder().encode("civicshield-dev-secret-change-me");
  }
  if (process.env.NODE_ENV === "production" && value.length < 32) {
    throw new Error("AUTH_SECRET is too weak for production (minimum 32 characters).");
  }
  return new TextEncoder().encode(value);
}

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: (typeof ROLES)[number];
  departmentId?: string | null;
};

export async function createSessionToken(user: SessionUser) {
  return new SignJWT({ ...user })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(resolveSessionSecret());
}

export async function readSessionToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, resolveSessionSecret());
    if (!payload.id || !payload.role) return null;
    return {
      id: payload.id as string,
      email: payload.email as string,
      name: payload.name as string,
      role: payload.role as SessionUser["role"],
      departmentId: (payload.departmentId as string) ?? null,
    };
  } catch {
    return null;
  }
}

export function sessionCookieName() {
  return process.env.NODE_ENV === "production" ? "__Host-cs_session" : "cs_session";
}

export function sessionCookieOpts(maxAgeSeconds = 7 * 24 * 3600) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export async function getSessionUser(req: Request): Promise<SessionUser | null> {
  // Authorization: Bearer header first (session JWT), then cookie.
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const user = await readSessionToken(auth.slice(7));
    if (user) return user;
  }
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(new RegExp(`${sessionCookieName()}=([^;]+)`));
  if (!m) return null;
  return readSessionToken(decodeURIComponent(m[1]));
}

/** Throws a typed error usable by route handlers. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function requireUser(req: Request): Promise<SessionUser> {
  const user = await getSessionUser(req);
  if (!user) throw new ApiError(401, "Authentication required");
  return user;
}

export async function requireRole(req: Request, ...roles: SessionUser["role"][]) {
  const user = await requireUser(req);
  if (!roles.includes(user.role)) throw new ApiError(403, "Insufficient permissions");
  return user;
}

/** Ensure the session user still exists in the database (session revocation). */
export async function requireLiveUser(req: Request): Promise<SessionUser> {
  const session = await requireUser(req);
  const exists = await prisma.user.findUnique({ where: { id: session.id }, select: { id: true } });
  if (!exists) throw new ApiError(401, "Session no longer valid");
  return session;
}
