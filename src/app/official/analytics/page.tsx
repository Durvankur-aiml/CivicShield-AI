"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { Card, MetricCard, Skeleton, LoginPrompt, ErrorNote, SectionHeading, Button, Select } from "@/components/ui";
import { api, fetchMe, fmtDateTime, homeForRole, type SessionUser } from "@/lib/client";
import { useLang } from "@/lib/i18n";
import {
  ArrowLeft,
  Minus,
  RefreshCw,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

/* ── Verified response contracts (src/lib/analytics/*) ──────────────── */

type Metric<T> = { value: T | null; sampleSize: number; status: "OK" | "NO_DATA" | "INSUFFICIENT_DATA"; unit?: string };
type Envelope = { window: { from: string; to: string; preset: string }; generatedAt: string };
type GroupCount = { key: string; count: number };
type Trend = {
  metric: string; current: number; previous: number; change: number | null; changePct: number | null;
  direction: "UP" | "DOWN" | "FLAT" | "INSUFFICIENT_DATA"; status: "OK" | "NO_DATA" | "INSUFFICIENT_DATA"; note: string;
};
type Overview = {
  envelope: Envelope;
  complaints: {
    totals: { total: Metric<number>; byStatus: Metric<GroupCount[]>; byCategory: Metric<GroupCount[]>; byDepartment: Metric<GroupCount[]> };
    series: { bucket: string; points: Array<{ bucketStart: string; count: number }> };
  };
  resolution: {
    resolved: Metric<number>; unresolved: Metric<number>; reopened: Metric<number>;
    resolutionRate: Metric<number>; avgResolutionTime: Metric<number>; medianResolutionTime: Metric<number>;
  };
  sla: {
    distribution: { onTrack: Metric<number>; warning: Metric<number>; breached: Metric<number>; escalated: Metric<number>; resolved: Metric<number> };
    complianceRate: Metric<number>; avgTimeToAssignment: Metric<number>; avgTimeToAcceptance: Metric<number>; avgTimeToCompletion: Metric<number>;
  };
  assignments: {
    totals: { offered: Metric<number>; accepted: Metric<number>; completed: Metric<number>; rejected: Metric<number>; cancelled: Metric<number>; reassigned: Metric<number> };
    modes: { auto: Metric<number>; manual: Metric<number>; override: Metric<number> };
    rejectionDrivenReassignments: Metric<number>; noEligibleWorkerCases: Metric<number>;
    acceptanceRate: Metric<number>; overrideRate: Metric<number>;
    distance: { avgMeters: Metric<number>; medianMeters: Metric<number>; sampleSize: number };
  };
  verification: {
    byResult: Metric<GroupCount[]>; neverVerified: Metric<number>;
    verificationRate: Metric<number>; successRate: Metric<number>; availabilityRate: Metric<number>;
    avgConfidenceByProvider: Array<{ provider: string; avgConfidence: number | null; sampleSize: number }>;
  };
  location: {
    withCoordinates: Metric<number>; withoutCoordinates: Metric<number>; coordinateCoverage: Metric<number>;
    accuracy: { good: Metric<number>; degraded: Metric<number>; poor: Metric<number>; unknown: Metric<number> };
    bySource: Metric<GroupCount[]>;
  };
  trends: { currentWindow: { from: string; to: string }; previousWindow: { from: string; to: string }; trends: Trend[] };
};
type DeptRow = {
  code: string; name: string; complaintVolume: number; openWorkload: number; resolvedInWindow: number;
  resolutionRate: Metric<number>; slaBreached: number; slaCompliance: Metric<number>; avgResolutionHours: Metric<number>;
  assignmentsInWindow: number; acceptedInWindow: number; acceptanceRate: Metric<number>; reassignmentsInWindow: number;
  volumeSeries: Array<{ bucketStart: string; count: number }>;
};
type WorkerRow = {
  userId: string; employeeId: string | null; name: string; department: string | null; availability: string;
  maxActiveAssignments: number; currentActive: number; completedInWindow: number; rejectedInWindow: number;
  reassignmentsInvolving: number; avgCompletionHours: Metric<number>;
};
type RecurringIssue = { scope: string; key: string; category: string; department: string | null; count: number };
type Hotspot = {
  centerLat: number; centerLng: number; count: number; dominantCategory: string;
  dominantSeverity: string; department: string | null; severityDistribution: Record<string, number>;
};

const WINDOWS = ["24h", "7d", "30d", "90d"] as const;
type WindowPreset = (typeof WINDOWS)[number];

/** Faithful metric rendering: OK → value, NO_DATA/INSUFFICIENT_DATA → honest labels. */
function MetricValue({
  m, t, fmt,
}: {
  m: Metric<number> | undefined;
  t: (k: string) => string;
  fmt?: (v: number) => string;
}) {
  if (!m || m.status === "NO_DATA") return <span className="text-cs-faint">{t("noData")}</span>;
  if (m.status === "INSUFFICIENT_DATA") return <span className="text-cs-faint">{t("insufficientData")}</span>;
  return <span className="tnum">{fmt && typeof m.value === "number" ? fmt(m.value) : String(m.value)}</span>;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const hours = (v: number) => `${v.toFixed(1)} h`;
const meters = (v: number) => `${Math.round(v).toLocaleString()} m`;

export default function AnalyticsPage() {
  const [me, setMe] = useState<SessionUser | null | undefined>(undefined);
  const [win, setWin] = useState<WindowPreset>("30d");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [departments, setDepartments] = useState<DeptRow[] | null>(null);
  const [workers, setWorkers] = useState<WorkerRow[] | null>(null);
  const [hotspots, setHotspots] = useState<Hotspot[] | null>(null);
  const [hotspotNote, setHotspotNote] = useState("");
  const [recurring, setRecurring] = useState<{
    minCategoryCount: number; minAreaCount: number;
    byCategory: RecurringIssue[]; byCategoryDepartment: RecurringIssue[]; byArea: RecurringIssue[]; note: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const { t } = useLang();

  const load = useCallback(async (w: WindowPreset) => {
    setLoading(true);
    setError("");
    try {
      const qs = `window=${w}`;
      // One parallel batch across the five endpoint groups (each official-guarded).
      const [ov, dep, wrk, hot, rec] = await Promise.all([
        api<Overview>(`/api/official/analytics/overview?${qs}`),
        api<{ departments: DeptRow[] }>(`/api/official/analytics/departments?${qs}`),
        api<{ workers: WorkerRow[]; summary: { activeWorkers: Metric<number>; totalWorkload: Metric<number> } }>(`/api/official/analytics/workers?${qs}`),
        api<{ hotspots: Hotspot[]; note: string }>(`/api/official/analytics/hotspots?${qs}`),
        api<{ minCategoryCount: number; minAreaCount: number; byCategory: RecurringIssue[]; byCategoryDepartment: RecurringIssue[]; byArea: RecurringIssue[]; note: string }>(`/api/official/analytics/categories?${qs}`),
      ]);
      setOverview(ov);
      setDepartments(dep.departments);
      setWorkers(wrk.workers);
      setHotspots(hot.hotspots);
      setHotspotNote(hot.note);
      setRecurring(rec);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMe().then((u) => {
      if (!u) { setMe(null); return; }
      if (u.role !== "OFFICIAL") { window.location.href = homeForRole(u.role); return; }
      setMe(u);
      load("30d");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (me === null) return <AppShell><LoginPrompt /></AppShell>;
  if (me === undefined) {
    return (
      <AppShell>
        <div className="mx-auto max-w-6xl space-y-4">
          <Skeleton className="h-10 w-72" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-24" />)}</div>
          <Skeleton className="h-64" />
        </div>
      </AppShell>
    );
  }

  const o = overview;
  const winLabel = win === "24h" ? t("win24h") : win === "7d" ? t("win7d") : win === "30d" ? t("win30d") : t("win90d");

  const trendIcon = (d: Trend["direction"]) =>
    d === "UP" ? TrendingUp : d === "DOWN" ? TrendingDown : Minus;

  return (
    <AppShell>
      <div className="mx-auto max-w-6xl space-y-6">
        {/* ── Header ─────────────────────────────────────────────────── */}
        <div className="cs-fade-up flex flex-wrap items-end justify-between gap-3">
          <div>
            <Link href="/official" className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium text-cs-secondary transition hover:text-cs-text">
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
              {t("backToCommand")}
            </Link>
            <h1 className="font-display mt-2 text-2xl font-semibold tracking-tight text-cs-text sm:text-[28px]">{t("civicIntel")}</h1>
            <p className="mt-1 max-w-2xl text-sm text-cs-secondary">{t("civicIntelSub")}</p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Select
              label={t("windowLabel")}
              value={win}
              onChange={(e) => { const w = e.target.value as WindowPreset; setWin(w); load(w); }}
              options={WINDOWS.map((w) => ({ value: w, label: w === "24h" ? t("win24h") : w === "7d" ? t("win7d") : w === "30d" ? t("win30d") : t("win90d") }))}
              className="w-40"
            />
            <Button variant="secondary" size="sm" icon={<RefreshCw className={`h-3.5 w-3.5 ${loading ? "cs-spin-loading" : ""}`} />} onClick={() => load(win)}>
              {t("refresh")}
            </Button>
          </div>
        </div>

        <div aria-live="polite">
          {error && <ErrorNote message={error} />}
        </div>

        {loading && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-24" />)}</div>
            <Skeleton className="h-56" />
            <Skeleton className="h-40" />
          </div>
        )}

        {!loading && !error && !o && (
          <Card className="p-10 text-center text-sm text-cs-secondary">{t("noData")}</Card>
        )}

        {!loading && o && (
          <>
            {/* ── Overview metric cards (all real MetricResults) ─────── */}
            <section>
              <SectionHeading title={t("secOverview")} hint={`${t("generatedAt")} ${fmtDateTime(o.envelope.generatedAt)} · ${winLabel}`} />
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
                <MetricCard label={t("mComplaints")} value={<MetricValue m={o.complaints.totals.total} t={t} />} />
                <MetricCard label={t("mResolutionRate")} value={<MetricValue m={o.resolution.resolutionRate} t={t} fmt={pct} />} />
                <MetricCard label={t("mSlaCompliance")} value={<MetricValue m={o.sla.complianceRate} t={t} fmt={pct} />} />
                <MetricCard label={t("mAcceptanceRate")} value={<MetricValue m={o.assignments.acceptanceRate} t={t} fmt={pct} />} />
                <MetricCard label={t("mVerifSuccess")} value={<MetricValue m={o.verification.successRate} t={t} fmt={pct} />} />
                <MetricCard label={t("mCoordCoverage")} value={<MetricValue m={o.location.coordinateCoverage} t={t} fmt={pct} />} />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
                <MetricCard label={t("mAvgResolution")} value={<MetricValue m={o.resolution.avgResolutionTime} t={t} fmt={hours} />} />
                <MetricCard label={t("mTimeToAssign")} value={<MetricValue m={o.sla.avgTimeToAssignment} t={t} fmt={hours} />} />
                <MetricCard label={t("mTimeToAccept")} value={<MetricValue m={o.sla.avgTimeToAcceptance} t={t} fmt={hours} />} />
                <MetricCard label={t("mTimeToComplete")} value={<MetricValue m={o.sla.avgTimeToCompletion} t={t} fmt={hours} />} />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
                <MetricCard label={t("mOverrideRate")} value={<MetricValue m={o.assignments.overrideRate} t={t} fmt={pct} />} />
                <MetricCard label={t("mDistanceAvg")} value={<MetricValue m={o.assignments.distance.avgMeters} t={t} fmt={meters} />} />
                <MetricCard label={t("mDistanceMedian")} value={<MetricValue m={o.assignments.distance.medianMeters} t={t} fmt={meters} />} />
                <MetricCard label={t("mRejectionDriven")} value={<MetricValue m={o.assignments.rejectionDrivenReassignments} t={t} />} />
              </div>
            </section>

            {/* ── Volume by day (CSS bars + sr-only table) ────────────── */}
            <section>
              <SectionHeading title={t("secVolume")} />
              <Card className="p-4">
                {o.complaints.series.points.length === 0 ? (
                  <p className="py-8 text-center text-sm text-cs-faint">{t("noData")}</p>
                ) : (
                  <>
                    <div className="flex h-28 items-end gap-1" role="img" aria-label={t("secVolume")}>
                      {o.complaints.series.points.map((p) => {
                        const max = Math.max(...o.complaints.series.points.map((x) => x.count));
                        return (
                          <div
                            key={p.bucketStart}
                            title={`${p.bucketStart.slice(0, 10)} — ${p.count}`}
                            className="cs-bar-in min-w-1 flex-1 rounded-t bg-blue-500/60 transition hover:bg-blue-400"
                            style={{ height: `${Math.max(4, Math.round((p.count / max) * 100))}%` }}
                          />
                        );
                      })}
                    </div>
                    <table className="sr-only">
                      <caption>{t("secVolume")}</caption>
                      <tbody>
                        {o.complaints.series.points.map((p) => (
                          <tr key={p.bucketStart}>
                            <td>{p.bucketStart.slice(0, 10)}</td>
                            <td>{p.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-2 text-[11px] text-cs-faint tnum">
                      {o.complaints.series.points.length} {o.complaints.series.bucket} · {t("vsPrevious")}
                    </p>
                  </>
                )}
              </Card>
            </section>

            {/* ── Trends (descriptive deltas, honest states) ──────────── */}
            <section>
              <SectionHeading title={t("secTrends")} hint={t("vsPrevious")} />
              <Card className="p-0">
                <ul className="divide-y divide-cs-border/60">
                  {o.trends.trends.map((tr) => {
                    const Icon = trendIcon(tr.direction);
                    return (
                      <li key={tr.metric} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                        <span className="font-mono text-xs text-cs-secondary">{tr.metric}</span>
                        {tr.direction === "INSUFFICIENT_DATA" ? (
                          <span className="cs-badge border-amber-400/30 bg-amber-500/10 text-amber-300">{t("trendInsufficient")}</span>
                        ) : (
                          <span className={`inline-flex items-center gap-1 text-xs font-semibold ${tr.direction === "UP" ? "text-blue-300" : tr.direction === "DOWN" ? "text-emerald-300" : "text-cs-secondary"}`}>
                            <Icon className="h-3.5 w-3.5" aria-hidden />
                            {tr.direction === "UP" ? t("trendUp") : tr.direction === "DOWN" ? t("trendDown") : t("trendFlat")}
                            {tr.changePct != null && <span className="tnum">{tr.changePct > 0 ? "+" : ""}{tr.changePct}%</span>}
                          </span>
                        )}
                        <span className="tnum ml-auto text-xs text-cs-secondary">
                          {tr.current} {t("vsPrevious")} {tr.previous}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </section>

            {/* ── Recurring issues ────────────────────────────────────── */}
            {recurring && (
              <section>
                <SectionHeading title={t("secRecurring")} hint={recurring.note} />
                <div className="grid gap-4 lg:grid-cols-3">
                  {([
                    ["recurringByCategory", recurring.byCategory],
                    ["recurringByDept", recurring.byCategoryDepartment],
                    ["recurringByArea", recurring.byArea],
                  ] as const).map(([label, list]) => (
                    <Card key={label} className="p-4">
                      <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-cs-secondary">{t(label)}</h3>
                      {list.length === 0 ? (
                        <p className="mt-2 text-sm text-cs-faint">{t("noData")}</p>
                      ) : (
                        <ul className="mt-2 space-y-1.5 text-sm">
                          {list.slice(0, 8).map((r) => (
                            <li key={r.key} className="flex items-center justify-between gap-2">
                              <span className="min-w-0 truncate text-cs-text">
                                {r.category}
                                {r.department && <span className="text-cs-faint"> · {r.department}</span>}
                              </span>
                              <span className="cs-badge tnum border-blue-400/30 bg-blue-500/10 text-blue-300">{r.count}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </Card>
                  ))}
                </div>
              </section>
            )}

            {/* ── Departments table ───────────────────────────────────── */}
            {departments && departments.length > 0 && (
              <section>
                <SectionHeading title={t("secDepartments")} />
                <Card className="p-0">
                  <div className="cs-scroll-x">
                    <table className="w-full min-w-[880px] text-sm">
                      <thead>
                        <tr className="border-b border-cs-border text-left text-[11px] uppercase tracking-[0.08em] text-cs-secondary">
                          <th scope="col" className="px-4 py-3">{t("department")}</th>
                          <th scope="col" className="px-4 py-3">{t("thVolume")}</th>
                          <th scope="col" className="px-4 py-3">{t("thOpen")}</th>
                          <th scope="col" className="px-4 py-3">{t("thResolved")}</th>
                          <th scope="col" className="px-4 py-3">{t("thRate")}</th>
                          <th scope="col" className="px-4 py-3">{t("thBreached")}</th>
                          <th scope="col" className="px-4 py-3">{t("thCompliance")}</th>
                          <th scope="col" className="px-4 py-3">{t("thAvgH")}</th>
                          <th scope="col" className="px-4 py-3">{t("thAssignments")}</th>
                          <th scope="col" className="px-4 py-3">{t("thReassigns")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {departments.map((d) => (
                          <tr key={d.code} className="border-b border-cs-border/60">
                            <td className="px-4 py-3">
                              <div className="font-medium text-cs-text">{d.name}</div>
                              <div className="font-mono text-[10px] text-cs-faint">{d.code}</div>
                            </td>
                            <td className="px-4 py-3 tnum">{d.complaintVolume}</td>
                            <td className="px-4 py-3 tnum">{d.openWorkload}</td>
                            <td className="px-4 py-3 tnum">{d.resolvedInWindow}</td>
                            <td className="px-4 py-3"><MetricValue m={d.resolutionRate} t={t} fmt={pct} /></td>
                            <td className="px-4 py-3 tnum">{d.slaBreached}</td>
                            <td className="px-4 py-3"><MetricValue m={d.slaCompliance} t={t} fmt={pct} /></td>
                            <td className="px-4 py-3"><MetricValue m={d.avgResolutionHours} t={t} fmt={hours} /></td>
                            <td className="px-4 py-3 tnum">{d.assignmentsInWindow}</td>
                            <td className="px-4 py-3 tnum">{d.reassignmentsInWindow}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </section>
            )}

            {/* ── Workers table (raw operational data, no ranking) ────── */}
            {workers && workers.length > 0 && (
              <section>
                <SectionHeading title={t("secWorkers")} />
                <Card className="p-0">
                  <div className="cs-scroll-x">
                    <table className="w-full min-w-[880px] text-sm">
                      <thead>
                        <tr className="border-b border-cs-border text-left text-[11px] uppercase tracking-[0.08em] text-cs-secondary">
                          <th scope="col" className="px-4 py-3">{t("thWorker")}</th>
                          <th scope="col" className="px-4 py-3">{t("mEmployeeId")}</th>
                          <th scope="col" className="px-4 py-3">{t("department")}</th>
                          <th scope="col" className="px-4 py-3">{t("availability")}</th>
                          <th scope="col" className="px-4 py-3">{t("mCurrentActive")}/{t("mMaxActive")}</th>
                          <th scope="col" className="px-4 py-3">{t("completedTasks")}</th>
                          <th scope="col" className="px-4 py-3">{t("mRejected")}</th>
                          <th scope="col" className="px-4 py-3">{t("thReassigns")}</th>
                          <th scope="col" className="px-4 py-3">{t("mAvgCompletion")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {workers.map((w) => (
                          <tr key={w.userId} className="border-b border-cs-border/60">
                            <td className="px-4 py-3 font-medium text-cs-text">{w.name}</td>
                            <td className="px-4 py-3 font-mono text-xs text-cs-secondary">{w.employeeId ?? "—"}</td>
                            <td className="px-4 py-3 text-cs-secondary">{w.department ?? "—"}</td>
                            <td className="px-4 py-3 text-cs-secondary">{w.availability.toLowerCase()}</td>
                            <td className="px-4 py-3 tnum">{w.currentActive}/{w.maxActiveAssignments}</td>
                            <td className="px-4 py-3 tnum">{w.completedInWindow}</td>
                            <td className="px-4 py-3 tnum">{w.rejectedInWindow}</td>
                            <td className="px-4 py-3 tnum">{w.reassignmentsInvolving}</td>
                            <td className="px-4 py-3"><MetricValue m={w.avgCompletionHours} t={t} fmt={hours} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </section>
            )}

            {/* ── Hotspots (deterministic grid, honest note) ──────────── */}
            {hotspots !== null && (
              <section>
                <SectionHeading title={t("secHotspots")} hint={hotspotNote} />
                <Card className="p-4">
                  {hotspots.length === 0 ? (
                    <p className="py-6 text-center text-sm text-cs-faint">{t("noData")}</p>
                  ) : (
                    <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {hotspots.map((h) => (
                        <li key={`${h.centerLat}:${h.centerLng}`} className="rounded-xl border border-cs-border bg-cs-surface/50 p-3">
                          <div className="flex items-center justify-between gap-2">
                            <span className="cs-badge tnum border-red-400/30 bg-red-500/10 text-red-300">{h.count}</span>
                            <span className="font-mono text-[10px] text-cs-faint tnum">
                              {h.centerLat.toFixed(4)}, {h.centerLng.toFixed(4)}
                            </span>
                          </div>
                          <div className="mt-1.5 text-xs text-cs-secondary">
                            <span>{t("thDominant")}: {h.dominantCategory}</span>
                            <span className="ml-2">{t("severity")}: {h.dominantSeverity.toLowerCase()}</span>
                            {h.department && <span className="ml-2">{h.department}</span>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </section>
            )}

            {/* ── Verification ────────────────────────────────────────── */}
            <section>
              <SectionHeading title={t("secVerification")} />
              <div className="grid gap-4 lg:grid-cols-2">
                <Card className="p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-cs-secondary">{t("status")}</h3>
                  <ul className="mt-2 space-y-1.5 text-sm">
                    {(o.verification.byResult.value ?? []).map((g) => (
                      <li key={g.key} className="flex items-center justify-between gap-2">
                        <span className="text-cs-text">{g.key.toLowerCase()}</span>
                        <span className="cs-badge tnum border-cs-border bg-cs-elevated text-cs-secondary">{g.count}</span>
                      </li>
                    ))}
                    {(o.verification.byResult.value ?? []).length === 0 && <li className="text-cs-faint">{t("noData")}</li>}
                  </ul>
                  <dl className="mt-3 grid grid-cols-3 gap-3 border-t border-cs-border pt-3 text-xs">
                    <div>
                      <dt className="text-cs-secondary">{t("mSuccessRate")}</dt>
                      <dd><MetricValue m={o.verification.successRate} t={t} fmt={pct} /></dd>
                    </div>
                    <div>
                      <dt className="text-cs-secondary">{t("mAvailabilityRate")}</dt>
                      <dd><MetricValue m={o.verification.availabilityRate} t={t} fmt={pct} /></dd>
                    </div>
                    <div>
                      <dt className="text-cs-secondary">{t("mNeverVerified")}</dt>
                      <dd><MetricValue m={o.verification.neverVerified} t={t} /></dd>
                    </div>
                  </dl>
                </Card>
                <Card className="p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-cs-secondary">{t("mConfidenceByProvider")}</h3>
                  {o.verification.avgConfidenceByProvider.length === 0 ? (
                    <p className="mt-2 text-sm text-cs-faint">{t("noData")}</p>
                  ) : (
                    <ul className="mt-2 space-y-1.5 text-sm">
                      {o.verification.avgConfidenceByProvider.map((p) => (
                        <li key={p.provider} className="flex items-center justify-between gap-2">
                          <span className="text-cs-text">
                            {p.provider}
                            {p.provider.startsWith("dev") && <span className="ml-1.5 text-[10px] text-amber-300">(dev)</span>}
                          </span>
                          <span className="tnum text-cs-secondary">
                            {p.avgConfidence != null ? pct(p.avgConfidence) : "—"} <span className="text-cs-faint">· {p.sampleSize}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
            </section>

            {/* ── Location quality ────────────────────────────────────── */}
            <section>
              <SectionHeading title={t("secLocation")} />
              <div className="grid gap-4 lg:grid-cols-2">
                <Card className="p-4">
                  <div className="grid grid-cols-2 gap-3">
                    <MetricCard label={t("mCoverage")} value={<MetricValue m={o.location.coordinateCoverage} t={t} fmt={pct} />} />
                    <MetricCard label={t("mWithCoords")} value={<MetricValue m={o.location.withCoordinates} t={t} />} />
                    <MetricCard label={t("mWithoutCoords")} value={<MetricValue m={o.location.withoutCoordinates} t={t} />} />
                  </div>
                  <ul className="mt-3 space-y-1.5 text-sm">
                    {([
                      ["mAccGood", o.location.accuracy.good, "text-emerald-300"],
                      ["mAccDegraded", o.location.accuracy.degraded, "text-amber-300"],
                      ["mAccPoor", o.location.accuracy.poor, "text-red-300"],
                      ["mAccUnknown", o.location.accuracy.unknown, "text-cs-secondary"],
                    ] as const).map(([label, m, tone]) => (
                      <li key={label} className="flex items-center justify-between gap-2">
                        <span className="text-cs-secondary">{t(label)}</span>
                        <span className={`tnum ${tone}`}><MetricValue m={m} t={t} /></span>
                      </li>
                    ))}
                  </ul>
                </Card>
                <Card className="p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-cs-secondary">{t("mBySource")}</h3>
                  {(o.location.bySource.value ?? []).length === 0 ? (
                    <p className="mt-2 text-sm text-cs-faint">{t("noData")}</p>
                  ) : (
                    <ul className="mt-2 space-y-1.5 text-sm">
                      {(o.location.bySource.value ?? []).map((g) => (
                        <li key={g.key} className="flex items-center justify-between gap-2">
                          <span className="font-mono text-cs-text">{g.key}</span>
                          <span className="cs-badge tnum border-cs-border bg-cs-elevated text-cs-secondary">{g.count}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
            </section>
          </>
        )}
      </div>
    </AppShell>
  );
}
