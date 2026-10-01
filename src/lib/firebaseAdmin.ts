/**
 * Firebase Admin (server-only). Verifies Firebase ID tokens from the browser.
 *
 * Credential strategy (in priority order):
 *  1. FIREBASE_SERVICE_ACCOUNT_B64 — base64 of the full service-account JSON
 *     (deployment-friendly single env var; never committed).
 *  2. FIREBASE_SERVICE_ACCOUNT_PATH — path to the service-account JSON file
 *     (kept outside git; e.g. C:\secrets\firebase-sa.json).
 *  3. GOOGLE_APPLICATION_CREDENTIALS / Application Default Credentials, as
 *     provided by the host environment.
 *
 * If no credential is configured, token verification is UNAVAILABLE and the
 * module exposes `adminConfigured() === false` — endpoints then fail closed
 * (401) instead of silently trusting anything. No fallback auth exists.
 */
import { cert, getApp, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

let cachedApp: App | null = null;
let initError: string | null = null;

function loadCredential() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (b64) {
    try {
      const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
      return cert(json as Parameters<typeof cert>[0]);
    } catch {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_B64 is set but is not valid base64 JSON.");
    }
  }
  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (path) return cert(path);
  // ADC: firebase-admin picks this up automatically when the env var is set.
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return undefined;
  return null; // nothing configured
}

function ensureApp(): App {
  if (cachedApp) return cachedApp;
  if (initError) throw new Error(initError);
  try {
    const credential = loadCredential();
    if (credential === null) {
      initError =
        "No Firebase Admin credential configured (set FIREBASE_SERVICE_ACCOUNT_B64, FIREBASE_SERVICE_ACCOUNT_PATH or GOOGLE_APPLICATION_CREDENTIALS).";
      throw new Error(initError);
    }
    cachedApp = getApps().length
      ? getApp()
      : initializeApp(credential ? { credential } : {});
    return cachedApp;
  } catch (err) {
    initError = (err as Error).message;
    throw err;
  }
}

/** True when a server credential is configured and the app can verify tokens. */
export function adminConfigured(): boolean {
  return (
    Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_B64) ||
    Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_PATH) ||
    Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  );
}

export type VerifiedFirebaseUser = {
  uid: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  emailVerified: boolean;
};

/** Verify a Firebase ID token → trusted identity claims. Throws on any failure. */
export async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedFirebaseUser> {
  const app = ensureApp();
  const decoded = await getAuth(app).verifyIdToken(idToken, true); // checkRevoked
  if (!decoded?.uid) throw new Error("Firebase token has no subject (uid).");
  return {
    uid: decoded.uid,
    email: (decoded.email as string | undefined) ?? null,
    name: (decoded.name as string | undefined) ?? null,
    picture: (decoded.picture as string | undefined) ?? null,
    emailVerified: Boolean(decoded.email_verified),
  };
}