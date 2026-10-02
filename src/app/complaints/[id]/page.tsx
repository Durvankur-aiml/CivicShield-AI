"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import {
  Card,
  StatusBadge,
  SeverityBadge,
  CategoryTag,
  DemoBadge,
  Skeleton,
  LoginPrompt,
  ErrorNote,
  EmptyState,
  SectionHeading,
  Spinner,
} from "@/components/ui";
import MapPanel from "@/components/MapPanel";
import { AgentActivityPanel, type Activity } from "@/components/AgentActivityPanel";
import { api, fetchMe, fmtDateTime, fmtCountdown, type SessionUser } from "@/lib/client";
import { useLang } from "@/lib/i18n";
import {
  ArrowLeft,
  BellRing,
  Building2,
  CalendarClock,
  CheckCheck,
  CircleAlert,
  CircleCheck,
  CircleX,
  ClipboardList,
  Gauge,
  MapPin,
  Mic,
  Route,
  ShieldCheck,
  Trash2,
  User,
} from "lucide-react";

type ComplaintDetail = {
  id: string; refCode: string; title: string; description: string; category: string; severity: string;
  priority: number; status: string; source: string; lat: number | null; lng: number | null; address: string | null;
  ward: string | null; language: string; transcript: string | null; aiConfidence: number | null; aiSummary: string | null;
  photoUrl: string | null; resolutionUrl: string | null; slaHours: number | null; slaDueAt: string | null;
  isOverdue: boolean; verified: boolean | null; verificationConfidence: number | null; verificationReason: string | null; verificationProvider: string | null;
  verificationResult: string | null; accuracyMeters: number | null; locationSource: string | null; locationCapturedAt: string | null;
  verifiedAt: string | null; escalationCount: number; reopenedCount: number; duplicateOf: { refCode: string } | null;
  duplicates: Array<{ refCode: string }>; createdAt: string; assignedAt: string | null; startedAt: string | null;
  submittedAt: string | null; resolvedAt: string | null;
  slaState: "ON_TRACK" | "WARNING" | "BREACHED" | "ESCALATED" | "RESOLVED";
  activeAssignment: { id: string; status: string; mode: string } | null;
  reporterId: string;
  reporter: { name: string }; assignedTo: { name: string } | null; department: { code: string; name: string } | null;
  events: Array<{ id: string; type: string; actor: string; title: string; detail: string | null; createdAt: string }>;
  agentActivities: Activity[];
  escalations: Array<{ id: string; level: number; reason: string; createdAt: string }>;
};

/** Real derived SLA state (computed by the API via slaStateFor) → visual ticket. */
function slaTicket(state: ComplaintDetail["slaState"], t: (k: string) => string) {
  switch (state) {
    case "RESOLVED":
      return { Icon: CircleCheck, tone: "text-emerald-300", bg: "bg-emerald-500/10 border-emerald-400/30", label: t("slaResolved") };
    case "ESCALATED":
      return { Icon: CircleAlert, tone: "text-red-300", bg: "bg-red-500/10 border-red-400/30", label: t("slaEscalated") };
    case "BREACHED":
      return { Icon: CircleX, tone: "text-red-300", bg: "bg-red-500/10 border-red-400/30", label: t("slaBreached") };
    case "WARNING":
      return { Icon: BellRing, tone: "text-amber-300", bg: "bg-amber-500/10 border-amber-400/30", label: t("slaWarning") };
    default:
      return { Icon: CircleCheck, tone: "text-emerald-300", bg: "bg-emerald-500/10 border-emerald-400/30", label: t("slaOnTrack") };
  }
}

/** Backend assignment status (AssignmentStatus enum) → citizen-safe phrasing. */
function assignmentStateKey(status: string): string {
  switch (status) {
    case "OFFERED": return "assignmentOffered";
    case "ACCEPTED": return "assignmentAccepted";
    case "STARTED": return "assignmentStarted";
    case "COMPLETED": return "assignmentCompleted";
    case "REJECTED": return "assignmentRejected";
    default: return "assignmentState";
  }
}

const EVENT_TONE: Record<string, { dot: string }> = {
  CREATED: { dot: "bg-slate-400" },
  STATUS: { dot: "bg-blue-400" },
  ASSIGNMENT: { dot: "bg-indigo-400" },
  ASSIGNMENT_OFFERED: { dot: "bg-indigo-400" },
  ASSIGNMENT_ACCEPTED: { dot: "bg-indigo-400" },
  ASSIGNMENT_STARTED: { dot: "bg-indigo-400" },
  ASSIGNMENT_COMPLETED: { dot: "bg-emerald-400" },
  ASSIGNMENT_REJECTED: { dot: "bg-amber-400" },
  VERIFICATION: { dot: "bg-emerald-400" },
  EVIDENCE: { dot: "bg-emerald-400" },
  ESCALATION: { dot: "bg-red-400" },
  SLA: { dot: "bg-amber-400" },
  SLA_WARNING: { dot: "bg-amber-400" },
  SLA_BREACH: { dot: "bg-red-400" },
  OFFICIAL_OVERRIDE: { dot: "bg-violet-400" },
  NOTIFICATION: { dot: "bg-slate-400" },
};

export default function ComplaintDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [me, setMe] = useState<SessionUser | null | undefined>(undefined);
  const [c, setC] = useState<ComplaintDetail | null>(null);
  const [error, setError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const { t } = useLang();
  const router = useRouter();

  useEffect(() => {
    fetchMe().then(setMe);
    api<{ complaint: ComplaintDetail }>(`/api/complaints/${id}`)
      .then((d) => setC(d.complaint))
      .catch((e) => setError((e as Error).message));
  }, [id]);

  if (me === null) return <AppShell><LoginPrompt /></AppShell>;

  const notFound = /not found/i.test(error);
  const noAccess = /access/i.test(error);

  // Citizen can withdraw their own report ONLY while it is still unassigned
  // and untouched by worker processing (server enforces the same rule).
  const canDelete =
    me != null &&
    c != null &&
    me.id === c.reporterId &&
    c.status === "RECEIVED" &&
    c.activeAssignment == null &&
    c.assignedTo == null;

  async function deleteReport() {
    if (!c || deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await api(`/api/complaints/${id}`, { method: "DELETE" });
      // Hand the success notice to the reports list (survives navigation).
      try {
        sessionStorage.setItem("cs_report_deleted", c.refCode);
      } catch {
        // Storage unavailable — navigation still works.
      }
      router.push("/citizen");
    } catch (e) {
      setDeleteError((e as Error).message || t("deleteFailed"));
      setConfirmingDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <AppShell>
      {error && (
        <div className="mx-auto max-w-5xl">
          {notFound || noAccess ? (
            <Card className="p-8">
              <EmptyState
                title={notFound ? t("notFoundTitle") : t("noAccessTitle")}
                hint={notFound ? t("notFoundHint") : t("noAccessHint")}
                icon={notFound ? <ClipboardList className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}
                action={<Link href="/citizen" className="cs-btn cs-btn-primary">{t("backToReports")}</Link>}
              />
            </Card>
          ) : (
            <ErrorNote message={error} />
          )}
        </div>
      )}
      {!c && !error && (
        <div className="mx-auto max-w-5xl space-y-4">
          <Skeleton className="h-36" />
          <Skeleton className="h-56" />
          <Skeleton className="h-40" />
        </div>
      )}
      {c && (
        <div className="mx-auto max-w-5xl space-y-4">
          {/* ── 1. Report header ─────────────────────────────────────── */}
          <Card className="cs-fade-up p-5">
            <Link
              href="/citizen"
              className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium text-cs-secondary transition hover:text-cs-text"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
              {t("backToReports")}
            </Link>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm text-cs-secondary">{c.refCode}</span>
              <StatusBadge status={c.status} pulse={["IN_PROGRESS", "VERIFICATION"].includes(c.status)} />
              <SeverityBadge severity={c.severity} />
              <CategoryTag category={c.category} />
              {c.source === "DEMO" && <DemoBadge />}
              {c.isOverdue && <span className="cs-badge border-red-400/40 bg-red-500/15 text-red-300">{t("overdue")}</span>}
            </div>
            <h1 className="font-display mt-2.5 text-xl font-semibold tracking-tight text-cs-text sm:text-2xl">{c.title}</h1>
            <p className="mt-1.5 text-xs text-cs-secondary tnum">
              {t("reportedBy")} {c.reporter.name} · {fmtDateTime(c.createdAt)}
            </p>

            {/* Citizen withdrawal — own report, still unassigned (B5). */}
            {canDelete && (
              <div className="mt-4">
                {!confirmingDelete ? (
                  <button type="button" onClick={() => setConfirmingDelete(true)} className="cs-btn cs-btn-secondary text-rose-300 hover:border-rose-400/40 hover:bg-rose-500/10">
                    <Trash2 className="h-4 w-4" aria-hidden />
                    {t("deleteReport")}
                  </button>
                ) : (
                  <div role="alertdialog" aria-label={t("deleteReport")} className="rounded-xl border border-rose-400/30 bg-rose-500/10 p-3.5">
                    <p className="text-sm font-semibold text-rose-200">{t("deleteConfirmTitle")}</p>
                    <p className="mt-1 text-xs text-rose-200/80">{t("deleteConfirmBody")}</p>
                    {deleteError && <p className="mt-2 text-xs text-rose-300">{deleteError}</p>}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button type="button" onClick={deleteReport} disabled={deleting} className="cs-btn bg-rose-500/80 text-white hover:bg-rose-500 disabled:opacity-50">
                        {deleting ? <Spinner className="h-3.5 w-3.5" /> : <Trash2 className="h-4 w-4" aria-hidden />}
                        {deleting ? t("deleting") : t("deleteConfirmCta")}
                      </button>
                      <button type="button" onClick={() => setConfirmingDelete(false)} disabled={deleting} className="cs-btn cs-btn-secondary disabled:opacity-50">
                        {t("cancel")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── 7. SLA / status strip (real derived state from the API) ── */}
            {(() => {
              const ticket = slaTicket(c.slaState, t);
              const { Icon } = ticket;
              return (
                <div className={`mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border px-3.5 py-2.5 text-sm ${ticket.bg} ${ticket.tone}`}>
                  <span className="inline-flex items-center gap-2 font-semibold">
                    <Icon className="h-4 w-4" aria-hidden />
                    {t("slaStatus")}: {ticket.label}
                  </span>
                  {c.slaDueAt && !["RESOLVED"].includes(c.slaState) && (
                    <span className="tnum text-xs">
                      {t("slaDue")} {fmtDateTime(c.slaDueAt)}
                      {!c.isOverdue && <> · {t("sla")} {fmtCountdown(c.slaDueAt)}</>}
                    </span>
                  )}
                  {c.slaHours != null && (
                    <span className="tnum text-xs">{c.slaHours}h {t("slaWindow")}</span>
                  )}
                  {c.resolvedAt && (
                    <span className="tnum text-xs">{t("resolvedOn")} {fmtDateTime(c.resolvedAt)}</span>
                  )}
                </div>
              );
            })()}
          </Card>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="space-y-4 lg:col-span-2">
              {/* ── 2. Report overview (citizen's own submission) ──────── */}
              <Card className="cs-fade-up p-4 sm:p-5">
                <SectionHeading title={t("overview")} />
                {c.photoUrl && (
                  <figure className="mb-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={c.photoUrl}
                      alt="Citizen's original photo of the issue"
                      className="max-h-80 w-full rounded-xl border border-cs-border object-cover"
                    />
                    <figcaption className="mt-1.5 text-xs text-cs-secondary">Before — citizen&apos;s photo</figcaption>
                  </figure>
                )}
                {/* User-generated content is rendered verbatim — never translated. */}
                <p className="text-sm leading-relaxed text-cs-text">{c.description}</p>
                {c.transcript && (
                  <div className="mt-3 rounded-xl border border-cs-border bg-cs-bg/50 px-3 py-2.5">
                    <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-cs-secondary">
                      <Mic className="h-3 w-3" aria-hidden />
                      {t("voiceTranscript")}
                      {c.language !== "en" && <span className="font-mono normal-case tracking-normal text-cs-faint">({c.language.toUpperCase()})</span>}
                    </div>
                    <p className="mt-1 text-sm text-cs-text">{c.transcript}</p>
                  </div>
                )}
                <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2.5 text-sm sm:grid-cols-3">
                  {c.language !== "en" && <Item label={t("language")} value={c.language.toUpperCase()} />}
                  <Item label={t("priority")} value={`${c.priority}/100`} />
                  {c.aiConfidence != null && (
                    <Item label={t("aiConfidenceLabel")} value={`${(c.aiConfidence * 100).toFixed(0)}%`} />
                  )}
                </dl>
              </Card>

              {/* ── 3. AI analysis (only fields the API actually returns) ── */}
              <Card className="cs-fade-up border-indigo-400/20 p-4 sm:p-5">
                <SectionHeading
                  title={t("aiAnalysis")}
                  aside={c.aiConfidence != null ? <Gauge className="h-4 w-4 text-indigo-300" aria-hidden /> : undefined}
                />
                {c.aiSummary || c.aiConfidence != null ? (
                  <div className="space-y-2.5">
                    {c.aiSummary && (
                      <div>
                        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-cs-secondary">{t("aiSummaryLabel")}</div>
                        <p className="mt-1 text-sm leading-relaxed text-cs-text">{c.aiSummary}</p>
                      </div>
                    )}
                    {c.aiConfidence != null && (
                      <div className="flex items-center gap-2.5">
                        <div
                          className="h-1.5 w-32 overflow-hidden rounded-full bg-cs-elevated"
                          role="meter"
                          aria-valuenow={Math.round(c.aiConfidence * 100)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-label={t("aiConfidenceLabel")}
                        >
                          <div className="h-full rounded-full bg-indigo-400" style={{ width: `${Math.round(c.aiConfidence * 100)}%` }} />
                        </div>
                        <span className="tnum text-xs text-cs-secondary">{(c.aiConfidence * 100).toFixed(0)}%</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <EmptyState title={t("aiUnavailable")} icon={<ShieldCheck className="h-5 w-5" />} />
                )}
              </Card>

              {/* ── 4. Duplicate detection (existing backend semantics) ── */}
              {(c.duplicateOf || c.duplicates.length > 0) && (
                <Card className="cs-fade-up border-amber-400/25 bg-amber-500/5 p-4 sm:p-5">
                  <SectionHeading title={t("relatedReports")} />
                  {c.duplicateOf && (
                    <p className="flex flex-wrap items-center gap-1.5 text-sm text-amber-200">
                      <Route className="h-3.5 w-3.5" aria-hidden />
                      {t("duplicateOf")}: <span className="font-mono font-semibold">{c.duplicateOf.refCode}</span>
                    </p>
                  )}
                  {c.duplicates.length > 0 && (
                    <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-sm text-amber-200">
                      <Route className="h-3.5 w-3.5" aria-hidden />
                      {t("laterReports")}:{" "}
                      {c.duplicates.map((d) => d.refCode).join(", ")}
                    </p>
                  )}
                </Card>
              )}

              {/* ── 5. Location (real stored location; no fallbacks) ───── */}
              <Card className="cs-fade-up p-4 sm:p-5">
                <SectionHeading title={t("location")} />
                {c.lat != null && c.lng != null ? (
                  <MapPanel complaints={[{
                    id: c.id,
                    refCode: c.refCode,
                    title: c.title,
                    lat: c.lat,
                    lng: c.lng,
                    category: c.category,
                    severity: c.severity,
                    status: c.status,
                    source: c.source,
                  }]} zoom={15} height="260px" />
                ) : (
                  <div className="rounded-xl border border-dashed border-cs-border bg-cs-surface/50 px-4 py-3 text-sm text-cs-secondary">
                    <MapPin className="mr-1.5 inline h-4 w-4 text-cs-faint" aria-hidden />
                    {t("locationMissing")}
                  </div>
                )}
                {(c.address || c.ward || (c.lat != null && c.lng != null)) && (
                  <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2.5 text-sm sm:grid-cols-3">
                    {c.address && <Item label={t("address")} value={c.address} />}
                    {c.ward && <Item label={t("ward")} value={c.ward} />}
                    {c.lat != null && c.lng != null && (
                      <Item label={t("coordinates")} value={`${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`} />
                    )}
                    {c.accuracyMeters != null && (
                      <Item label={t("accuracy")} value={`±${Math.round(c.accuracyMeters)} m`} />
                    )}
                    {c.locationSource && <Item label={t("gpsSource")} value={c.locationSource} />}
                  </dl>
                )}
              </Card>

              {/* ── 6. Department / assignment (citizen-safe view) ─────── */}
              <Card className="cs-fade-up p-4 sm:p-5">
                <SectionHeading title={t("deptAssignment")} />
                {c.department ? (
                  <div className="flex items-center gap-2.5">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-indigo-400/30 bg-indigo-500/10 text-indigo-300">
                      <Building2 className="h-4 w-4" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-cs-text">{c.department.name}</p>
                      <p className="font-mono text-[10px] uppercase tracking-wide text-cs-faint">{c.department.code}</p>
                    </div>
                  </div>
                ) : (
                  <p className="flex items-center gap-2 text-sm text-cs-secondary">
                    <Route className="h-4 w-4 text-cs-faint" aria-hidden />
                    {t("routingPending")}
                  </p>
                )}
                <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2.5 text-sm sm:grid-cols-3">
                  <div className="min-w-0">
                    <dt className="text-[10px] font-semibold uppercase tracking-[0.08em] text-cs-secondary">
                      <User className="mr-1 inline h-3 w-3" aria-hidden />{t("assigned")}
                    </dt>
                    <dd className="truncate font-medium text-cs-text" title={c.assignedTo?.name ?? t("unassigned")}>
                      {c.assignedTo?.name ?? t("unassigned")}
                    </dd>
                  </div>
                  {c.activeAssignment && (
                    <div className="min-w-0">
                      <dt className="text-[10px] font-semibold uppercase tracking-[0.08em] text-cs-secondary">{t("assignmentState")}</dt>
                      <dd className="truncate font-medium text-cs-text">{t(assignmentStateKey(c.activeAssignment.status))}</dd>
                    </div>
                  )}
                  {c.startedAt && (
                    <div className="min-w-0">
                      <dt className="text-[10px] font-semibold uppercase tracking-[0.08em] text-cs-secondary">{t("startedOn")}</dt>
                      <dd className="truncate font-medium text-cs-text tnum">{fmtDateTime(c.startedAt)}</dd>
                    </div>
                  )}
                </dl>
                {c.activeAssignment?.mode && (
                  <p className="mt-2 text-xs text-cs-faint">
                    {c.activeAssignment.mode === "AUTO" ? t("routedAuto") : t("routedManual")}
                  </p>
                )}
              </Card>

              {/* ── 9. Resolution evidence (before/after, honest state) ── */}
              <Card className="cs-fade-up p-4 sm:p-5">
                <SectionHeading title={t("evidence")} />
                {c.resolutionUrl ? (
                  <figure>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={c.resolutionUrl}
                      alt="Worker's resolution photo"
                      className="max-h-80 w-full rounded-xl border border-cs-border object-cover"
                    />
                    <figcaption className="mt-1.5 text-xs text-cs-secondary">After — worker&apos;s resolution evidence</figcaption>
                  </figure>
                ) : (
                  <EmptyState title={t("evidenceNone")} icon={<ClipboardList className="h-5 w-5" />} />
                )}
                {c.assignedTo && (c.status === "RESOLVED" || c.status === "CLOSED" || c.resolvedAt) && (
                  <p className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-cs-secondary">
                    <CheckCheck className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
                    <span>{t("assignmentCompleted")} · {c.assignedTo.name}</span>
                    {c.resolvedAt && <span className="tnum">· {fmtDateTime(c.resolvedAt)}</span>}
                  </p>
                )}
              </Card>

              {/* ── 10. Verification (existing semantics, untouched) ───── */}
              {c.verified != null ? (
                <Card className={`cs-fade-up p-4 sm:p-5 ${c.verified ? "border-emerald-400/30 bg-emerald-500/10" : "border-orange-400/30 bg-orange-500/10"}`}>
                  <SectionHeading title={t("verification")} />
                  <h3 className={`text-sm font-semibold ${c.verified ? "text-emerald-300" : "text-orange-300"}`}>
                    {c.verified ? "✓ RESOLUTION VERIFIED by AI" : "↺ RESOLUTION NOT VERIFIED — complaint reopened"}
                  </h3>
                  <p className="mt-1 text-sm text-cs-text">{c.verificationReason}</p>
                  <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-cs-secondary">
                    <span>Confidence: <strong className="text-cs-text tnum">{c.verificationConfidence != null ? `${(c.verificationConfidence * 100).toFixed(0)}%` : "—"}</strong></span>
                    {c.verificationProvider && (
                      <span>AI Provider: <strong className="text-cs-text">{c.verificationProvider}</strong>
                        {c.verificationProvider.startsWith("dev") && <span className="ml-1 text-amber-300">(labeled development provider)</span>}
                      </span>
                    )}
                    {c.verifiedAt && <span className="tnum">at {fmtDateTime(c.verifiedAt)}</span>}
                  </p>
                  {!c.verified && (
                    <p className="mt-1 text-xs text-orange-300/90">
                      The worker&apos;s claim alone cannot close a case — the issue was reopened and, for high-severity or repeated failures, escalated.
                    </p>
                  )}
                </Card>
              ) : (
                <Card className="cs-fade-up p-4 sm:p-5">
                  <SectionHeading title={t("verification")} />
                  <EmptyState title={t("verificationPending")} icon={<ShieldCheck className="h-5 w-5" />} />
                </Card>
              )}

              {/* Escalation history (real escalation records) */}
              {c.escalations.length > 0 && (
                <Card className="cs-fade-up p-4 sm:p-5">
                  <SectionHeading title={t("escalated")} />
                  <ul className="space-y-1.5 text-sm">
                    {c.escalations.map((e) => (
                      <li key={e.id} className="flex flex-wrap gap-2">
                        <span className="cs-badge border-red-400/30 bg-red-500/10 text-red-300">L{e.level}</span>
                        <span className="text-cs-text">{e.reason}</span>
                        <span className="tnum text-xs text-cs-secondary">{fmtDateTime(e.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              {/* ── 11. Full timeline (only real recorded events) ──────── */}
              <Card className="cs-fade-up p-4 sm:p-5">
                <SectionHeading title={t("timeline")} aside={<CalendarClock className="h-4 w-4 text-cs-faint" aria-hidden />} />
                <ol className="relative mt-1 space-y-3 pl-1">
                  <span aria-hidden className="absolute bottom-2 left-[5px] top-2 w-px bg-gradient-to-b from-blue-400/40 via-cs-border to-transparent" />
                  {c.events.map((e) => {
                    const tone = EVENT_TONE[e.type]?.dot ?? "bg-slate-400";
                    return (
                      <li key={e.id} className="relative flex gap-3 pl-1 text-sm">
                        <span aria-hidden className={`z-10 mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full border-2 border-cs-bg ${tone}`} />
                        <div className="min-w-0">
                          <p className="font-medium text-cs-text">{e.title}</p>
                          {e.detail && <p className="text-cs-secondary">{e.detail}</p>}
                          <p className="tnum text-xs text-cs-secondary/80">{fmtDateTime(e.createdAt)} · {e.actor}</p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </Card>
            </div>

            {/* ── Right rail: internal agent activity — STAFF ONLY ─────── */}
            {me?.role === "OFFICIAL" && c.agentActivities.length > 0 && (
              <aside className="lg:col-span-1">
                <AgentActivityPanel activities={c.agentActivities} />
              </aside>
            )}
          </div>
        </div>
      )}
    </AppShell>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.08em] text-cs-secondary">{label}</dt>
      <dd className="truncate font-medium text-cs-text" title={value}>{value}</dd>
    </div>
  );
}
