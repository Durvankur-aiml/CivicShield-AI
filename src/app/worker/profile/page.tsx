"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Card, EmptyState, ErrorNote, LoginPrompt, PageHeader, Skeleton } from "@/components/ui";
import { api, fetchMe, fmtDateTime, type SessionUser } from "@/lib/client";
import { UserRoundX } from "lucide-react";
import { useLang } from "@/lib/i18n";
import { workerAvailabilityLabels, workerEquipmentLabels, workerSkillLabels } from "@/lib/constants";

/** PublicWorkerProfile — verified in src/lib/workerDomain.ts (JSON dates are strings). */
type Profile = {
  id: string;
  employeeId: string;
  departmentCode: string;
  departmentName: string;
  designation: string | null;
  skills: string[];
  equipment: string[];
  availability: string;
  serviceAreas: string[];
  phone: string | null;
  workEmail: string | null;
  approvedAt: string;
};

const availabilityTone: Record<string, string> = {
  AVAILABLE: "border-emerald-400/30 bg-emerald-500/10 text-emerald-300",
  OFF_DUTY: "border-slate-400/25 bg-slate-500/10 text-slate-300",
  SUSPENDED: "border-red-400/30 bg-red-500/10 text-red-300",
};

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="cs-badge border-cs-border bg-cs-elevated text-cs-secondary">{children}</span>;
}

/** READ-ONLY by contract: the backend exposes no profile-update endpoint. */
export default function WorkerProfilePage() {
  const { t } = useLang();
  const [me, setMe] = useState<SessionUser | null | undefined>(undefined);
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    fetchMe().then((u) => {
      if (!alive) return;
      if (!u) {
        setMe(null);
        return;
      }
      if (u.role !== "WORKER") {
        window.location.href = u.role === "OFFICIAL" ? "/official" : "/citizen";
        return;
      }
      setMe(u);
      api<{ profile: Profile }>("/api/worker/profile")
        .then((r) => alive && setProfile(r.profile))
        .catch((e) => {
          if (!alive) return;
          setError((e as Error).message);
          setProfile(null);
        });
    });
    return () => {
      alive = false;
    };
  }, []);

  if (me === undefined) {
    return (
      <AppShell>
        <div className="mx-auto max-w-3xl space-y-4">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-72" />
        </div>
      </AppShell>
    );
  }
  if (me === null) {
    return (
      <AppShell>
        <div className="mx-auto max-w-3xl space-y-4">
          <PageHeader title={t("profileTitle")} />
          <LoginPrompt />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-4">
        <PageHeader title={t("profileTitle")} subtitle={t("profileSub")} />

        <div aria-live="polite">{error && <ErrorNote message={error} />}</div>

        {profile === undefined ? (
          <Skeleton className="h-72" />
        ) : profile === null ? (
          <EmptyState icon={<UserRoundX className="h-5 w-5" />} title={t("noProfileTitle")} hint={t("noProfileHint")} />
        ) : (
          <Card className="cs-fade-up p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <span className="grid h-11 w-11 place-items-center rounded-xl border border-cs-border bg-cs-elevated text-lg font-semibold text-blue-300" aria-hidden>
                  {me.name.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <h2 className="font-display text-base font-semibold tracking-tight text-cs-text">{me.name}</h2>
                  <p className="font-mono text-xs text-cs-secondary">{profile.employeeId}</p>
                </div>
              </div>
              <span className={`cs-badge ${availabilityTone[profile.availability] ?? ""}`}>
                <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden />
                {workerAvailabilityLabels[profile.availability] ?? profile.availability}
              </span>
            </div>

            <dl className="mt-5 grid gap-x-6 gap-y-3 border-t border-cs-border pt-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-cs-secondary">{t("department")}</dt>
                <dd className="text-cs-text">
                  {profile.departmentName || profile.departmentCode || "—"}
                  {profile.departmentCode && profile.departmentName && (
                    <span className="ml-1.5 font-mono text-[11px] text-cs-faint">{profile.departmentCode}</span>
                  )}
                </dd>
              </div>
              {profile.designation && (
                <div>
                  <dt className="text-xs text-cs-secondary">{t("designation")}</dt>
                  <dd className="text-cs-text">{profile.designation}</dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-cs-secondary">{t("approvedOn")}</dt>
                <dd className="text-cs-text">{fmtDateTime(profile.approvedAt)}</dd>
              </div>
              {profile.skills.length > 0 && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-cs-secondary">{t("skills")}</dt>
                  <dd className="mt-1 flex flex-wrap gap-1.5">
                    {profile.skills.map((s) => (
                      <Chip key={s}>{workerSkillLabels[s] ?? s}</Chip>
                    ))}
                  </dd>
                </div>
              )}
              {profile.equipment.length > 0 && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-cs-secondary">{t("equipment")}</dt>
                  <dd className="mt-1 flex flex-wrap gap-1.5">
                    {profile.equipment.map((s) => (
                      <Chip key={s}>{workerEquipmentLabels[s] ?? s}</Chip>
                    ))}
                  </dd>
                </div>
              )}
              {profile.serviceAreas.length > 0 && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-cs-secondary">{t("serviceAreas")}</dt>
                  <dd className="text-cs-text">{profile.serviceAreas.join(", ")}</dd>
                </div>
              )}
              {profile.phone && (
                <div>
                  <dt className="text-xs text-cs-secondary">{t("phone")}</dt>
                  <dd className="text-cs-text">{profile.phone}</dd>
                </div>
              )}
              {profile.workEmail && (
                <div>
                  <dt className="text-xs text-cs-secondary">{t("workEmail")}</dt>
                  <dd className="text-cs-text">{profile.workEmail}</dd>
                </div>
              )}
            </dl>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
