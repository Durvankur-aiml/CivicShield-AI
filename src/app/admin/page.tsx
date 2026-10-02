"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { Card, EmptyState, ErrorNote, LoginPrompt, MetricCard, PageHeader, Skeleton } from "@/components/ui";
import { api, fetchMe, fmtAgo, homeForRole, type SessionUser } from "@/lib/client";
import { departmentLabel } from "@/lib/constants";
import { useLang } from "@/lib/i18n";
import { ShieldCheck, Users, ClipboardList, ArrowRight } from "lucide-react";

type PendingApp = { id: string; applicantName?: string; applicant: { name: string; email: string }; createdAt: string; departmentCode: string };
type OfficialRow = { userId: string; userName: string; officialId: string; departmentCode: string; approvedAt: string };

export default function AdminHomePage() {
  const { t } = useLang();
  const [me, setMe] = useState<SessionUser | null | undefined>(undefined);
  const [applications, setApplications] = useState<PendingApp[] | null>(null);
  const [profiles, setProfiles] = useState<OfficialRow[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    fetchMe().then((u) => {
      if (!alive) return;
      if (!u) {
        setMe(null);
        return;
      }
      if (u.role !== "ADMIN") {
        window.location.href = homeForRole(u.role);
        return;
      }
      setMe(u);
      api<{ applications: PendingApp[]; profiles: OfficialRow[] }>("/api/admin/official-applications")
        .then((d) => {
          if (!alive) return;
          setApplications(d.applications);
          setProfiles(d.profiles);
        })
        .catch((e) => alive && setError((e as Error).message));
    });
    return () => {
      alive = false;
    };
  }, []);

  if (me === undefined) {
    return (
      <AppShell>
        <div className="mx-auto max-w-6xl space-y-4">
          <Skeleton className="h-10 w-64" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        </div>
      </AppShell>
    );
  }
  if (me === null) {
    return (
      <AppShell>
        <div className="mx-auto max-w-6xl space-y-4">
          <PageHeader title={t("adminTitle")} />
          <LoginPrompt />
        </div>
      </AppShell>
    );
  }

  const pending = applications ?? [];

  return (
    <AppShell>
      <div className="mx-auto max-w-6xl space-y-6">
        <PageHeader title={t("adminTitle")} subtitle={t("adminSub")} />

        <div aria-live="polite">{error && <ErrorNote message={error} />}</div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard label={t("adminPendingApps")} value={applications ? pending.length : "…"} tone="text-amber-300" icon={<ClipboardList className="h-4 w-4" />} />
          <MetricCard label={t("adminVerifiedOfficials")} value={profiles ? profiles.length : "…"} tone="text-emerald-300" icon={<ShieldCheck className="h-4 w-4" />} />
          <MetricCard label={t("adminRole")} value="ADMIN" tone="text-violet-300" icon={<Users className="h-4 w-4" />} />
        </div>

        <Link href="/admin/official-applications" className="block rounded-[20px] focus-visible:outline-2">
          <Card hover className="cs-fade-up p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="grid h-8 w-8 place-items-center rounded-lg border border-blue-400/30 bg-blue-500/10 text-blue-300" aria-hidden>
                    <ClipboardList className="h-4 w-4" />
                  </span>
                  <span className="font-display text-base font-semibold tracking-tight text-cs-text">{t("adminApplicationsNav")}</span>
                </div>
                <p className="mt-1.5 max-w-xl text-sm text-cs-secondary">
                  {applications === null ? "…" : pending.length === 0 ? t("noPending") : `${pending.length} ${t("adminPendingApps")}`}
                </p>
              </div>
              <span className="cs-btn cs-btn-secondary px-3! py-1.5! text-xs!">
                {t("reviewAction")} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </span>
            </div>
          </Card>
        </Link>

        <section>
          <SectionHeading2 title={t("adminVerifiedOfficials")} />
          <Card className="p-3">
            {profiles === null ? (
              <div className="space-y-2 p-1">
                {[0, 1].map((i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            ) : profiles.length === 0 ? (
              <div className="px-2 py-6">
                <EmptyState title={t("noVerifiedOfficials")} icon={<ShieldCheck className="h-5 w-5" />} />
              </div>
            ) : (
              <ul className="space-y-1">
                {profiles.map((p) => (
                  <li key={p.userId} className="flex items-center justify-between gap-2 rounded-lg px-2 py-2 transition hover:bg-white/5">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-cs-border bg-cs-elevated text-emerald-300" aria-hidden>
                        <ShieldCheck className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium text-cs-text">{p.userName}</span>
                        <span className="block truncate text-[10px] text-cs-faint">{p.officialId} · {p.departmentCode ? departmentLabel(p.departmentCode) : "—"}</span>
                      </span>
                    </span>
                    <span className="shrink-0 text-[11px] text-cs-faint tnum">{fmtAgo(p.approvedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>
      </div>
    </AppShell>
  );
}

function SectionHeading2({ title }: { title: string }) {
  const { t } = useLang();
  return <h2 className="font-display text-lg font-semibold tracking-tight text-cs-text">{title || t("adminTitle")}</h2>;
}
