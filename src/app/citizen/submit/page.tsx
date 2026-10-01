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
import { locationErrorCode, type LocationErrorCode } from "@/lib/location";

/* ── Minimal Web Speech API types (not in TS DOM lib) ─────────────────── */
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
};
function getRecognition(): SpeechRecognitionLike | null {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

const SPEECH_LOCALES: Record<string, string> = { en: "en-IN", hi: "hi-IN", mr: "mr-IN" };

type SubmitResult = {
  complaint: { complaintId: string; refCode: string; category: string; severity: string; priority: number; departmentCode: string; duplicateOfRef?: string; agentRunId: string };
};

const STEPS = ["Describe", "Evidence", "Location", "Review", "Submitted"] as const;

export default function SubmitPage() {
  const { t } = useLang();
  const [description, setDescription] = useState("");
  const [language, setLanguage] = useState("en");
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  const [address, setAddress] = useState("");
  const [locating, setLocating] = useState(false);
  // Phase 4 geospatial reliability: honest capture metadata. Coordinates are
  // authoritative; the address field is descriptive only. A geolocation
  // failure NEVER substitutes a default location — the report simply goes in
  // without coordinates (or the user types a landmark).
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);
  const [locSource, setLocSource] = useState<"GPS" | "UNKNOWN">("UNKNOWN");
  const [locError, setLocError] = useState<{ code: LocationErrorCode; message: string } | null>(null);
  const [listening, setListening] = useState(false);
  const [recAvailable, setRecAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SubmitResult["complaint"] | null>(null);
  const [devVision, setDevVision] = useState(false);
  const [demoHint, setDemoHint] = useState("");
  const [activities, setActivities] = useState<Activity[]>([]);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
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

  // Stepper position — derived, never stored, so it can't drift from reality.
  const step = result ? 5 : photo || description.trim().length >= 10 ? 1 : 0;
  const geoKnown = lat != null && lng != null;

  function onPhoto(f: File | null) {
    setPhoto(f);
    setPhotoPreview(f ? URL.createObjectURL(f) : null);
  }

  function locate() {
    if (!navigator.geolocation) {
      setLocError({ code: "GEO_UNSUPPORTED", message: "Geolocation is not available in this browser. You can type a landmark/address instead." });
      return;
    }
    setLocating(true);
    setLocError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const c = pos.coords;
        // Guard against a device reporting garbage (Phase 4 A3): never store
        // out-of-range or non-numeric coordinates, even from the browser.
        if (
          typeof c.latitude !== "number" || typeof c.longitude !== "number" ||
          !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude) ||
          c.latitude < -90 || c.latitude > 90 || c.longitude < -180 || c.longitude > 180
        ) {
          setLocError({ code: "POSITION_UNAVAILABLE", message: "The device returned invalid coordinates. Please retry or type a landmark below." });
          setLocating(false);
          return;
        }
        setLat(Number(c.latitude.toFixed(6)));
        setLng(Number(c.longitude.toFixed(6)));
        setAccuracy(c.accuracy != null && Number.isFinite(c.accuracy) && c.accuracy >= 0 ? c.accuracy : null);
        setCapturedAt(new Date(pos.timestamp).toISOString());
        setLocSource("GPS");
        setLocating(false);
      },
      (err) => {
        // Machine-readable code + honest message. No fallback location, ever:
        // the user can retry or continue with a manually typed landmark.
        const code = locationErrorCode(err);
        const messages: Record<LocationErrorCode, string> = {
          PERMISSION_DENIED: "Location permission was denied. Enable it in your browser, retry, or type a landmark below.",
          POSITION_UNAVAILABLE: "Your position is currently unavailable. You can retry or type a landmark below.",
          TIMEOUT: "Getting your location timed out. Try again, or type a landmark below.",
          GEO_UNSUPPORTED: "Geolocation is not available in this browser. You can type a landmark/address instead.",
          INVALID_COORDINATES: "The device returned invalid coordinates. Please retry or type a landmark below.",
          UNKNOWN: "Could not get your location. You can retry or type a landmark below.",
        };
        setLocError({ code, message: messages[code] });
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5 * 60_000 }
    );
  }

  function toggleVoice() {
    if (listening) {
      recRef.current?.stop();
      setListening(false);
      return;
    }
    const rec = getRecognition();
    if (!rec) return;
    rec.lang = SPEECH_LOCALES[language] ?? "en-IN";
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript + " ";
      setDescription(text.trim());
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recRef.current = rec;
    rec.start();
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
              <button type="button" onClick={locate} className="cs-btn cs-btn-secondary">
                {locating ? <><Spinner /> Locating…</> : <>📍 {t("useLocation")}</>}
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
              {geoKnown && locSource === "GPS" && (
                <span className="text-[11px] text-cs-secondary/70">from device GPS</span>
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
