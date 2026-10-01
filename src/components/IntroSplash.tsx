"use client";

import { useCallback, useEffect, useState } from "react";

const SEEN_KEY = "cs_intro_seen";
const INTRO_SRC = "/animations/civicshield-intro.mp4";
/** Fail-safe: the video is ~4s — never trap the user behind the splash. */
const MAX_SPLASH_MS = 6000;

/** "idle" = not shown; "playing" = run the animation; "still" = reduced motion (final frame only). */
type Phase = "idle" | "playing" | "still";

function markSeen() {
  try {
    window.sessionStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Storage unavailable (privacy mode): the intro may replay later — never fatal.
  }
}

/**
 * Intro splash: plays the Jitter brand animation once per browser session.
 *
 * Purely presentational — no auth, routing, or API involvement. Fails open:
 * a video error, blocked autoplay, or the fail-safe timer all dismiss it, so
 * the application can never be blocked. prefers-reduced-motion users are
 * shown the completed-logo frame instantaneously (seek to end) instead of
 * the animation. No animation libraries, no rAF, no polling: the browser's
 * native video playback does the work.
 */
export default function IntroSplash() {
  // "idle" on the server and first client render (matches SSR HTML, so no
  // hydration mismatch); the session/reduced-motion decision lands right
  // after mount. Deferred to a microtask so the state update is not
  // synchronous inside the effect body (react-hooks/set-state-in-effect) —
  // it still resolves in the same tick, before the user can interact.
  const [phase, setPhase] = useState<Phase>("idle");

  useEffect(() => {
    queueMicrotask(() => {
      let seen = false;
      try {
        seen = window.sessionStorage.getItem(SEEN_KEY) === "1";
      } catch {
        seen = false;
      }
      if (seen) return;
      const reduced =
        typeof window.matchMedia === "function"
          ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
          : false;
      setPhase(reduced ? "still" : "playing");
    });
  }, []);

  const dismiss = useCallback(() => {
    markSeen();
    setPhase("idle");
  }, []);

  // Scroll lock only while the splash is up; restored on dismissal/unmount.
  useEffect(() => {
    if (phase === "idle") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [phase]);

  // Safe fallback: if autoplay is blocked or events never fire, dismiss anyway.
  useEffect(() => {
    if (phase === "idle") return;
    const timer = window.setTimeout(dismiss, MAX_SPLASH_MS);
    return () => window.clearTimeout(timer);
  }, [phase, dismiss]);

  if (phase === "idle") return null;

  return (
    <div aria-hidden className="fixed inset-0 z-[100] grid place-items-center overflow-hidden bg-[#0B0F17]">
      <video
        className="h-full w-full object-contain"
        src={INTRO_SRC}
        autoPlay={phase === "playing"}
        muted
        playsInline
        preload="auto"
        onEnded={dismiss}
        onError={dismiss}
        onLoadedMetadata={
          phase === "still"
            ? (e) => {
                // Jump straight to the final completed-logo frame — no animation.
                const v = e.currentTarget;
                try {
                  if (Number.isFinite(v.duration)) v.currentTime = v.duration;
                } catch {
                  dismiss();
                }
              }
            : undefined
        }
        onSeeked={phase === "still" ? dismiss : undefined}
      />
    </div>
  );
}
