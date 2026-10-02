"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import {
  Card,
  MetricCard,
  StatusBadge,
  SeverityBadge,
  CategoryTag,
  Skeleton,
  LoginPrompt,
  ErrorNote,
  EmptyState,
  SectionHeading,
  Button,
  Modal,
} from "@/components/ui";
import MapPanel from "@/components/MapPanel";
import { api, fetchMe, fmtDateTime, fmtAgo, fmtCountdown, homeForRole, type SessionUser } from "@/lib/client";
import { useLang } from "@/lib/i18n";
import {
  ArrowRight,
  Bell,
  CheckCheck,
  CircleAlert,
  FileText,
  HardHat,
  MapPin,
  Redo2,
  ShieldCheck,
  Upload,
  Wrench,
} from "lucide-react";

/** Exact GET /api/worker/assignments row (verified against assignmentDomain.listMyAssignments). */
type AssignmentRow = {
  id: string;
  status: "OFFERED" | "ACCEPTED" | "IN_PROGRESS" | "COMPLETED" | "REJECTED" | string;
  mode: string;
  reason: string | null;
  respondedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  complaint: {
    id: string; refCode: string; title: string; description: string; category: string;
    severity: string; status: string; ward: string | null;
    lat: number; lng: number; address: string | null;
    slaDueAt: string | null; createdAt: string;
  };
};

const DONE_COMPLAINT = ["RESOLVED", "CLOSED"];
/** SLA warning threshold for the derived time-left chip (display only). */
const SLA_WARNING_FRACTION = 0.75;

function isDone(a: AssignmentRow) {
  return a.status === "COMPLETED" || DONE_COMPLAINT.includes(a.complaint.status);
}

function isOverdue(a: AssignmentRow) {
  return a.complaint.slaDueAt != null && new Date(a.complaint.slaDueAt).getTime() <= Date.now() && !isDone(a);
}

/** Display-only SLA chip derived from real timestamps — never a stored state. */
function slaChip(a: AssignmentRow) {
  const due = a.complaint.slaDueAt;
  if (!due || isDone(a)) return null;
  if (isOverdue(a)) return { text: "SLA breached", tone: "text-red-300" };
  const windowMs = new Date(due).getTime() - new Date(a.complaint.createdAt).getTime();
  const warning = windowMs > 0 && Date.now() - new Date(a.complaint.createdAt).getTime() >= windowMs * SLA_WARNING_FRACTION;
  return { text: `SLA ${fmtCountdown(due)}`, tone: warning ? "text-amber-300" : "text-cs-secondary" };
}

function locationText(a: AssignmentRow) {
  const c = a.complaint;
  if (c.ward) return c.ward;
  if (c.address) return c.address;
  if (c.lat != null && c.lng != null) return `${Number(c.lat).toFixed(4)}, ${Number(c.lng).toFixed(4)}`;
  return null;
}

export default function WorkerPage() {
  const [me, setMe] = useState<SessionUser | null | undefined>(undefined);
  const [assignments, setAssignments] = useState<AssignmentRow[] | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionInfo, setActionInfo] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<AssignmentRow | null>(null);
  const [rejectBusy, setRejectBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "warn" } | null>(null);
  const [unread, setUnread] = useState<number | null>(null);
  const [profile, setProfile] = useState<{
    departmentName: string; designation: string | null; employeeId: string; availability: string;
  } | null>(null);
  const { t } = useLang();

  const load = useCallback(async () => {
    try {
      const d = await api<{ assignments: AssignmentRow[] }>("/api/worker/assignments");
      setAssignments(d.assignments);
      setError("");
      return d.assignments;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, []);

  useEffect(() => {
    fetchMe().then((u) => {
      if (!u) { setMe(null); return; }
      if (u.role !== "WORKER") { window.location.href = homeForRole(u.role); return; }
      setMe(u);
      load();
      api<{ unreadCount: number }>("/api/notifications?limit=1")
        .then((d) => setUnread(d.unreadCount))
        .catch(() => setUnread(0));
      api<{ profile: { departmentName: string; designation: string | null; employeeId: string; availability: string } }>("/api/worker/profile")
        .then((d) => setProfile(d.profile))
        .catch(() => setProfile(null));
    });
  }, [load]);

  const offered = useMemo(() => {
    const rows = (assignments ?? []).filter((a) => a.status === "OFFERED");
    return [...rows].sort((x, y) => {
      const dx = x.complaint.slaDueAt ? new Date(x.complaint.slaDueAt).getTime() : Infinity;
      const dy = y.complaint.slaDueAt ? new Date(y.complaint.slaDueAt).getTime() : Infinity;
      return dx - dy;
    });
  }, [assignments]);
  const accepted = useMemo(() => (assignments ?? []).filter((a) => a.status === "ACCEPTED"), [assignments]);
  const inProgress = useMemo(
    () => (assignments ?? []).filter((a) => a.status === "IN_PROGRESS" && !DONE_COMPLAINT.includes(a.complaint.status)),
    [assignments]
  );
  const completed = useMemo(
    () => (assignments ?? []).filter((a) => isDone(a) && a.status !== "REJECTED").slice(0, 4),
    [assignments]
  );
  const active = useMemo(() => [...accepted, ...inProgress], [accepted, inProgress]);
  const activeWithCoords = active.find((a) => a.complaint.lat != null && a.complaint.lng != null);

  async function respond(a: AssignmentRow, action: "accept" | "start" | "reject") {
    setBusyId(a.id);
    setActionError("");
    setActionInfo("");
    try {
      const res = await api<{ status?: string; kind?: string; statusAfter?: string }>(`/api/assignments/${a.id}/respond`, {
        body: { action },
      });
      const rows = await load();
      if (action === "reject") {
        setToast({ msg: t("rejectRecorded"), tone: "ok" });
        const still = rows?.some((r) => r.id === a.id);
        if (still) setToast({ msg: t("noEligibleNote"), tone: "warn" });
      } else if (res?.kind === "NO_ELIGIBLE_WORKER") {
        setActionInfo(t("noEligibleNote"));
      }
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function confirmReject() {
    if (!rejectTarget) return;
    setRejectBusy(true);
    setActionError("");
    try {
      await respond(rejectTarget, "reject");
      setRejectTarget(null);
    } finally {
      setRejectBusy(false);
    }
  }

  if (me === null) return <AppShell><LoginPrompt /></AppShell>;

  const counts = { offered: offered.length, accepted: accepted.length, inProgress: inProgress.length };

  return (
    <AppShell>
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="cs-fade-up mb-1 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-cs-text sm:text-[28px]">{t("workerTitle")}</h1>
            <p className="mt-1 max-w-2xl text-sm text-cs-secondary">{t("workerSub")}</p>
          </div>
          <div className="flex items-center gap-2">
            {unread !== null && unread > 0 && (
              <span
                title={t("notifications")}
                className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-cs-border bg-cs-elevated text-cs-secondary"
              >
                <Bell className="h-4 w-4" aria-hidden />
                <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-blue-500 px-1 text-[10px] font-semibold tnum text-white">
                  {unread}
                </span>
                <span className="sr-only">{t("notifications")}: {unread}</span>
              </span>
            )}
            {profile ? (
              <span
                title={`${profile.employeeId} · ${profile.designation ?? ""} · ${t("availability")}: ${profile.availability}`}
                className="inline-flex items-center gap-2 rounded-lg border border-cs-border bg-cs-elevated px-3 py-1.5 text-xs text-cs-secondary"
              >
                <HardHat className="h-3.5 w-3.5 text-blue-300" aria-hidden />
                <span className="max-w-44 truncate">
                  <span className="font-medium text-cs-text">{profile.departmentName}</span>
                  {profile.designation ? <span> · {profile.designation}</span> : null}
                </span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-2 rounded-lg border border-cs-border bg-cs-elevated px-3 py-1.5 text-xs text-cs-faint">
                <HardHat className="h-3.5 w-3.5" aria-hidden />
                {t("noProfile")}
              </span>
            )}
          </div>
        </div>

        {/* Screen-reader-friendly action feedback (aria-live) */}
        <div aria-live="polite">
          {toast && (
            <button
              type="button"
              onClick={() => setToast(null)}
              className={`block w-full text-left ${toast.tone === "ok" ? "" : "text-amber-300"}`}
            >
              <ErrorNote message={toast.msg} />
            </button>
          )}
          {actionInfo && <ErrorNote message={actionInfo} />}
          {actionError && <ErrorNote message={actionError} />}
        </div>

        {error && <ErrorNote message={error} />}
        {assignments === null && !error && (
          <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-32" />)}</div>
        )}

        {/* ── Work summary (derived from real assignments) ─────────────── */}
        {assignments !== null && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <MetricCard label={t("offeredTasks")} value={counts.offered} tone="text-amber-300" icon={<CircleAlert className="h-4 w-4" />} />
              <MetricCard label={t("acceptedTasks")} value={counts.accepted} tone="text-blue-300" icon={<FileText className="h-4 w-4" />} />
              <MetricCard label={t("inProgressTasks")} value={counts.inProgress} tone="text-indigo-300" icon={<Wrench className="h-4 w-4" />} />
              <MetricCard label={t("completedTasks")} value={assignments.filter((a) => isDone(a) && a.status !== "REJECTED").length} tone="text-emerald-300" icon={<CheckCheck className="h-4 w-4" />} />
            </div>

            {assignments.length === 0 && (
              <EmptyState
                title={t("assignmentsEmpty")}
                hint={t("assignmentsEmptyHint")}
                icon={<Wrench className="h-5 w-5" />}
              />
            )}

            {/* ── Assignment offers (OFFERED) ─────────────────────────── */}
            {offered.length > 0 && (
              <section aria-label={t("openOffers")}>
                <SectionHeading title={t("openOffers")} aside={<span className="cs-badge border-amber-400/30 bg-amber-500/10 text-amber-300">{t("offeredPulse")}</span>} />
                <div className="space-y-3">
                  {offered.map((a) => {
                    const sla = slaChip(a);
                    const loc = locationText(a);
                    return (
                      <Card key={a.id} hover className="cs-fade-up border-l-2 border-l-amber-400/60 p-4 sm:p-5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="cs-badge border-amber-400/30 bg-amber-500/10 text-amber-300">{t("offeredLabel")}</span>
                          <span className="font-mono text-xs text-cs-secondary">{a.complaint.refCode}</span>
                          <CategoryTag category={a.complaint.category} />
                          <SeverityBadge severity={a.complaint.severity} />
                          {isOverdue(a) && <span className="cs-badge border-red-400/40 bg-red-500/15 text-red-300">{t("overdue")}</span>}
                        </div>
                        <Link href={`/complaints/${a.complaint.id}`} className="mt-2 block font-medium text-blue-300 hover:underline">
                          {a.complaint.title}
                        </Link>
                        <p className="mt-1 line-clamp-2 text-sm text-cs-secondary">{a.complaint.description}</p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-cs-secondary">
                          {loc && (
                            <span className="inline-flex items-center gap-1">
                              <MapPin className="h-3 w-3 text-cs-faint" aria-hidden />{loc}
                            </span>
                          )}
                          <span aria-hidden>·</span>
                          <span>{t("offeredAt")} {fmtAgo(a.createdAt)}</span>
                          {sla && <span aria-hidden>·</span>}
                          {sla && <span className={`tnum ${sla.tone}`}>{sla.text}</span>}
                          {a.mode === "AUTO" && (
                            <><span aria-hidden>·</span><span>{t("routedAuto")}</span></>
                          )}
                        </div>
                        <div className="mt-3.5 flex flex-wrap gap-2">
                          <Button variant="primary" size="sm" icon={<CheckCheck className="h-3.5 w-3.5" />} onClick={() => respond(a, "accept")} disabled={busyId === a.id}>
                            {t("acceptTask")}
                          </Button>
                          <Button variant="danger" size="sm" icon={<Redo2 className="h-3.5 w-3.5" />} onClick={() => setRejectTarget(a)} disabled={busyId === a.id}>
                            {t("rejectTask")}
                          </Button>
                          <Link href={`/complaints/${a.complaint.id}`} className="cs-btn cs-btn-secondary px-3! py-1.5! text-xs!">
                            {t("viewCase")}
                          </Link>
                        </div>
                      </Card>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ── Active work (ACCEPTED / IN_PROGRESS) ────────────────── */}
            <section aria-label={t("activeWork")}>
              <SectionHeading title={t("activeWork")} hint={assignments.length > 0 ? `${assignments.length} ${t("totalAssigned")}` : undefined} />
              {assignments !== null && active.length === 0 && (
                <Card className="px-6 py-8 text-center text-sm text-cs-secondary">
                  {offered.length > 0 ? t("offeredPulse") : t("assignmentsEmpty")}
                </Card>
              )}
              <div className="space-y-3">
                {active.map((a) => {
                  const sla = slaChip(a);
                  const loc = locationText(a);
                  const c = a.complaint;
                  return (
                    <Card key={a.id} hover className="cs-fade-up p-4 sm:p-5">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge status={a.status === "IN_PROGRESS" ? "IN_PROGRESS" : "ASSIGNED"} pulse={a.status === "IN_PROGRESS"} />
                        <span className="font-mono text-xs text-cs-secondary">{c.refCode}</span>
                        <CategoryTag category={c.category} />
                        <SeverityBadge severity={c.severity} />
                        {isOverdue(a) && <span className="cs-badge border-red-400/40 bg-red-500/15 text-red-300">{t("overdue")}</span>}
                        {c.status === "REOPENED" && (
                          <span className="cs-badge border-orange-400/40 bg-orange-500/15 text-orange-300">{t("reopen")}</span>
                        )}
                      </div>
                      <Link href={`/complaints/${c.id}`} className="mt-2 block font-medium text-blue-300 hover:underline">{c.title}</Link>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-cs-secondary">
                        {loc && (
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="h-3 w-3 text-cs-faint" aria-hidden />{loc}
                          </span>
                        )}
                        {a.startedAt && (
                          <><span aria-hidden>·</span><span className="tnum">{t("startedOn")} {fmtDateTime(a.startedAt)}</span></>
                        )}
                        {sla && <span aria-hidden>·</span>}
                        {sla && <span className={`tnum ${sla.tone}`}>{sla.text}</span>}
                      </div>
                      <div className="mt-3.5 flex flex-wrap gap-2">
                        {a.status === "ACCEPTED" && (
                          <Button variant="primary" size="sm" icon={<Wrench className="h-3.5 w-3.5" />} onClick={() => respond(a, "start")} disabled={busyId === a.id}>
                            {t("startWork")}
                          </Button>
                        )}
                        {(a.status === "IN_PROGRESS" || c.status === "REOPENED") && (
                          <Link href={`/worker/resolve/${c.id}`} className="cs-btn cs-btn-success px-3! py-1.5! text-xs!">
                            <Upload className="h-3.5 w-3.5" aria-hidden />
                            {t("uploadEvidence")}
                            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                          </Link>
                        )}
                        {c.status === "VERIFICATION" && (
                          <span className="cs-badge border-amber-400/30 bg-amber-500/10 text-amber-300">
                            <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                            {t("verifying")}
                          </span>
                        )}
                        <Link href={`/complaints/${c.id}`} className="cs-btn cs-btn-secondary px-3! py-1.5! text-xs!">
                          {t("viewCase")}
                        </Link>
                      </div>
                    </Card>
                  );
                })}
              </div>

              {/* ── On-site map: first active assignment with real coords ─ */}
              {active.length > 0 && (
                <div className="mt-4">
                  <SectionHeading title={t("onSiteMap")} />
                  <Card className="overflow-hidden p-2 sm:p-3">
                    {activeWithCoords ? (
                      <MapPanel
                        complaints={[{
                          id: activeWithCoords.complaint.id,
                          refCode: activeWithCoords.complaint.refCode,
                          title: activeWithCoords.complaint.title,
                          lat: activeWithCoords.complaint.lat,
                          lng: activeWithCoords.complaint.lng,
                          category: activeWithCoords.complaint.category,
                          severity: activeWithCoords.complaint.severity,
                          status: activeWithCoords.complaint.status,
                          source: "CITIZEN",
                        }]}
                        zoom={15}
                        height="300px"
                      />
                    ) : (
                      <div className="px-2 py-6">
                        <EmptyState title={t("locationMissing")} icon={<MapPin className="h-5 w-5" />} />
                      </div>
                    )}
                  </Card>
                </div>
              )}
            </section>

            {/* ── Completed work (summary only) ────────────────────────── */}
            {completed.length > 0 && (
              <section aria-label={t("completedWork")}>
                <SectionHeading title={t("completedWork")} />
                <div className="space-y-2">
                  {completed.map((a) => (
                    <Card key={a.id} className="cs-fade-up p-3.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs text-cs-secondary">{a.complaint.refCode}</span>
                            <StatusBadge status={a.complaint.status} />
                          </div>
                          <Link href={`/complaints/${a.complaint.id}`} className="mt-1 block truncate text-sm font-medium text-blue-300 hover:underline">
                            {a.complaint.title}
                          </Link>
                        </div>
                        <div className="text-right text-xs text-cs-secondary">
                          {a.completedAt && (
                            <span className="block tnum">
                              <CheckCheck className="mr-1 inline h-3 w-3 text-emerald-400" aria-hidden />
                              {t("completedOn")} {fmtDateTime(a.completedAt)}
                            </span>
                          )}
                          <Link href={`/complaints/${a.complaint.id}`} className="text-cs-secondary hover:text-cs-text hover:underline">
                            {t("viewCase")}
                          </Link>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      {/* ── Rejection confirmation (real endpoint; no reason field exists) ─ */}
      <Modal open={rejectTarget !== null} onClose={() => setRejectTarget(null)} title={t("rejectTitle")}>
        {rejectTarget && (
          <>
            <p className="text-sm leading-relaxed text-cs-secondary">
              <span className="font-mono text-cs-text">{rejectTarget.complaint.refCode}</span> · {rejectTarget.complaint.title}
            </p>
            <p className="mt-2 text-sm text-cs-secondary">{t("rejectBody")}</p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={() => setRejectTarget(null)}>{t("cancel")}</Button>
              <Button variant="danger" icon={<Redo2 className="h-4 w-4" />} onClick={confirmReject} disabled={rejectBusy}>
                {t("confirmReject")}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </AppShell>
  );
}
