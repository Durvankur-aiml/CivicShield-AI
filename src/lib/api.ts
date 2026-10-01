import { NextResponse } from "next/server";
import { ApiError } from "./auth";
import { ZodError } from "zod";
/** Uniform JSON error handling for all route handlers. */
export function jsonError(status: number, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export function handleRouteError(err: unknown) {
  if (err instanceof ApiError) return jsonError(err.status, err.message);
  if (err instanceof ZodError) {
    return jsonError(400, "Validation failed", {
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  console.error("[api] unexpected error:", err);
  return jsonError(500, "Internal server error");
}

/** Safely parse a JSON body — malformed bodies are a client error (400), not a 500. */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ApiError(400, "Malformed JSON body");
  }
}

/**
 * Simple in-memory sliding-window rate limiter.
 * Good enough for a single-node demo; a production deployment would use
 * a shared store (e.g. Redis). Documented in docs/ARCHITECTURE.md.
 *
 * RATE_LIMIT_MULTIPLIER scales all limits for local test/demo runs
 * (default 1). It is a dev convenience only and is not set in production.
 */
const LIMIT_MULTIPLIER = Math.max(1, Number(process.env.RATE_LIMIT_MULTIPLIER ?? 1));
const buckets = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const effectiveLimit = Math.max(1, Math.round(limit * LIMIT_MULTIPLIER));
  const now = Date.now();
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= effectiveLimit) return false;
  arr.push(now);
  buckets.set(key, arr);
  return true;
}

export function clientKey(req: Request, scope: string) {
  const fwd = req.headers.get("x-forwarded-for") ?? "local";
  return `${scope}:${fwd.split(",")[0].trim()}`;
}
