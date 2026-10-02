"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { Card, ErrorNote, Spinner, StatusBadge } from "@/components/ui";
import { AgentActivityPanel, type Activity } from "@/components/AgentActivityPanel";
import { api, fetchMe } from "@/lib/client";
import { useLang } from "@/lib/i18n";
import { CATEGORIES, categoryLabels, ACCURACY_GOOD_METERS, ACCURACY_DEGRADED_METERS } from "@/lib/constants";
import { type LocationErrorCode } from "@/lib/location";
import { acquireBestLocation, type GpsWatcher } from "@/lib/locationAcquisition";

/* ── Minimal Web Speech API types (not in TS DOM lib) ─────────────────── */
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
};
function getRecognition(): SpeechRecognitionLike | null {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

const SPEECH_LOCALES: Record<string, string> = { en: "en-IN", hi: "hi-IN", mr: "mr-IN" };

/** Genuine SpeechRecognition failures — retrying cannot recover these. */
const VOICE_FATAL_ERRORS: Record<string, string> = {
  "not-allowed": "Microphone permission was blocked. Allow microphone access in your browser and try again.",
  "service-not-allowed": "Speech recognition is not available in this browser context. You can still type the complaint.",
  "audio-capture": "No microphone was detected. Connect a microphone, or type the complaint.",
  "language-not-supported": "Speech recognition does not support the selected language. You can still type the complaint.",
};
/** Transient speech-service failures tolerated (each session restart is a retry). */
const VOICE_MAX_NETWORK_FAILURES = 3;
/** Benign silence/abort cycles tolerated before stopping with honest guidance. */
const VOICE_MAX_SILENT_SESSIONS = 8;

/**
 * Classify a SpeechRecognition error event into the dictation lifecycle's
 * three branches. Pure function so the policy is unit-testable.
 */
export function classifyVoiceError(errorCode: string | undefined): "fatal" | "transient" | "benign" {
  if (errorCode && VOICE_FATAL_ERRORS[errorCode]) return "fatal";
  if (errorCode === "network") return "transient";
  return "benign"; // "no-speech", "aborted", unknown — session-level, restartable
}
type SubmitResult = {
  complaint: { complaintId: string; refCode: string; category: string; severity: string; priority: number; departmentCode: string; duplicateOfRef?: string; agentRunId: string };
};

const STEPS = ["Describe", "Evidence", "Location", "Review", "Submitted"] as const;

/** Location acquisition lifecycle shown in the UI. */
type LocPhase = "idle" | "acquiring" | "confirmed" | "error";

export default function SubmitPage() {
  const { t } = useLang();
  const [description, setDescription] = useState("");
  const [language, setLanguage] = useState("en");
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  const [address, setAddress] = useState("");
  // Phase 4 geospatial reliability: honest capture metadata. Coordinates are
  // authoritative; the address field is descriptive only. A geolocation
  // failure NEVER substitutes a default location — the report simply goes in
  // without coordinates (or the user types a landmark).
  //
  // Progressive accuracy acquisition: the browser's first fix is often a
  // coarse cell/wifi reading, so the page keeps watching and retains the BEST
  // valid reading until the accuracy target is reached or a bounded window
  // expires (see src/lib/locationAcquisition.ts). lat/lng/accuracy/
  // capturedAt always belong to the SAME best reading — never mixed.
  const [locPhase, setLocPhase] = useState<LocPhase>("idle");
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);
  const [locSource, setLocSource] = useState<"GPS" | "UNKNOWN">("UNKNOWN");
  const [locError, setLocError] = useState<{ code: LocationErrorCode; message: string } | null>(null);
  const locWatcherRef = useRef<GpsWatcher | null>(null);
  const locHasFixRef = useRef(false); // closure-safe "a fix is held" for settle callbacks
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [recAvailable, setRecAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SubmitResult["complaint"] | null>(null);
  const [devVision, setDevVision] = useState(false);
  const [demoHint, setDemoHint] = useState("");
  const [activities, setActivities] = useState<Activity[]>([]);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  // Voice dictation lifecycle. Chrome's SpeechRecognition ends its sessions on
  // its own (silence timeouts, final results, service hiccups) even with
  // continuous = true, so track the user's intent and restart transparently.
  const wantVoiceRef = useRef(false); // true from mic click until user stop / fatal error
  const voiceCommittedRef = useRef(""); // transcript from sessions that already ended
  const voiceLiveRef = useRef(""); // transcript of the session currently in flight
  const voiceFailuresRef = useRef(0); // consecutive speech-service failures without a result
  const voiceSilentRef = useRef(0); // consecutive sessions ending without ANY result
  const router = useRouter();

  useEffect(() => {
    fetchMe().then((u) => {
      if (!u) { router.push("/login"); return; }
      if (u.role !== "CITIZEN" && u.role !== "OFFICIAL") { router.push(u.role === "WORKER" ? "/worker" : "/official"); return; }
    });
    fetch("/api/health/ai").then((r) => r.json()).then((d) => setDevVision(/^dev/i.test(String(d.providers?.vision)))).catch(() => {});
    const t = setTimeout(() => setRecAvailable(Boolean(getRecognition())), 0);
    return () => clearTimeout(t);
  }, [router]);

  // Leaving the page must never leave the microphone hot: end any live
  // dictation session when the component is actually abandoned.
  useEffect(() => {
    return () => {
      wantVoiceRef.current = false;
      try {
        recRef.current?.stop();
      } catch {
        // Session already ended — nothing to stop.
      }
    };
  }, []);

  // Leaving the page must never leave a GPS watcher running either.
  useEffect(() => {
    return () => {
      locWatcherRef.current?.clear();
      locWatcherRef.current = null;
    };
  }, []);

  // Stepper position — derived, never stored, so it can't drift from reality.
  const step = result ? 5 : photo || description.trim().length >= 10 ? 1 : 0;
  const geoKnown = lat != null && lng != null;

  function onPhoto(f: File | null) {
    setPhoto(f);
    setPhotoPreview(f ? URL.createObjectURL(f) : null);
  }

  /**
   * Progressive location acquisition: watchPosition until the accuracy
   * target is reached or the bounded window expires, retaining the best
   * valid reading. The browser-reported coords.accuracy is the source of
   * truth; lat/lng/accuracy always travel together as ONE reading.
   */
  function locate() {
    if (!navigator.geolocation) {
      setLocPhase("error");
      setLocError({ code: "GEO_UNSUPPORTED", message: "Geolocation is not available in this browser. You can type a landmark/address instead." });
      return;
    }
    // A fresh hunt replaces any previous one; the previous watcher is cleared
    // so two watches can never run concurrently.
    locWatcherRef.current?.clear();
    locWatcherRef.current = null;

    setLocPhase("acquiring");
    setLocError(null);
    setLat(null);
    setLng(null);
    setAccuracy(null);
    setCapturedAt(null);
    setLocSource("GPS");
    locHasFixRef.current = false;

    const messages: Record<LocationErrorCode, string> = {
      PERMISSION_DENIED: "Location permission was denied. Enable it in your browser, retry, or type a landmark below.",
      POSITION_UNAVAILABLE: "Your position is currently unavailable. You can retry or type a landmark below.",
      TIMEOUT: "Getting your location timed out. Try again, or type a landmark below.",
      GEO_UNSUPPORTED: "Geolocation is not available in this browser. You can type a landmark/address instead.",
      INVALID_COORDINATES: "The device returned invalid coordinates. Please retry or type a landmark below.",
      UNKNOWN: "Could not get your location. You can retry or type a landmark below.",
    };

    locWatcherRef.current = acquireBestLocation({
      onProgress: (reading) => {
        locHasFixRef.current = true;
        setLat(reading.lat);
        setLng(reading.lng);
        setAccuracy(reading.accuracyMeters);
        setCapturedAt(reading.capturedAt.toISOString());
        setLocSource("GPS");
      },
      onSettled: (outcome) => {
        locWatcherRef.current = null;
        if (outcome.kind === "confirmed") {
          setLocPhase("confirmed");
          return;
        }
        if (locHasFixRef.current) {
          // A best reading is already held. Permission revoked mid-hunt:
          // keep the best fix, but say why the improvement stopped. Transient
          // failures (TIMEOUT / POSITION_UNAVAILABLE) keep the fix usable.
          if (outcome.code === "PERMISSION_DENIED") {
            setLocPhase("confirmed");
            setLocError({ code: outcome.code, message: messages.PERMISSION_DENIED });
          }
          return;
        }
        // No reading at all — honest failure, no invented location.
        setLocPhase("error");
        setLocError({ code: outcome.code, message: messages[outcome.code] });
      },
    });
  }

  /** End the current dictation session deliberately (user stop, submit, unmount). */
  function stopVoice() {
    wantVoiceRef.current = false;
    try {
      recRef.current?.stop();
    } catch {
      // Session already ended — nothing to stop.
    }
    setListening(false);
  }

  function toggleVoice() {
    if (listening) {
      stopVoice();
      return;
    }
    if (wantVoiceRef.current) return; // double-click guard: never two live sessions
    const rec = getRecognition();
    if (!rec) return;

    // Fresh dictation. The transcript replaces the field (existing behavior)
    // but is accumulated across the transparent session restarts below.
    wantVoiceRef.current = true;
    voiceCommittedRef.current = "";
    voiceLiveRef.current = "";
    voiceFailuresRef.current = 0;
    voiceSilentRef.current = 0;
    setVoiceError("");

    rec.lang = SPEECH_LOCALES[language] ?? "en-IN";
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript + " ";
      voiceLiveRef.current = text.trim();
      voiceFailuresRef.current = 0;
      voiceSilentRef.current = 0;
      setDescription(`${voiceCommittedRef.current} ${voiceLiveRef.current}`.trim());
    };
    rec.onerror = (e) => {
      const kind = classifyVoiceError(e?.error);
      if (kind === "fatal") {
        // Genuine error (permission denied, no microphone, unsupported
        // language): stop for real and say why — never fail silently.
        wantVoiceRef.current = false;
        setListening(false);
        setVoiceError(VOICE_FATAL_ERRORS[e?.error ?? ""]);
        return;
      }
      if (kind === "transient") {
        // The speech service is unreachable. Allow a couple of transparent
        // restarts, then fail honestly instead of retrying forever.
        voiceFailuresRef.current += 1;
        if (voiceFailuresRef.current >= VOICE_MAX_NETWORK_FAILURES) {
          wantVoiceRef.current = false;
          setListening(false);
          setVoiceError("The speech recognition service is unreachable. Check your connection, or type the complaint.");
        }
      }
      // "no-speech" / "aborted" stay benign here, but a LONG run of sessions
      // that end without ever producing a result means the mic is muted or
      // the service is silently failing — onend stops after the bound above.
    };
    rec.onend = () => {
      if (!wantVoiceRef.current) {
        setListening(false);
        return;
      }
      // Chrome ends recognition sessions on its own (silence timeout, final
      // result, service hiccup) even with continuous = true. Keep dictation
      // alive until the user actually presses Stop by starting a new session.
      if (!voiceLiveRef.current) voiceSilentRef.current += 1;
      if (voiceSilentRef.current >= VOICE_MAX_SILENT_SESSIONS) {
        // Bounded honesty: several silent cycles without a single word is a
        // muted mic / dead service, not a pause in speech — stop instead of
        // spinning restarts forever.
        wantVoiceRef.current = false;
        setListening(false);
        setVoiceError("No speech was detected. Check that your microphone is selected and not muted, then try again — or type the complaint.");
        return;
      }
      voiceCommittedRef.current = `${voiceCommittedRef.current} ${voiceLiveRef.current}`.trim();
      voiceLiveRef.current = "";
      try {
        rec.start();
      } catch {
        // The previous session may still be tearing down; retry once shortly.
        window.setTimeout(() => {
          if (!wantVoiceRef.current) return;
          try {
            rec.start();
          } catch {
            wantVoiceRef.current = false;
            setListening(false);
            setVoiceError("Voice input stopped unexpectedly. Try again, or type the complaint.");
          }
        }, 250);
      }
    };

    recRef.current = rec;
    try {
      rec.start();
    } catch {
      wantVoiceRef.current = false;
      setVoiceError("Voice input could not start in this browser. You can still type the complaint.");
      return;
    }
    setListening(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!description.trim() || description.trim().length < 10) {
      setError("Please describe the issue in at least 10 characters (or use voice input).");
      return;
    }
    setBusy(true);
    // The location that will be submitted is final — stop the GPS hunt so no
    // watcher (and no GPS/battery usage) survives past submission.
    locWatcherRef.current?.clear();
    locWatcherRef.current = null;
    try {
      const fd = new FormData();
      fd.set("description", description);
      fd.set("language", language);
      // Coordinates are sent ONLY when actually known — never silently
      // replaced with a demo city center. Absent coordinates are server-
      // validated as "no physical location yet".
      if (lat != null && lng != null) {
        fd.set("lat", String(lat));
        fd.set("lng", String(lng));
        if (accuracy != null) fd.set("accuracyMeters", String(accuracy));
        if (capturedAt) fd.set("locationCapturedAt", capturedAt);
        fd.set("locationSource", locSource);
      }
      if (address) fd.set("address", address);
      if (photo) fd.set("photo", photo);
      if (devVision && demoHint) fd.set("demoHint", demoHint);

      const res = await api<SubmitResult>("/api/complaints", { formData: fd });
      // The report is in — end any live dictation so the microphone does not
      // stay hot on the receipt screen.
      stopVoice();
      setResult(res.complaint);
      // Reveal the persisted agent decisions for this run.
      const detail = await api<{ complaint: { agentActivities: Activity[] } }>(
        `/api/complaints/${res.complaint.complaintId}`
      );
      setActivities(detail.complaint.agentActivities);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /* ── Result view: receipt + agent pipeline + CTA ───────────────────── */
  if (result) {
    return (
      <AppShell>
        <div className="mx-auto max-w-2xl space-y-4">
          <Card className="cs-fade-up p-6 text-center">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-emerald-400/30 bg-emerald-500/15 text-xl text-emerald-300" aria-hidden>✓</div>
            <p className="mt-3 text-xs font-semibold uppercase tracking-[0.12em] text-emerald-300">Report received</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">{result.refCode}</h1>
            <div className="mt-2 flex justify-center"><StatusBadge status="RECEIVED" pulse /></div>

            <dl className="mt-6 grid grid-cols-2 gap-3 text-left text-sm sm:grid-cols-4">
              <Cell label="Category" value={categoryLabels[result.category] ?? result.category} />
              <Cell label="Severity" value={result.severity} />
              <Cell label="Priority" value={`${result.priority}/100`} />
              <Cell label="Routed to" value={result.departmentCode} />
            </dl>

            {result.duplicateOfRef && (
              <p className="mt-4 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                ⛓ Duplicate Agent linked this to potentially related complaint <strong>{result.duplicateOfRef}</strong>.
              </p>
            )}

            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Link href={`/complaints/${result.complaintId}`} className="cs-btn cs-btn-primary">Track Live Status</Link>
              <Link href="/citizen" className="cs-btn cs-btn-secondary">My Reports</Link>
            </div>
          </Card>

          <AgentActivityPanel activities={activities} title="Agent pipeline — decisions for this report" />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">{t("reportIssue")}</h1>
        <p className="mt-1 text-sm text-cs-secondary">Tell us what&apos;s happening. We&apos;ll handle the routing.</p>

        {/* Stepper */}
        <ol className="my-5 flex items-center gap-1.5" aria-label="Progress">
          {STEPS.map((s, i) => (
            <li key={s} className="flex flex-1 items-center gap-1.5" aria-current={i === step ? "step" : undefined}>
              <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[10px] font-semibold transition ${
                i < step ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-300"
                : i === step ? "border-sky-400/50 bg-sky-500/15 text-sky-300"
                : "border-cs-border text-cs-secondary/60"
              }`}>
                {i < step ? "✓" : i + 1}
              </span>
              <span className={`hidden text-[11px] font-medium sm:block ${i <= step ? "text-cs-text" : "text-cs-secondary/60"}`}>{s}</span>
              {i < STEPS.length - 1 && <span aria-hidden className={`h-px flex-1 ${i < step ? "bg-emerald-400/40" : "bg-cs-border"}`} />}
            </li>
          ))}
        </ol>

        <form onSubmit={submit} className="space-y-4">
          {/* Describe */}
          <Card className="space-y-4 p-5">
            <div>
              <label htmlFor="description" className="text-sm font-medium text-slate-300">What happened?</label>
              <textarea id="description" rows={4} value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Deep pothole near the bus stand, two-wheelers skid every evening…"
                className="cs-input mt-1.5" maxLength={2000} />
              <p className="mt-1 text-right text-[11px] text-cs-secondary/70">{description.length}/2000</p>
            </div>

            {/* Voice */}
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-40 flex-1">
                <label htmlFor="language" className="text-sm font-medium text-slate-300">{t("language")}</label>
                <select id="language" value={language} onChange={(e) => setLanguage(e.target.value)} className="cs-input mt-1.5">
                  <option value="en">English</option>
                  <option value="hi">हिंदी (Hindi)</option>
                  <option value="mr">मराठी (Marathi)</option>
                </select>
              </div>
              <button type="button" onClick={toggleVoice} disabled={!recAvailable}
                className={`cs-btn ${listening ? "cs-btn-danger" : "cs-btn-secondary"} disabled:opacity-40`}>
                {listening ? <>■ {t("stop")}</> : <>🎙 {t("recordVoice")}</>}
              </button>
            </div>
            {listening && <p className="flex items-center gap-2 text-sm text-rose-300"><span className="cs-pulse-dot h-2 w-2 rounded-full bg-rose-400" /> {t("listening")}</p>}
            {voiceError && <p role="alert" className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">⚠ {voiceError}</p>}
            {!recAvailable && <p className="text-xs text-cs-secondary/70">Voice input needs a Chromium-based browser; you can still type the complaint.</p>}
          </Card>

          {/* Evidence */}
          <Card className="p-5">
            <label htmlFor="photo" className="text-sm font-medium text-slate-300">{t("takePhoto")}</label>
            {photoPreview ? (
              <div className="relative mt-2 overflow-hidden rounded-xl border border-cs-border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoPreview} alt="Selected issue preview" className="max-h-64 w-full object-cover" />
                <button type="button" onClick={() => onPhoto(null)}
                  className="absolute right-2 top-2 rounded-lg border border-cs-border bg-cs-bg/85 px-2.5 py-1 text-xs font-medium text-cs-text backdrop-blur-sm hover:bg-cs-elevated">
                  Remove
                </button>
              </div>
            ) : (
              <label htmlFor="photo"
                className="mt-2 flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-cs-border bg-cs-bg/40 px-6 py-10 text-center transition hover:border-sky-400/50 hover:bg-sky-500/5">
                <span className="text-2xl" aria-hidden>📷</span>
                <span className="text-sm font-medium text-cs-text">Upload photo</span>
                <span className="text-xs text-cs-secondary">Drag &amp; drop or browse — JPEG/PNG/WebP</span>
                <input id="photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="sr-only"
                  onChange={(e) => onPhoto(e.target.files?.[0] ?? null)} />
              </label>
            )}
            <p className="mt-2 text-xs text-cs-secondary/70">The Vision Agent uses the photo to detect the issue type and confidence.</p>

            {/* Dev-provider vision hint (only when the real YOLO service is not configured) */}
            {devVision && (
              <div className="mt-3 rounded-xl border border-amber-400/30 bg-amber-500/10 p-3">
                <label htmlFor="demoHint" className="text-sm font-medium text-amber-200">Simulated vision — development provider active</label>
                <p className="mt-0.5 text-xs text-amber-200/80">The YOLO service is not configured. Optionally pick what a vision model would detect; this is clearly labeled in the agent log.</p>
                <select id="demoHint" value={demoHint} onChange={(e) => setDemoHint(e.target.value)} className="cs-input mt-2">
                  <option value="">Let the pipeline use text only</option>
                  {CATEGORIES.filter((c) => c !== "OTHER").map((c) => (
                    <option key={c} value={categoryLabels[c]}>{categoryLabels[c]}</option>
                  ))}
                </select>
              </div>
            )}
          </Card>

          {/* Location */}
          <Card className="space-y-3 p-5">
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={locate} className="cs-btn cs-btn-secondary" disabled={locPhase === "acquiring"}>
                {locPhase === "acquiring" ? <><Spinner /> {t("locating")}</> : <>📍 {t("useLocation")}</>}
              </button>
              {geoKnown && (
                <span className="font-mono text-xs text-cs-secondary">{lat!.toFixed(5)}, {lng!.toFixed(5)}</span>
              )}
              {geoKnown && accuracy != null && (
                <span className={`cs-badge ${
                  accuracy <= ACCURACY_GOOD_METERS ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-300"
                  : accuracy <= ACCURACY_DEGRADED_METERS ? "border-amber-400/40 bg-amber-500/15 text-amber-200"
                  : "border-rose-400/40 bg-rose-500/15 text-rose-300"
                }`}>
                  ±{Math.round(accuracy)} m
                </span>
              )}
              {geoKnown && locSource === "GPS" && locPhase === "acquiring" && (
                <span className="text-[11px] text-cs-secondary/70">{t("locImproving")}</span>
              )}
              {geoKnown && locPhase === "confirmed" && (
                <span className="text-[11px] text-emerald-300/90">✓ {t("locConfirmed")}</span>
              )}
            </div>
            {locError && (
              <p role="alert" data-loc-error={locError.code}
                className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                ⚠ {locError.message}
              </p>
            )}
            <div>
              <label htmlFor="address" className="text-sm font-medium text-slate-300">Landmark / address (optional)</label>
              <input id="address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="e.g. Near bus stand, Ward 2" className="cs-input mt-1.5" />
            </div>
          </Card>

          {error && <ErrorNote message={error} />}

          <button type="submit" disabled={busy} className="cs-btn cs-btn-primary w-full !py-3">
            {busy ? (<><Spinner className="border-white/40 border-t-white" /> Agents are working…</>) : t("submit")}
          </button>
        </form>
      </div>
    </AppShell>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-cs-border bg-cs-bg/40 px-3 py-2.5">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.08em] text-cs-secondary">{label}</dt>
      <dd className="mt-0.5 truncate font-medium" title={value}>{value}</dd>
    </div>
  );
}
