import { NextResponse } from "next/server";
import { z } from "zod";
import { createSessionToken, sessionCookieName, sessionCookieOpts } from "@/lib/auth";
import { resolveFirebaseUser } from "@/lib/firebaseAuth";
import { verifyFirebaseIdToken, adminConfigured } from "@/lib/firebaseAdmin";
import { handleRouteError, jsonError, rateLimit, clientKey, readJson } from "@/lib/api";

/**
 * Exchanges a verified Firebase ID token for a CivicShield session.
 *
 * Security properties:
 *  - The ID token is verified server-side with Firebase Admin (revocation checked).
 *  - Identity comes ONLY from the verified token claims; the client cannot
 *    pass a user id, email or role that is trusted.
 *  - The returned session is our own httpOnly JWT cookie (not the Google token;
 *    the Firebase ID token is never stored client-side by this app).
 */
const bodySchema = z.object({ idToken: z.string().min(20).max(4096) });

export async function POST(req: Request) {
  try {
    if (!rateLimit(clientKey(req, "google-session"), 20, 60_000)) {
      return jsonError(429, "Too many sign-in attempts. Wait a minute and retry.");
    }
    // Validate the request shape first (client error), then fail closed if the
    // server has no Firebase Admin credential configured.
    const { idToken } = bodySchema.parse(await readJson(req));
    if (!adminConfigured()) {
      return jsonError(503, "Authentication is not configured on the server. Contact the operator.");
    }

    let verified;
    try {
      verified = await verifyFirebaseIdToken(idToken);
    } catch (err) {
      // Log the technical reason server-side (no secrets in tokens by design),
      // return a generic message to the client.
      console.error("[auth/google] token verification failed:", (err as Error).message);
      return jsonError(401, "Your session could not be verified. Please sign in again.");
    }

    const user = await resolveFirebaseUser(verified);
    const token = await createSessionToken(user);
    const res = NextResponse.json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
    res.cookies.set(sessionCookieName(), token, sessionCookieOpts());
    return res;
  } catch (err) {
    return handleRouteError(err);
  }
}
