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
  DemoBadge,
  Skeleton,
  LoginPrompt,
  ErrorNote,
  SectionHeading,
  Button,
  Input,
  Modal,
  Select,
} from "@/components/ui";
import { AgentActivityPanel, type Activity } from "@/components/AgentActivityPanel";
import MapPanel from "@/components/MapPanel";
import { api, fetchMe, fmtAgo, fmtCountdown, homeForRole, type SessionUser } from "@/lib/client";
import { useLang } from "@/lib/i18n";
import { severityTone } from "@/components/ui";
import { CATEGORIES, STATUSES, DEPARTMENT_CODES, categoryLabels, statusLabels, severityLabels, departmentLabel } from "@/lib/constants";
import { CheckCheck, Clock, Flame, Map as MapIcon, RefreshCw, Search, ShieldCheck, Timer, Users } from "lucide-react";

type Row = {
  id: string; refCode: string; title: string; category: string; severity: string; priority: number;
  status: string; lat: number | null; lng: number | null; address: string | null; createdAt: string; slaDueAt: string | null;
  isOverdue: boolean; escalationCount: number; source: string;
  department: { code: string; name: string } | null;
  assignedTo: { id: string; name: string } | null;
};
type Stats = {
  totals: { total: number; open: number; inProgress: number; verification: number; resolved: number; escalated: number; overdue: number; reopened: number };
  byDepartment?: Array<{ department: string; count: number }>;
};
type Worker = {
  id: string; name: string; departmentId: string | null;
  profile: { departmentName: string; designation: string | null; availability: string; skills: string[] } | null;
};

export default function OfficialDashboard() {
  const [me, setMe] = useState<SessionUser | null | undefined>(undefined);
  const [stats, setStats] = useState<Stats | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState({ status: "", category: "", severity: "", department: "" });
  const [search, setSearch] = useState("");
  const [assigning, setAssigning] = useState<Row | null>(null);
  const [slaDemo, setSlaDemo] = useState<Row | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [actionError, setActionError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [overrideTarget, setOverrideTarget] = useState<Row | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [closeTarget, setCloseTarget] = useState<Row | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overrideWorkerId, setOverrideWorkerId] = useState("");
  const { t } = useLang();
  const [actionInfo, setActionInfo] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
      const [s, list, act] = await Promise.all([
        api<Stats>("/api/stats"),
        api<{ complaints: Row[] }>(`/api/complaints?scope=all&${qs}`),
        api<{ activities: Activity[] }>("/api/activity?limit=30"),
      ]);
      setStats(s);
      setRows(list.complaints);
      setActivities(act.activities);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [filters]);

  useEffect(() => {
    fetchMe().then((u) => {
      if (!u) { setMe(null); return; }
      if (u.role !== "OFFICIAL") { window.location.href = homeForRole(u.role); return; }
      setMe(u);
      load();
      fetch("/api/health/ai").then((r) => r.json()).then((d) => setDemoMode(Boolean(d.demoMode))).catch(() => {});
      api<{ users: Worker[] }>("/api/official/workers").then((d) => setWorkers(d.users)).catch(() => {});
    });
  }, [load]);

  const mapRows = useMemo(
    () =>
      (rows ?? []).map((r) => ({
        id: r.id, refCode: r.refCode, title: r.title, lat: r.lat, lng: r.lng,
        category: r.category, severity: r.severity, status: r.status, source: r.source,
      })),
    [rows]
  );

  const deptLoad = useMemo(() => {
    const map = new Map<string, number>((stats?.byDepartment ?? []).map((d) => [d.department, d.count]));
    return DEPARTMENT_CODES.map((code) => ({ code, count: map.get(code) ?? 0 })).filter((d) => d.count > 0);
  }, [stats]);
  const maxDept = Math.max(1, ...deptLoad.map((d) => d.count));

  const selected = rows?.find((r) => r.id === selectedId) ?? null;

  if (me === null) return <AppShell><LoginPrompt /></AppShell>;

  async function assign(workerId: string) {
    if (!assigning) return;
    setActionError("");
    try {
      await api(`/api/complaints/${assigning.id}/assign`, { body: { workerId } });
      setAssigning(null);
      setActionInfo(t("assignOk"));
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  async function escalateRow(row: Row) {
    setActionError("");
    try {
      await api(`/api/complaints/${row.id}/escalate`, { body: { reason: "Manual escalation by official from dashboard" } });
      setActionInfo(t("escalateOk"));
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  /** POST /api/complaints/[id]/auto-assign — no body; engine outcome surfaced verbatim. */
  async function autoAssign(row: Row) {
    setBusyId(row.id);
    setActionError("");
    setActionInfo("");
    try {
      const res = await api<{ kind: string; employeeId?: string }>(`/api/complaints/${row.id}/auto-assign`, { body: {} });
      if (res.kind === "ASSIGNED") setActionInfo(`${t("autoAssignedOk")}${res.employeeId ? ` (${res.employeeId})` : ""}`);
      else if (res.kind === "ALREADY_ASSIGNED") setActionInfo(t("autoAssignedAlready"));
      else if (res.kind === "NO_ELIGIBLE_WORKER") setActionInfo(t("noEligibleNote"));
      else setActionInfo(t("autoAssignedNotAssignable"));
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  /** POST /api/complaints/[id]/override — { workerId, reason (3–500 chars, server-validated) }. */
  async function applyOverride() {
    if (!overrideTarget) return;
    if (overrideReason.trim().length < 3) {
      setActionError(t("overrideReasonShort"));
      return;
    }
    setOverrideBusy(true);
    setActionError("");
    try {
      await api(`/api/complaints/${overrideTarget.id}/override`, { body: { workerId: overrideWorkerId, reason: overrideReason.trim() } });
      setOverrideTarget(null);
      setOverrideReason("");
      setActionInfo(t("overrideOk"));
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setOverrideBusy(false);
    }
  }

  /** POST /api/complaints/[id]/close — no body; backend enforces RESOLVED-only. */
  async function closeCase() {
    if (!closeTarget) return;
    setCloseBusy(true);
    setActionError("");
    try {
      await api(`/api/complaints/${closeTarget.id}/close`, { body: {} });
      setCloseTarget(null);
      setActionInfo(t("closeOk"));
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setCloseBusy(false);
    }
  }

  async function demoSla(row: Row, mode: "warning" | "breach") {
    setActionError("");
    try {
      await api("/api/demo/sla", { body: { complaintId: row.id, mode } });
      setSlaDemo(null);
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  const totals = stats?.totals;
  const queue = (rows ?? []).filter((r) => !["RESOLVED", "CLOSED"].includes(r.status));
  const openOverride = overrideTarget !== null;
  const openClose = closeTarget !== null;

  // Real client-side reference/title narrowing of the already-fetched queue —
  // the list API supports filters only (no text-search param), so this never
  // replaces server filtering; it just speeds up scanning of loaded rows.
  const needle = search.trim().toLowerCase();
  const filteredRows = rows?.filter((r) =>
    needle ? r.refCode.toLowerCase().includes(needle) || r.title.toLowerCase().includes(needle) : true
  );
  const filteredQueue = queue.filter((r) =>
    needle ? r.refCode.toLowerCase().includes(needle) || r.title.toLowerCase().includes(needle) : true
  );

  return (
    <AppShell>
      <div className="space-y-5">
        <div className="cs-fade-up flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-cs-text sm:text-[28px]">{t("cmdTitle")}</h1>
            <p className="mt-1 max-w-2xl text-sm text-cs-secondary">{t("cmdSub")}</p>
          </div>
          <Button variant="secondary" size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={load}>
            {t("refresh")}
          </Button>
        </div>

        <div aria-live="polite">
          {error && <ErrorNote message={error} />}
          {actionInfo && <ErrorNote message={actionInfo} />}
          {actionError && <ErrorNote message={actionError} />}
        </div>

        {/* ── Operational metrics — real database values ───────────────── */}
        {totals ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
            <MetricCard label={t("statTotal")} value={totals.total} icon={<MapIcon className="h-4 w-4" />} />
            <MetricCard label={t("statActive")} value={totals.open} tone="text-blue-300" />
            <MetricCard label={t("inProgressReports")} value={totals.inProgress} tone="text-indigo-300" />
            <MetricCard label={t("statVerification")} value={totals.verification} tone="text-amber-300" />
            <MetricCard label={t("resolvedReports")} value={totals.resolved} tone="text-emerald-300" />
            <MetricCard label={t("statOverdue")} value={totals.overdue} tone="text-red-300" />
            <MetricCard label={t("slaEscalated")} value={totals.escalated} tone="text-red-300" />
            <MetricCard label={t("reopen")} value={totals.reopened} tone="text-orange-300" />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <Skeleton key={i} className="h-24" />)}
          </div>
        )}

        {/* ── Risk map + priority queue ────────────────────────────────── */}
        <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
          <Card className="overflow-hidden p-0">
            <div className="flex items-center justify-between px-4 py-3">
              <h2 className="font-display text-sm font-semibold text-cs-text">{t("riskMap")}</h2>
              <span className="text-[11px] text-cs-secondary tnum">{mapRows.length} {t("plottedCount")}</span>
            </div>
            <MapPanel complaints={mapRows} height="420px" />
          </Card>

          <Card className="flex max-h-[540px] flex-col overflow-hidden p-0">
            <div className="border-b border-cs-border px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-display text-sm font-semibold text-cs-text">{t("priorityQueue")}</h2>
                <span className="cs-badge border-amber-400/30 bg-amber-500/10 tnum text-amber-300">{queue.length}</span>
              </div>
              <p className="mt-0.5 text-[11px] text-cs-secondary">{t("queueHint")}</p>
              <div className="relative mt-2">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cs-faint" aria-hidden />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("searchCases")}
                  aria-label={t("searchCases")}
                  className="cs-input py-1.5 pl-8! text-xs"
                />
              </div>
            </div>
            <div className="cs-scroll-x min-h-0 flex-1 overflow-y-auto p-3">
              {rows === null ? (
                <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}</div>
              ) : filteredQueue.length === 0 ? (
                <p className="px-2 py-8 text-center text-sm text-cs-secondary">
                  {queue.length === 0 ? t("noOpenCases") : t("updatesEmptyTitle")}
                </p>
              ) : (
                <ul className="space-y-2">
                  {filteredQueue.slice(0, 12).map((r) => (
                    <li key={r.id}>
                      <Link href={`/complaints/${r.id}`}
                        className={`block rounded-xl border p-3 transition hover:border-blue-400/40 hover:bg-blue-500/5 ${severityTone[r.severity] ?? ""}`}>
                        <div className="flex items-center gap-2">
                          <span className={`h-2 w-2 shrink-0 rounded-full ${
                            r.severity === "CRITICAL" ? "bg-red-400" : r.severity === "HIGH" ? "bg-orange-400" : r.severity === "MEDIUM" ? "bg-amber-400" : "bg-slate-400"
                          }`} aria-hidden />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-cs-text">{r.title}</span>
                          <span className="tnum shrink-0 text-xs font-semibold text-cs-secondary">P{r.priority}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-cs-secondary">
                          <span className="font-mono">{r.refCode}</span>
                          <span>· {r.department?.code ?? "—"}</span>
                          <span>· {r.isOverdue ? <span className="font-semibold text-red-300">{t("overdue")}</span> : r.slaDueAt ? <span className="tnum">{fmtCountdown(r.slaDueAt)}</span> : "no SLA"}</span>
                          {r.assignedTo && <span>· {r.assignedTo.name}</span>}
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>

        {/* ── Department workload + filters ────────────────────────────── */}
        <div className="grid gap-4 lg:grid-cols-[1fr_2fr]">
          {deptLoad.length > 0 && (
            <Card className="p-4">
              <SectionHeading title={t("deptActivity")} hint={t("deptActivityHint")} />
              <ul className="space-y-2">
                {deptLoad.map((d) => (
                  <li key={d.code} className="text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-medium text-cs-text">{d.code}</span>
                      <span className="tnum text-cs-secondary">{d.count}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cs-elevated" role="presentation">
                      <div className="h-full rounded-full bg-indigo-400/80" style={{ width: `${Math.round((d.count / maxDept) * 100)}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card className="flex flex-wrap items-end gap-3 p-4">
            <div className="w-full sm:w-auto">
              <label className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-cs-secondary">
                <Search className="h-3 w-3" aria-hidden />{t("searchCases")}
              </label>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("searchCases")}
                aria-label={t("searchCases")}
                className="cs-input w-full py-2 text-sm sm:w-64"
              />
            </div>
            <Select
              label={t("status")}
              value={filters.status}
              onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
              options={[{ value: "", label: t("filterAll") }, ...STATUSES.map((s) => ({ value: s, label: statusLabels[s] }))]}
              className="w-full sm:w-auto"
            />
            <Select
              label={t("category")}
              value={filters.category}
              onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))}
              options={[{ value: "", label: t("filterAll") }, ...CATEGORIES.map((c) => ({ value: c, label: categoryLabels[c] }))]}
              className="w-full sm:w-auto"
            />
            <Select
              label={t("severity")}
              value={filters.severity}
              onChange={(e) => setFilters((f) => ({ ...f, severity: e.target.value }))}
              options={[{ value: "", label: t("filterAll") }, ...(["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const).map((s) => ({ value: s, label: severityLabels[s] }))]}
              className="w-full sm:w-auto"
            />
            <Select
              label={t("department")}
              value={filters.department}
              onChange={(e) => setFilters((f) => ({ ...f, department: e.target.value }))}
              options={[{ value: "", label: t("filterAll") }, ...DEPARTMENT_CODES.map((d) => ({ value: d, label: departmentLabel(d) }))]}
              className="w-full sm:w-auto"
            />
          </Card>
        </div>

        {/* ── Queue table ──────────────────────────────────────────────── */}
        <Card className="p-0">
          <div className="cs-scroll-x">
            <table className="w-full min-w-[960px] text-sm">
              <thead>
                <tr className="border-b border-cs-border text-left text-[11px] uppercase tracking-[0.08em] text-cs-secondary">
                  <th scope="col" className="px-4 py-3">ID</th>
                  <th scope="col" className="px-4 py-3">{t("issue")}</th>
                  <th scope="col" className="px-4 py-3">{t("severity")}</th>
                  <th scope="col" className="px-4 py-3">{t("priority")}</th>
                  <th scope="col" className="px-4 py-3">{t("location")}</th>
                  <th scope="col" className="px-4 py-3">{t("department")}</th>
                  <th scope="col" className="px-4 py-3">{t("status")}</th>
                  <th scope="col" className="px-4 py-3">{t("sla")}</th>
                  <th scope="col" className="px-4 py-3">{t("created")}</th>
                  <th scope="col" className="px-4 py-3 text-right">{t("actions")}</th>
                </tr>
              </thead>
              <tbody>
                {rows === null && (
                  <tr><td colSpan={10} className="px-4 py-10"><div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8" />)}</div></td></tr>
                )}
                {rows?.length === 0 && (
                  <tr><td colSpan={10} className="px-4 py-10 text-center text-cs-secondary">{t("updatesEmptyTitle")}</td></tr>
                )}
                {filteredRows?.map((r) => (
                  <tr key={r.id} className="border-b border-cs-border/60 align-top transition hover:bg-blue-500/[0.04]">
                    <td className="px-4 py-3 font-mono text-xs text-cs-secondary">
                      {r.refCode} {r.source === "DEMO" && <DemoBadge />}
                    </td>
                    <td className="max-w-56 px-4 py-3">
                      <Link href={`/complaints/${r.id}`} className="font-medium text-blue-300 hover:underline">{r.title}</Link>
                      <div className="mt-0.5"><CategoryTag category={r.category} /></div>
                    </td>
                    <td className="px-4 py-3"><SeverityBadge severity={r.severity} /></td>
                    <td className="px-4 py-3 font-semibold tnum">{r.priority}</td>
                    <td className="max-w-40 px-4 py-3 text-cs-secondary">{
                      r.address ?? (r.lat != null && r.lng != null ? `${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}` : "—")
                    }</td>
                    <td className="px-4 py-3 text-cs-secondary">{r.department?.code ?? "—"}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={r.status} pulse={r.status === "VERIFICATION"} />
                      {r.assignedTo && <div className="mt-0.5 text-[11px] text-cs-secondary">{r.assignedTo.name}</div>}
                      {r.escalationCount > 0 && <div className="mt-0.5 text-[11px] font-medium text-red-300">esc. L{r.escalationCount}</div>}
                    </td>
                    <td className="px-4 py-3">
                      {r.isOverdue
                        ? <span className="font-semibold text-red-300">{t("overdue")}</span>
                        : r.slaDueAt
                          ? <span className="tnum text-cs-secondary">{fmtCountdown(r.slaDueAt)}</span>
                          : "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-cs-secondary tnum">{fmtAgo(r.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col items-end gap-1">
                        <Button variant="secondary" size="sm" onClick={() => { setSelectedId(r.id); setActionError(""); }}>
                          {t("selectCase")}
                        </Button>
                        {(!r.assignedTo || ["REOPENED", "ESCALATED"].includes(r.status)) && (
                          <Button size="sm" onClick={() => setAssigning(r)}>{t("assignAction")}</Button>
                        )}
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<Users className="h-3.5 w-3.5" />}
                          onClick={() => autoAssign(r)}
                          disabled={busyId === r.id}
                        >
                          {t("autoAssignAction")}
                        </Button>
                        {!(["RESOLVED", "CLOSED"].includes(r.status)) && (
                          <Button variant="danger" size="sm" onClick={() => escalateRow(r)}>{t("escalateAction")}</Button>
                        )}
                        {demoMode && !(["RESOLVED", "CLOSED"].includes(r.status)) && (
                          <Button
                            variant="secondary"
                            size="sm"
                            icon={<Timer className="h-3.5 w-3.5" />}
                            onClick={() => setSlaDemo(r)}
                            title="DEMO MODE: simulate the SLA clock for judging"
                            className="!border-amber-400/35 !bg-amber-500/10 !text-amber-300"
                          >
                            {t("demoSlaLabel")}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* ── Agent activity (officials are authorized) ────────────────── */}
        <AgentActivityPanel activities={activities} title="AI Agent Activity — latest decisions" />
      </div>

      {/* ── Case control — operational actions on the selected complaint ── */}
      <Card className="p-4 sm:p-5">
        <SectionHeading title={t("caseControl")} hint={t("caseControlHint")} />
        {selected ? (
          <div className="mt-3 grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-cs-secondary">{selected.refCode}</span>
                <StatusBadge status={selected.status} pulse={selected.status === "VERIFICATION"} />
                <SeverityBadge severity={selected.severity} />
                <CategoryTag category={selected.category} />
              </div>
              <p className="mt-2 font-medium text-cs-text">{selected.title}</p>
              <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-cs-secondary">{t("assigned")}</div>
                  <div className="truncate font-medium text-cs-text" title={selected.assignedTo?.name ?? t("unassigned")}>
                    {selected.assignedTo?.name ?? t("unassigned")}
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-cs-secondary">{t("slaStatus")}</div>
                  <div className={`font-medium ${selected.isOverdue ? "text-red-300" : "text-cs-text"}`}>
                    {selected.isOverdue ? t("slaBreached") : selected.slaDueAt ? <span className="tnum">{fmtCountdown(selected.slaDueAt)}</span> : "—"}
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-cs-secondary">{t("priority")}</div>
                  <div className="tnum font-medium text-cs-text">{selected.priority}</div>
                </div>
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-cs-secondary">{t("created")}</div>
                  <div className="tnum font-medium text-cs-text">{fmtAgo(selected.createdAt)}</div>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {(!selected.assignedTo || ["REOPENED", "ESCALATED"].includes(selected.status)) && (
                  <Button icon={<Users className="h-4 w-4" />} onClick={() => setAssigning(selected)}>{t("assignGo")}</Button>
                )}
                <Button
                  variant="secondary"
                  icon={<Users className="h-4 w-4" />}
                  onClick={() => autoAssign(selected)}
                  disabled={busyId === selected.id || ["RESOLVED", "CLOSED"].includes(selected.status)}
                >
                  {t("autoAssignAction")}
                </Button>
                <Button
                  variant="secondary"
                  icon={<ShieldCheck className="h-4 w-4" />}
                  onClick={() => { setOverrideTarget(selected); setOverrideReason(""); setOverrideWorkerId(""); setActionError(""); }}
                  disabled={["RESOLVED", "CLOSED"].includes(selected.status)}
                >
                  {t("overrideAction")}
                </Button>
                {!(["RESOLVED", "CLOSED"].includes(selected.status)) && (
                  <Button variant="danger" icon={<Flame className="h-4 w-4" />} onClick={() => escalateRow(selected)}>{t("escalateAction")}</Button>
                )}
                {selected.status === "RESOLVED" && (
                  <Button variant="secondary" icon={<CheckCheck className="h-4 w-4" />} onClick={() => { setCloseTarget(selected); setActionError(""); }}>
                    {t("closeAction")}
                  </Button>
                )}
              </div>
            </div>
            <div className="rounded-xl border border-cs-border bg-cs-surface/50 p-3.5 text-xs text-cs-faint">
              <p className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                {t("adminNote")}
              </p>
            </div>
          </div>
        ) : (
          <p className="mt-2 text-sm text-cs-secondary">{t("selectCaseHint")}</p>
        )}
      </Card>

      {/* ── DEMO SLA simulation (shared Modal, labeled dev control) ────── */}
      <Modal open={slaDemo !== null} onClose={() => setSlaDemo(null)} title={t("demoSlaTitle")}>
        {slaDemo && (
          <>
            <span className="cs-badge border-amber-400/30 bg-amber-500/10 text-amber-300">{t("demoModeLabel")}</span>
            <p className="mt-3 text-sm font-medium text-cs-text">
              <span className="font-mono">{slaDemo.refCode}</span> · {slaDemo.title}
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-cs-secondary">{t("demoSlaBody")}</p>
            <div className="mt-4 grid gap-2">
              <Button
                variant="secondary"
                icon={<Clock className="h-4 w-4" />}
                onClick={() => demoSla(slaDemo, "warning")}
                className="!justify-start !border-amber-400/35 !bg-amber-500/10 !text-amber-200"
              >
                {t("simulateWarning")}
              </Button>
              <Button variant="danger" icon={<Timer className="h-4 w-4" />} onClick={() => demoSla(slaDemo, "breach")} className="!justify-start">
                {t("simulateBreach")}
              </Button>
            </div>
            <div className="mt-4 flex justify-end">
              <Button variant="secondary" size="sm" onClick={() => setSlaDemo(null)}>{t("cancel")}</Button>
            </div>
          </>
        )}
      </Modal>

      {/* ── Manual assignment (existing /assign contract) ──────────────── */}
      <Modal open={assigning !== null} onClose={() => setAssigning(null)} title={`${t("assignWorker")} — ${assigning?.refCode ?? ""}`}>
        {assigning && (
          <>
            <p className="text-sm text-cs-secondary">{assigning.title}</p>
            <p className="mt-0.5 text-xs text-cs-faint">{t("chooseWorker")}</p>
            <div className="mt-4 max-h-72 space-y-2 overflow-y-auto pr-1">
              {workers.map((w) => (
                <button key={w.id} onClick={() => assign(w.id)}
                  className="flex w-full items-center justify-between gap-3 rounded-xl border border-cs-border bg-cs-bg/40 px-3 py-2.5 text-left text-sm transition hover:border-blue-400/50 hover:bg-blue-500/5">
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-cs-text">{w.name}</span>
                    {w.profile && (
                      <span className="block truncate text-xs text-cs-secondary">
                        {w.profile.departmentName}{w.profile.designation ? ` · ${w.profile.designation}` : ""}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-cs-faint">
                    {w.profile ? w.profile.availability.toLowerCase() : w.departmentId ? t("deptWorkerLabel") : t("unassignedDeptLabel")}
                  </span>
                </button>
              ))}
              {workers.length === 0 && <p className="text-sm text-cs-secondary">{t("noWorkers")}</p>}
            </div>
            <div className="mt-4 flex justify-end">
              <Button variant="secondary" size="sm" onClick={() => setAssigning(null)}>{t("cancel")}</Button>
            </div>
          </>
        )}
      </Modal>

      {/* ── Official override (audited administrative action) ───────────── */}
      <Modal open={openOverride} onClose={() => setOverrideTarget(null)} title={t("overrideTitle")}>
        {overrideTarget && (
          <>
            <span className="cs-badge border-violet-400/30 bg-violet-500/10 text-violet-300">{t("adminActions")}</span>
            <p className="mt-3 text-sm font-medium text-cs-text">
              <span className="font-mono">{overrideTarget.refCode}</span> · {overrideTarget.title}
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-cs-secondary">{t("overrideBody")}</p>
            <div className="mt-4">
              <Select
                label={t("assignWorker")}
                value={overrideWorkerId}
                onChange={(e) => setOverrideWorkerId(e.target.value)}
                options={workers.map((w) => ({
                  value: w.id,
                  label: w.profile ? `${w.name} — ${w.profile.departmentName}${w.profile.designation ? ` · ${w.profile.designation}` : ""}` : w.name,
                }))}
                className="w-full"
              />
            </div>
            <div className="mt-3">
              <Input
                label={t("overrideReason")}
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                maxLength={500}
                className="w-full"
              />
            </div>
            {actionError && <div className="mt-3"><ErrorNote message={actionError} /></div>}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={() => setOverrideTarget(null)}>{t("cancel")}</Button>
              <Button
                icon={<ShieldCheck className="h-4 w-4" />}
                onClick={applyOverride}
                disabled={overrideBusy || overrideWorkerId === "" || overrideReason.trim().length < 3}
              >
                {t("overrideConfirm")}
              </Button>
            </div>
          </>
        )}
      </Modal>

      {/* ── Close case (backend enforces RESOLVED-only) ─────────────────── */}
      <Modal open={openClose} onClose={() => setCloseTarget(null)} title={t("closeTitle")}>
        {closeTarget && (
          <>
            <p className="text-sm font-medium text-cs-text">
              <span className="font-mono">{closeTarget.refCode}</span> · {closeTarget.title}
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-cs-secondary">{t("closeBody")}</p>
            {actionError && <div className="mt-3"><ErrorNote message={actionError} /></div>}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={() => setCloseTarget(null)}>{t("cancel")}</Button>
              <Button variant="secondary" icon={<CheckCheck className="h-4 w-4" />} onClick={closeCase} disabled={closeBusy}>
                {t("closeConfirm")}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </AppShell>
  );
}
