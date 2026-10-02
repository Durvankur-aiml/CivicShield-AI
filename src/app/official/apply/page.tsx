"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Button, ErrorNote, Input, LoginPrompt, PageHeader, Select, Skeleton } from "@/components/ui";
import { api, fetchMe, fmtDateTime, homeForRole, type SessionUser } from "@/lib/client";
import { useLang } from "@/lib/i18n";
import { DEPARTMENT_CODES, departmentLabel } from "@/lib/constants";
import { ShieldCheck, ArrowRight } from "lucide-react";

/** PublicOfficialApplication — verified in src/lib/officialDomain.ts (dates are ISO strings). */
type AppRow = {
  id: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  employeeId: string;
  departmentCode: string;
  designation: string | null;
  municipality: string;
  officialEmail: string | null;
  phone: string | null;
  serviceAreas: string[];
  experience: string | null;
  applicationDetails: string | null;
  createdAt: string;
  reviewedAt: string | null;
  rejectionReason: string | null;
};

/** PublicOfficialProfile — verified in src/lib/officialDomain.ts. */
type ProfileRow = {
  officialId: string;
  departmentCode: string;
  departmentName: string;
  designation: string | null;
  municipality: string;
  serviceAreas: string[];
  approvedAt: string;
};

const statusTone: Record<AppRow["status"], string> = {
  PENDING: "border-amber-400/30 bg-amber-500/10 text-amber-300",
  APPROVED: "border-emerald-400/30 bg-emerald-500/10 text-emerald-300",
  REJECTED: "border-red-400/30 bg-red-500/10 text-red-300",
};
const statusKey = { PENDING: "appPending", APPROVED: "appApproved", REJECTED: "appRejected" } as const;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-cs-secondary">{label}</dt>
      <dd className="text-cs-text">{children}</dd>
    </div>
  );
}

/** Read-only display of the application (only fields the backend returns). */
function ApplicationCard({ a }: { a: AppRow }) {
  const { t } = useLang();
  return (
    <div className="cs-card cs-fade-up p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-base font-semibold tracking-tight text-cs-text">{t("appStatus")}</h2>
        <span className={`cs-badge ${statusTone[a.status]}`}>{t(statusKey[a.status])}</span>
      </div>
      <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Row label={t("municipalEmployeeId")}>
          <span className="font-mono">{a.employeeId}</span>
        </Row>
        <Row label={t("department")}>{a.departmentCode ? departmentLabel(a.departmentCode) : "—"}</Row>
        {a.designation && <Row label={t("designation")}>{a.designation}</Row>}
        <Row label={t("municipality")}>{a.municipality}</Row>
        {a.officialEmail && <Row label={t("officialEmail")}>{a.officialEmail}</Row>}
        {a.phone && <Row label={t("phone")}>{a.phone}</Row>}
        {a.serviceAreas.length > 0 && <Row label={t("serviceAreas")}>{a.serviceAreas.join(", ")}</Row>}
        {a.experience && <Row label={t("experience")}>{a.experience}</Row>}
        {a.applicationDetails && (
          <div className="sm:col-span-2">
            <dt className="text-xs text-cs-secondary">{t("applicationDetails")}</dt>
            <dd className="text-cs-text">{a.applicationDetails}</dd>
          </div>
        )}
        <Row label={t("created")}>{fmtDateTime(a.createdAt)}</Row>
        {a.reviewedAt && <Row label={t("reviewedOn")}>{fmtDateTime(a.reviewedAt)}</Row>}
        {a.status === "REJECTED" && a.rejectionReason && (
          <div className="sm:col-span-2 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            <span className="font-semibold">{t("rejectionReason")}: </span>
            {a.rejectionReason}
          </div>
        )}
      </dl>
    </div>
  );
}

/**
 * APPROVED state (spec §5): CivicShield Official ID + department + designation
 * + dashboard access. Shown to officials visiting this page. The ID is a
 * CivicShield PLATFORM identifier — clearly NOT a government credential.
 */
function ApprovedCard({ p }: { p: ProfileRow }) {
  const { t } = useLang();
  return (
    <div className="cs-card cs-fade-up border border-emerald-400/30 bg-emerald-500/5 p-5">
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-xl border border-emerald-400/30 bg-emerald-500/10 text-emerald-300" aria-hidden>
          <ShieldCheck className="h-5 w-5" />
        </span>
        <div>
          <h2 className="font-display text-base font-semibold tracking-tight text-cs-text">{t("officialApprovedTitle")}</h2>
          <p className="font-mono text-sm text-emerald-300">{p.officialId}</p>
        </div>
      </div>
      <dl className="mt-4 grid gap-x-6 gap-y-3 border-t border-cs-border pt-4 text-sm sm:grid-cols-2">
        <Row label={t("officialIdLabel")}>
          <span className="font-mono">{p.officialId}</span>
        </Row>
        <Row label={t("department")}>
          {p.departmentName || p.departmentCode || "—"}
          {p.departmentCode && p.departmentName && (
            <span className="ml-1.5 font-mono text-[11px] text-cs-faint">{p.departmentCode}</span>
          )}
        </Row>
        {p.designation && <Row label={t("designation")}>{p.designation}</Row>}
        <Row label={t("municipality")}>{p.municipality}</Row>
        <Row label={t("approvedOn")}>{fmtDateTime(p.approvedAt)}</Row>
        {p.serviceAreas.length > 0 && <Row label={t("serviceAreas")}>{p.serviceAreas.join(", ")}</Row>}
      </dl>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <a href={homeForRole("OFFICIAL")} className="cs-btn cs-btn-primary">
          {t("officialDashboardCta")} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </a>
        <span className="text-xs text-cs-secondary">{t("officialIdDisclaimer")}</span>
      </div>
    </div>
  );
}

export default function OfficialApplyPage() {
  const { t } = useLang();
  const [me, setMe] = useState<SessionUser | null | undefined>(undefined);
  const [existing, setExisting] = useState<AppRow | null | undefined>(undefined);
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [justSubmitted, setJustSubmitted] = useState(false);

  const [employeeId, setEmployeeId] = useState("");
  const [departmentCode, setDepartmentCode] = useState("");
  const [designation, setDesignation] = useState("");
  const [municipality, setMunicipality] = useState("");
  const [officialEmail, setOfficialEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [serviceAreasText, setServiceAreasText] = useState("");
  const [experience, setExperience] = useState("");
  const [applicationDetails, setApplicationDetails] = useState("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    fetchMe().then((u) => {
      if (!alive) return;
      if (!u) {
        setMe(null);
        return;
      }
      if (u.role === "ADMIN") {
        window.location.href = homeForRole(u.role);
        return;
      }
      setMe(u);
      if (u.role === "OFFICIAL") {
        // APPROVED state: show the verified profile + Official ID (spec §5).
        api<{ profile: ProfileRow }>("/api/official/profile")
          .then((r) => alive && setProfile(r.profile))
          .catch(() => alive && setProfile(null));
        return;
      }
      // CITIZEN/WORKER: load own application — prevents duplicate submission
      // for PENDING/APPROVED cases (the server also 409-guards this).
      api<{ application: AppRow | null }>("/api/official/apply")
        .then((r) => alive && setExisting(r.application))
        .catch(() => alive && setExisting(null));
    });
    return () => {
      alive = false;
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setApplying(true);
    setError("");
    try {
      const serviceAreas = serviceAreasText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await api<{ application: AppRow }>("/api/official/apply", {
        body: {
          employeeId: employeeId.trim().toUpperCase(),
          departmentCode,
          municipality: municipality.trim(),
          ...(designation.trim() ? { designation: designation.trim() } : {}),
          ...(officialEmail.trim() ? { officialEmail: officialEmail.trim() } : {}),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          serviceAreas,
          ...(experience.trim() ? { experience: experience.trim() } : {}),
          ...(applicationDetails.trim() ? { applicationDetails: applicationDetails.trim() } : {}),
        },
      });
      setExisting(res.application);
      setJustSubmitted(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setApplying(false);
    }
  }

  if (me === undefined) {
    return (
      <AppShell>
        <div className="mx-auto max-w-3xl space-y-4">
          <Skeleton className="h-10 w-72" />
          <Skeleton className="h-96" />
        </div>
      </AppShell>
    );
  }
  if (me === null) {
    return (
      <AppShell>
        <div className="mx-auto max-w-3xl space-y-4">
          <PageHeader title={t("officialApplyTitle")} />
          <LoginPrompt />
        </div>
      </AppShell>
    );
  }

  const isOfficial = me.role === "OFFICIAL";
  const blocked = existing !== undefined && existing !== null && existing.status !== "REJECTED";

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-4">
        <PageHeader title={t("officialApplyTitle")} subtitle={t("officialApplySub")} />

        <p className="rounded-xl border border-blue-400/25 bg-blue-500/10 px-4 py-3 text-sm text-blue-200">
          {t("officialAccessNote")}
        </p>

        {isOfficial ? (
          profile ? (
            <ApprovedCard p={profile} />
          ) : (
            <Skeleton className="h-40" />
          )
        ) : existing === undefined ? (
          <Skeleton className="h-40" />
        ) : (
          <>
            {existing && <ApplicationCard a={existing} />}

            {blocked ? (
              justSubmitted && (
                <p role="status" className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
                  {t("officialApplyOk")}
                </p>
              )
            ) : (
              <>
                {justSubmitted && (
                  <p role="status" className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
                    {t("officialApplyOk")}
                  </p>
                )}
                {existing?.status === "REJECTED" && (
                  <p className="text-sm text-cs-secondary">{t("officialReapplyHint")}</p>
                )}
                <form onSubmit={submit} className="cs-card cs-fade-up space-y-4 p-5">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Input
                      label={t("municipalEmployeeId")}
                      hint={t("employeeIdHint")}
                      value={employeeId}
                      onChange={(e) => setEmployeeId(e.target.value)}
                      required
                      maxLength={19}
                      autoComplete="off"
                    />
                    <Select
                      label={t("department")}
                      value={departmentCode}
                      onChange={(e) => setDepartmentCode(e.target.value)}
                      required
                      options={[{ value: "", label: "—" }, ...DEPARTMENT_CODES.map((c) => ({ value: c, label: departmentLabel(c) }))]}
                    />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Input label={t("municipality")} value={municipality} onChange={(e) => setMunicipality(e.target.value)} required maxLength={120} />
                    <Input label={`${t("designation")} (${t("optional")})`} value={designation} onChange={(e) => setDesignation(e.target.value)} maxLength={80} />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Input label={`${t("officialEmail")} (${t("optional")})`} type="email" value={officialEmail} onChange={(e) => setOfficialEmail(e.target.value)} autoComplete="email" />
                    <Input label={`${t("phone")} (${t("optional")})`} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" />
                  </div>
                  <Input label={`${t("serviceAreas")} (${t("optional")})`} hint={t("serviceAreasHint")} value={serviceAreasText} onChange={(e) => setServiceAreasText(e.target.value)} />
                  <div className="w-full">
                    <label htmlFor="official-experience" className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.06em] text-cs-secondary">
                      {t("experience")}
                    </label>
                    <textarea
                      id="official-experience"
                      rows={3}
                      maxLength={500}
                      value={experience}
                      onChange={(e) => setExperience(e.target.value)}
                      className="cs-input"
                    />
                    <p className="mt-1 text-xs text-cs-faint">{t("experienceHint")}</p>
                  </div>
                  <div className="w-full">
                    <label htmlFor="official-details" className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.06em] text-cs-secondary">
                      {t("applicationDetails")}
                    </label>
                    <textarea
                      id="official-details"
                      rows={3}
                      maxLength={1000}
                      value={applicationDetails}
                      onChange={(e) => setApplicationDetails(e.target.value)}
                      className="cs-input"
                    />
                    <p className="mt-1 text-xs text-cs-faint">{t("applicationDetailsHint")}</p>
                  </div>

                  <div aria-live="polite">{error && <ErrorNote message={error} />}</div>

                  <Button type="submit" disabled={applying || !departmentCode || municipality.trim().length < 2}>
                    {applying ? t("applying") : t("submitOfficialApplication")}
                  </Button>
                </form>
              </>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
