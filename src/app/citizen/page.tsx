"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import {
  Card,
  MetricCard,
  StatusBadge,
  SeverityBadge,
  CategoryTag,
  DemoBadge,
  Skeleton,
  EmptyState,
  LoginPrompt,
  ErrorNote,
  SectionHeading,
  Spinner,
} from "@/components/ui";
import MapPanel from "@/components/MapPanel";
import { api, fetchMe, fmtAgo, fmtCountdown, homeForRole } from "@/lib/client";
import { useLang } from "@/lib/i18n";
import {
  Bell,
  CheckCheck,
  FileText,
  Flame,
  MapPin,
  Map as MapIcon,
  Camera,
  AlignLeft,
  Route,
  Building2,
  ArrowRight,
} from "lucide-react";

type Row = {
  id: string; refCode: string; reporterId: string; title: string; category: string; severity: string; status: string;
  createdAt: string; slaDueAt: string | null; isOverdue: boolean; source: string;
  priority?: number; escalationCount?: number;
  lat: number | null; lng: number | null;
  address?: string | null; ward?: string | null;
  department?: { code: string; name: string } | null;
  assignedTo?: { id: string; name: string } | null;
};

type Notification = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  complaintId: string | null;
  readAt: string | null;
  createdAt: string;
};

const MAX_UPDATES = 4;
const INACTIVE_STATUSES = ["RESOLVED", "CLOSED"];
const MOVING_STATUSES = ["IN_PROGRESS", "VERIFICATION"];

/** Citizen notification types we can render confidently (guard for future types). */
function updateIcon(type: string) {
  switch (type) {
    case "RESOLVED":
    case "VERIFIED":
      return { Icon: CheckCheck, tone: "text-emerald-300", bg: "bg-emerald-500/10 border-emerald-400/30" };
    case "SLA_BREACH":
    case "ESCALATION":
      return { Icon: Flame, tone: "text-red-300", bg: "bg-red-500/10 border-red-400/30" };
    case "SLA_WARNING":
      return { Icon: Bell, tone: "text-amber-300", bg: "bg-amber-500/10 border-amber-400/30" };
    default:
      return { Icon: Bell, tone: "text-blue-300", bg: "bg-blue-500/10 border-blue-400/30" };
  }
}

export default function CitizenHomePage() {
  const [me, setMe] = useState<{ name: string; karma: number } | null | undefined>(undefined);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [filter, setFilter] = useState<"all" | "active">("all");
  const [error, setError] = useState("");
  const [notifications, setNotifications] = useState<Notification[] | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [markingRead, setMarkingRead] = useState(false);
  const [notice, setNotice] = useState(""); // one-shot success notice after a deletion
  const loadOnce = useRef(false);
  const { t } = useLang();

  useEffect(() => {
    if (loadOnce.current) return;
    loadOnce.current = true;
    // One-shot success notice handed over by the detail page after deletion.
    // Read outside the synchronous effect body (queueMicrotask, as IntroSplash
    // does) so the banner state never triggers a cascading render on mount.
    queueMicrotask(() => {
      try {
        const deletedRef = sessionStorage.getItem("cs_report_deleted");
        if (deletedRef) {
          setNotice(deletedRef);
          sessionStorage.removeItem("cs_report_deleted");
        }
      } catch {
        // Storage unavailable — the notice is cosmetic, never blocking.
      }
    });
    fetchMe().then((u) => {
      if (!u) { setMe(null); return; }
      if (u.role !== "CITIZEN") {
        window.location.href = homeForRole(u.role);
        return;
      }
      api<{ complaints: Row[] }>("/api/complaints?scope=mine")
        .then((d) => setRows(d.complaints))
        .catch((e) => setError((e as Error).message));
      api<{ user: { name: string; karma?: number } }>("/api/auth/me")
        .then((d) => setMe({ name: d.user.name, karma: d.user.karma ?? 0 }))
        .catch(() => setMe({ name: u.name, karma: 0 }));
      api<{ notifications: Notification[]; unreadCount: number }>("/api/notifications?limit=20")
        .then((d) => {
          setNotifications(d.notifications);
          setUnreadCount(d.unreadCount);
        })
        .catch(() => setNotifications([]));
    });
  }, []);

  const loadNotifications = useCallback(() => {
    return api<{ notifications: Notification[]; unreadCount: number }>("/api/notifications?limit=20")
      .then((d) => {
        setNotifications(d.notifications);
        setUnreadCount(d.unreadCount);
      })
      .catch(() => undefined);
  }, []);

  // Refresh the updates feed when the tab becomes visible again.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") loadNotifications();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadNotifications]);

  async function markAllRead() {
    setMarkingRead(true);
    const now = new Date().toISOString();
    setNotifications((n) => n?.map((x) => ({ ...x, readAt: x.readAt ?? now })) ?? null);
    setUnreadCount(0);
    try {
      await api("/api/notifications", { method: "POST", body: { all: true } });
    } catch {
      // Reconcile with the server if the optimistic update was wrong.
      loadNotifications();
    }
    setMarkingRead(false);
  }

  const active = (rows ?? []).filter((r) => !INACTIVE_STATUSES.includes(r.status)).length;
  const resolved = (rows ?? []).filter((r) => INACTIVE_STATUSES.includes(r.status)).length;
  const inProgress = (rows ?? []).filter((r) => MOVING_STATUSES.includes(r.status)).length;
  const filtered = rows?.filter((r) => (filter === "active" ? !INACTIVE_STATUSES.includes(r.status) : true)) ?? [];
  const departments = useMemo(() => {
    const counts = new Map<string, { code: string; name: string; count: number }>();
    for (const r of rows ?? []) {
      if (!r.department || INACTIVE_STATUSES.includes(r.status)) continue;
      const cur = counts.get(r.department.code);
      if (cur) cur.count += 1;
      else counts.set(r.department.code, { code: r.department.code, name: r.department.name, count: 1 });
    }
    return Array.from(counts.values()).sort((a, b) => b.count - a.count);
  }, [rows]);
  const plottableCount = rows ? rows.filter((r) => !INACTIVE_STATUSES.includes(r.status)).length : 0;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? t("greetMorning") : hour < 17 ? t("greetAfternoon") : t("greetEvening");

  if (me === null) {
    return <AppShell>{error ? <ErrorNote message={error} /> : <LoginPrompt />}</AppShell>;
  }
  if (me === undefined) {
    return (
      <AppShell>
        <div className="mx-auto max-w-7xl space-y-4">
          <Skeleton className="h-9 w-64" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}
          </div>
          <Skeleton className="h-32" />
        </div>
      </AppShell>
    );
  }

  const recentUpdates = notifications?.slice(0, MAX_UPDATES) ?? null;

  return (
    <AppShell>
      {notice && (
        <p role="status" className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3.5 py-2.5 text-sm text-emerald-200">
          {t("reportDeleted")} <span className="font-mono font-semibold">{notice}</span>
        </p>
      )}
      <div className="mx-auto max-w-7xl space-y-6">
        {/* ── Welcome / hero ─────────────────────────────────────────── */}
        <section className="cs-card cs-fade-up relative overflow-hidden p-5 sm:p-7">
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(600px 220px at 88% -20%, rgba(59,130,246,0.14), transparent 65%), radial-gradient(400px 200px at 0% 120%, rgba(79,70,229,0.10), transparent 60%)",
            }}
            aria-hidden
          />
          <div className="relative flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-cs-secondary">CivicShield · Citizen</div>
              <h1 className="font-display mt-1 text-2xl font-semibold tracking-tight text-cs-text sm:text-3xl">
                {greeting}, {me.name.split(" ")[0]}
              </h1>
              <p className="mt-1.5 max-w-2xl text-sm text-cs-secondary">{t("citizenHeroSub")}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Link href="/citizen/submit" className="cs-btn cs-btn-primary">
                <FileText className="h-4 w-4" aria-hidden />
                {t("reportIssue")}
              </Link>
              <a href="#my-reports" className="cs-btn cs-btn-secondary">
                {t("viewAllReports")}
              </a>
            </div>
          </div>
        </section>

        {/* ── Personal metrics (derived from the citizen's own records) ── */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard label={t("activeReports")} value={rows ? active : "…"} tone="text-blue-300" icon={<FileText className="h-4 w-4" />} />
          <MetricCard label={t("inProgressReports")} value={rows ? inProgress : "…"} tone="text-indigo-300" icon={<Route className="h-4 w-4" />} />
          <MetricCard label={t("resolvedReports")} value={rows ? resolved : "…"} tone="text-emerald-300" icon={<CheckCheck className="h-4 w-4" />} />
          <MetricCard
            label="Karma"
            value={me.karma}
            tone="text-violet-300"
            hint={me.karma > 0 ? t("karmaHint") : undefined}
            icon={<Flame className="h-4 w-4" />}
          />
        </div>

        {/* ── New report intake preview (entry point to the real flow) ── */}
        <Link href="/citizen/submit" className="block rounded-[20px] focus-visible:outline-2">
          <Card hover className="cs-fade-up p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="grid h-8 w-8 place-items-center rounded-lg border border-blue-400/30 bg-blue-500/10 text-blue-300">
                    <FileText className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="font-display text-base font-semibold tracking-tight text-cs-text">{t("newReport")}</span>
                </div>
                <p className="mt-1.5 max-w-xl text-sm text-cs-secondary">{t("newReportHint")}</p>
              </div>
              <ol className="hidden items-center gap-2 text-xs text-cs-secondary sm:flex" aria-hidden>
                <li className="flex items-center gap-1.5"><Camera className="h-3.5 w-3.5 text-cs-faint" />{t("stepPhoto")}</li>
                <li aria-hidden>→</li>
                <li className="flex items-center gap-1.5"><AlignLeft className="h-3.5 w-3.5 text-cs-faint" />{t("stepDescribe")}</li>
                <li aria-hidden>→</li>
                <li className="flex items-center gap-1.5"><Route className="h-3.5 w-3.5 text-cs-faint" />{t("stepAiRoute")}</li>
              </ol>
              <span className="cs-btn cs-btn-secondary px-3! py-1.5! text-xs!">
                {t("reportIssue")} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </span>
            </div>
          </Card>
        </Link>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* ── My active reports (summary-level only) ──────────────── */}
          <section id="my-reports" className="scroll-mt-20 lg:col-span-2">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <SectionHeading title={t("myComplaints")} />
              <div className="flex items-center gap-1" role="group" aria-label={t("myComplaints")}>
                {(["all", "active"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    aria-pressed={filter === f}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                      filter === f ? "bg-blue-500/15 font-semibold text-blue-300" : "text-cs-secondary hover:bg-white/5 hover:text-cs-text"
                    }`}
                  >
                    {f === "all" ? t("filterAll") : t("filterActive")}
                  </button>
                ))}
              </div>
            </div>

            {error && <ErrorNote message={error} />}
            {rows === null && !error ? (
              <div className="space-y-3">{[0, 1].map((i) => <Skeleton key={i} className="h-28" />)}</div>
            ) : null}
            {rows && rows.length === 0 && (
              <EmptyState
                title={t("noReportsTitle")}
                hint={t("noReportsHint")}
                action={<Link href="/citizen/submit" className="cs-btn cs-btn-primary">{t("reportIssue")}</Link>}
              />
            )}
            {rows && rows.length > 0 && filtered.length === 0 && (
              <EmptyState title={t("updatesEmptyTitle")} hint={t("filterActive")} />
            )}

            <div className="space-y-3">
              {filtered.map((c) => (
                <Link key={c.id} href={`/complaints/${c.id}`} className="block">
                  <Card hover className="cs-fade-up p-4 sm:p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <CategoryTag category={c.category} />
                          <SeverityBadge severity={c.severity} />
                          <StatusBadge status={c.status} pulse={MOVING_STATUSES.includes(c.status)} />
                          {c.source === "DEMO" && <DemoBadge />}
                          {c.isOverdue && (
                            <span className="cs-badge border-red-400/40 bg-red-500/15 text-red-300">{t("overdue")}</span>
                          )}
                        </div>
                        <p className="mt-2 font-medium text-cs-text">{c.title}</p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-cs-secondary">
                          <span className="font-mono">{c.refCode}</span>
                          <span aria-hidden>·</span>
                          <span>{fmtAgo(c.createdAt)}</span>
                          {(c.ward || c.address) && (
                            <>
                              <span aria-hidden>·</span>
                              <span className="inline-flex min-w-0 items-center gap-1">
                                <MapPin className="h-3 w-3 shrink-0 text-cs-faint" aria-hidden />
                                <span className="truncate">{c.ward ?? c.address}</span>
                              </span>
                            </>
                          )}
                          {c.department && (<><span aria-hidden>·</span><span>{c.department.name}</span></>)}
                          {c.assignedTo && (<><span aria-hidden>·</span><span>{c.assignedTo.name}</span></>)}
                          {(c.escalationCount ?? 0) > 0 && (
                            <><span aria-hidden>·</span><span className="text-amber-300">{t("escalated")} ×{c.escalationCount}</span></>
                          )}
                          {c.slaDueAt && !c.isOverdue && !INACTIVE_STATUSES.includes(c.status) && (
                            <><span aria-hidden>·</span><span className="text-amber-300">{t("sla")} {fmtCountdown(c.slaDueAt)}</span></>
                          )}
                        </div>
                      </div>
                      <span className="cs-btn cs-btn-secondary hidden shrink-0 px-3! py-1.5! text-xs! sm:inline-flex">
                        {t("viewReport")}
                      </span>
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          </section>

          {/* ── Right rail: updates + department activity ───────────── */}
          <div className="space-y-6">
            <section aria-live="polite">
              <div className="mb-3 flex items-center justify-between gap-2">
                <SectionHeading title={t("updates")} />
                {unreadCount > 0 && (
                  <button
                    type="button"
                    onClick={markAllRead}
                    disabled={markingRead}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-cs-secondary transition hover:bg-white/5 hover:text-cs-text disabled:opacity-55"
                  >
                    {markingRead ? <Spinner className="h-3 w-3" /> : <CheckCheck className="h-3.5 w-3.5" aria-hidden />}
                    {t("markAllRead")}
                  </button>
                )}
              </div>
              <Card className="p-3">
                <div className="mb-2 flex items-center justify-between px-1 text-xs text-cs-secondary">
                  <span className="inline-flex items-center gap-1.5">
                    <Bell className="h-3.5 w-3.5" aria-hidden />
                    {t("notifications")}
                    {unreadCount > 0 && (
                      <span className="rounded-full border border-blue-400/30 bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold tnum text-blue-300">
                        {unreadCount}
                      </span>
                    )}
                  </span>
                </div>
                {notifications === null ? (
                  <div className="space-y-2 p-1">{[0, 1].map((i) => <Skeleton key={i} className="h-12" />)}</div>
                ) : recentUpdates!.length === 0 ? (
                  <div className="px-1 pb-1 pt-2">
                    <EmptyState title={t("updatesEmptyTitle")} hint={t("updatesEmptyHint")} icon={<Bell className="h-5 w-5" />} />
                  </div>
                ) : (
                  <ul className="space-y-1.5">
                    {recentUpdates!.map((n) => {
                      const { Icon, tone, bg } = updateIcon(n.type);
                      const inner = (
                        <Card className={`border p-2.5 ${n.readAt ? "opacity-70" : ""} ${n.complaintId ? "transition hover:border-blue-400/40" : ""}`}>
                          <div className="flex items-start gap-2.5">
                            <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg border ${bg} ${tone}`}>
                              <Icon className="h-3.5 w-3.5" aria-hidden />
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-[13px] font-medium text-cs-text">{n.title}</span>
                              {n.body && <span className="mt-0.5 block text-xs leading-snug text-cs-secondary">{n.body}</span>}
                              <span className="mt-1 block text-[11px] text-cs-faint tnum">{fmtAgo(n.createdAt)}</span>
                            </span>
                            {!n.readAt && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-blue-400 cs-pulse-dot" aria-label={t("notifications")} />}
                          </div>
                        </Card>
                      );
                      return (
                        <li key={n.id}>
                          {n.complaintId ? (
                            <Link href={`/complaints/${n.complaintId}`} className="block">{inner}</Link>
                          ) : (
                            inner
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            </section>

            <section>
              <SectionHeading title={t("deptActivity")} hint={t("deptActivityHint")} />
              <Card className="p-3">
                {rows === null ? (
                  <div className="space-y-2 p-1">{[0, 1].map((i) => <Skeleton key={i} className="h-10" />)}</div>
                ) : departments.length === 0 ? (
                  <div className="px-1 pb-1 pt-2">
                    <EmptyState title={t("deptEmpty")} icon={<Building2 className="h-5 w-5" />} />
                  </div>
                ) : (
                  <ul className="space-y-1">
                    {departments.map((d) => (
                      <li key={d.code} className="flex items-center justify-between gap-2 rounded-lg px-2 py-2 transition hover:bg-white/5">
                        <span className="flex min-w-0 items-center gap-2.5">
                          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-cs-border bg-cs-elevated text-blue-300">
                            <Building2 className="h-3.5 w-3.5" aria-hidden />
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-[13px] font-medium text-cs-text">{d.name}</span>
                            <span className="block font-mono text-[10px] uppercase tracking-wide text-cs-faint">{d.code}</span>
                          </span>
                        </span>
                        <span className="cs-badge shrink-0 border-indigo-400/30 bg-indigo-500/10 tnum text-indigo-300">
                          {d.count} {d.count === 1 ? "report" : "reports"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </section>
          </div>
        </div>

        {/* ── Community map (existing CivicMap, real coordinates only) ── */}
        <section>
          <SectionHeading title={t("communityMap")} hint={t("mapHint")} aside={
            <span className="inline-flex items-center gap-1.5 tnum">
              <MapIcon className="h-3.5 w-3.5 text-cs-faint" aria-hidden />
              {rows ? `${plottableCount} ${plottableCount === 1 ? "report" : "reports"}` : "…"}
            </span>
          } />
          <Card className="overflow-hidden p-2 sm:p-3">
            {rows === null ? (
              <Skeleton className="h-[380px] w-full rounded-2xl" />
            ) : rows.length === 0 ? (
              <div className="px-2 py-6">
                <EmptyState title={t("mapEmpty")} icon={<MapIcon className="h-5 w-5" />} />
              </div>
            ) : (
              <MapPanel complaints={rows} height="380px" />
            )}
          </Card>
        </section>
      </div>
    </AppShell>
  );
}
