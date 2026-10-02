"use client";

/**
 * CivicShield AI — Google-only sign-in.
 * One primary action: Continue with Google (Firebase Auth popup flow).
 * No email/password, no OTP, no demo accounts, no role selection.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, homeForRole, type SessionUser } from "@/lib/client";
import { ErrorNote } from "@/components/ui";
import { Logo, ShieldMark } from "@/components/Logo";
import {
  getFirebaseAuth,
  googleProvider,
  firebaseClientConfigured,
} from "@/lib/firebase";
import {
  signInWithPopup,
  signOut,
  setPersistence,
  browserLocalPersistence,
  type User,
} from "firebase/auth";

function friendlyAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  switch (code) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Google sign-in was cancelled.";
    case "auth/popup-blocked":
      return "Please allow the Google sign-in window (popups) and try again.";
    case "auth/popup-request-pending":
      return "A sign-in window is already open — complete or close it first.";
    case "auth/network-request-failed":
      return "Unable to connect. Please check your internet and try again.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a moment and try again.";
    case "auth/operation-not-allowed":
    case "auth/unauthorized-domain":
      return "Google sign-in is not enabled for this domain yet. Contact the operator.";
    default:
      return "Sign-in failed. Please try again.";
  }
}

export default function LoginPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const attempted = useRef(false);
  const router = useRouter();

  // Optional silent resume: if Firebase still has a signed-in user (e.g. the
  // tab reloaded mid-login), exchange it without re-prompting.
  const notConfigured = !firebaseClientConfigured();
  useEffect(() => {
    if (notConfigured) return;
    const auth = getFirebaseAuth();
    const unsub = auth.onAuthStateChanged(async (u: User | null) => {
      if (u && !attempted.current && !busy) {
        attempted.current = true;
        await exchangeToken(u, { silent: true });
      }
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notConfigured]);

  async function exchangeToken(fbUser: User, opts: { silent?: boolean } = {}) {
    if (!opts.silent) setBusy(true);
    setError("");
    try {
      const idToken = await fbUser.getIdToken(true); // force refresh
      const { user } = await api<{ user: { role: string } }>("/api/auth/google", { body: { idToken } });
      // Route by the SERVER-verified role (the only authoritative source).
      router.push(homeForRole(user.role as SessionUser["role"]));
      router.refresh();
    } catch (err) {
      // Backend rejected the session — sign out of Firebase so no half-state.
      await signOut(getFirebaseAuth()).catch(() => {});
      if (opts.silent) return; // silent resume failures stay quiet
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function handleGoogle() {
    attempted.current = true;
    setBusy(true);
    setError("");
    try {
      const auth = getFirebaseAuth();
      await setPersistence(auth, browserLocalPersistence);
      const { user } = await signInWithPopup(auth, googleProvider());
      await exchangeToken(user);
    } catch (err) {
      setError(friendlyAuthError(err));
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_460px]">
      {/* Brand panel */}
      <div className="relative hidden flex-col justify-between overflow-hidden border-r border-cs-border p-10 lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(700px 380px at 70% 20%, rgba(37,99,235,0.22), transparent 60%), radial-gradient(500px 300px at 20% 80%, rgba(16,185,129,0.08), transparent 55%)",
          }}
        />
        <Logo size={34} />
        <div className="relative">
          <ShieldMark size={56} />
          <h1 className="mt-6 max-w-md text-3xl font-semibold leading-tight tracking-tight">
            Report. Resolve. <span className="text-sky-400">Improve.</span>
          </h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-cs-secondary">
            AI-powered civic issue reporting and response — reports are analyzed,
            deduplicated, routed to the right department, and the repair is
            verified before a case can close.
          </p>
          <ul className="mt-8 space-y-3 text-sm text-cs-secondary">
            {["AI triage with explainable severity", "Duplicate intelligence across the city", "SLA clocks with auto-escalation"].map((x) => (
              <li key={x} className="flex items-center gap-2.5">
                <span className="grid h-5 w-5 place-items-center rounded-full border border-emerald-400/30 bg-emerald-500/10 text-[10px] text-emerald-300" aria-hidden>✓</span>
                {x}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-cs-secondary/60">CivicShield AI — original hackathon build</p>
      </div>

      {/* Sign-in panel */}
      <div className="flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex justify-center lg:hidden">
            <Logo size={34} />
          </div>
          <div className="cs-card cs-fade-up p-6 text-center">
            <h2 className="text-lg font-semibold">CivicShield AI</h2>
            <p className="mt-1 text-sm text-cs-secondary">
              Report. Resolve. Improve. — secure authentication to your civic account.
            </p>

            {error && <div className="mt-4 text-left"><ErrorNote message={error} /></div>}

            {notConfigured ? (
              <div className="mt-5 rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-left text-sm text-amber-200" role="alert">
                Google sign-in is not configured yet. Set the <code className="font-mono text-xs">NEXT_PUBLIC_FIREBASE_*</code> variables in <code className="font-mono text-xs">.env</code> and reload.
              </div>
            ) : (
              <button
                onClick={handleGoogle}
                disabled={busy}
                className="mt-5 flex w-full items-center justify-center gap-3 rounded-xl border border-cs-border bg-white px-4 py-3 text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? (
                  <span className="inline-block h-4 w-4 rounded-full border-2 border-slate-300 border-t-sky-500" style={{ animation: "cs-spin 0.8s linear infinite" }} aria-hidden />
                ) : (
                  <GoogleG />
                )}
                {busy ? "Signing you in…" : "Continue with Google"}
              </button>
            )}

            <p className="mt-5 flex items-center justify-center gap-1.5 text-xs text-cs-secondary">
              <ShieldMark size={13} /> Secure authentication · powered by Google
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Official multi-brand Google "G" mark. */
function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
