import { NextResponse } from "next/server";
import { sessionCookieName, sessionCookieOpts } from "@/lib/auth";

/**
 * Clears the CivicShield session cookie. (The client also signs out of
 * Firebase in the browser before calling this, so both layers are cleared.)
 */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(sessionCookieName(), "", { ...sessionCookieOpts(0), maxAge: 0 });
  return res;
}
