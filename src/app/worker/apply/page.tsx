"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Button, ErrorNote, Input, LoginPrompt, PageHeader, Select, Skeleton } from "@/components/ui";
import { api, fetchMe, fmtDateTime, type SessionUser } from "@/lib/client";
import { useLang } from "@/lib/i18n";
import { DEPARTMENT_CODES, EMPLOYEE_ID_REGEX, workerEquipmentLabels, workerSkillLabels } from "@/lib/constants";

/** PublicWorkerApplication — verified in src/lib/workerDomain.ts (JSON dates are strings). */
type AppRow = {
  id: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  employeeId: string;
  departmentCode: string;
  designation: string | null;
  skills: string[];
  equipment: string[];
  experience: string | null;
  serviceAreas: string[];
  phone: string | null;
  workEmail: string | null;
  createdAt: string;
  reviewedAt: string | null;
  rejectionReason: string | null;
};

const statusTone: Record<AppRow["status"], string> = {
  PENDING: "border-amber-400/30 bg-amber-500/10 text-amber-300",
  APPROVED: "border-emerald-400/30 bg-emerald-500/10 text-emerald-300",
  REJECTED: "border-red-400/30 bg-red-500/10 text-red-300",
};
const statusKey = { PENDING: "appPending", APPROVED: "appApproved", REJECTED: "appRejected" } as const;

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="cs-badge border-cs-border bg-cs-elevated text-cs-secondary">{children}</span>;
}

/** Read-only display of an application (only fields the backend returns). */
function ApplicationCard({ a }: { a: AppRow }) {
  const { t } = useLang();
  return (
    <div className="cs-card cs-fade-up p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-base font-semibold tracking-tight text-cs-text">{t("appStatus")}</h2>
        <span className={`cs-badge ${statusTone[a.status]}`}>{t(statusKey[a.status])}</span>
      </div>
      <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-cs-secondary">{t("employeeId")}</dt>
          <dd className="font-mono text-cs-text">{a.employeeId}</dd>
        </div>
        <div>
          <dt className="text-xs text-cs-secondary">{t("department")}</dt>
          <dd className="text-cs-text">{a.departmentCode || "—"}</dd>
        </div>
        {a.designation && (
          <div>
            <dt className="text-xs text-cs-secondary">{t("designation")}</dt>
            <dd className="text-cs-text">{a.designation}</dd>
          </div>
        )}
        {a.skills.length > 0 && (
          <div className="sm:col-span-2">
            <dt className="text-xs text-cs-secondary">{t("skills")}</dt>
            <dd className="mt-1 flex flex-wrap gap-1.5">
              {a.skills.map((s) => (
                <Chip key={s}>{workerSkillLabels[s] ?? s}</Chip>
              ))}
            </dd>
          </div>
        )}
        {a.equipment.length > 0 && (
          <div className="sm:col-span-2">
            <dt className="text-xs text-cs-secondary">{t("equipment")}</dt>
            <dd className="mt-1 flex flex-wrap gap-1.5">
              {a.equipment.map((s) => (
                <Chip key={s}>{workerEquipmentLabels[s] ?? s}</Chip>
              ))}
            </dd>
          </div>
        )}
        {a.experience && (
          <div className="sm:col-span-2">
            <dt className="text-xs text-cs-secondary">{t("experience")}</dt>
            <dd className="text-cs-text">{a.experience}</dd>
          </div>
        )}
        {a.serviceAreas.length > 0 && (
          <div className="sm:col-span-2">
            <dt className="text-xs text-cs-secondary">{t("serviceAreas")}</dt>
            <dd className="text-cs-text">{a.serviceAreas.join(", ")}</dd>
          </div>
        )}
        {a.phone && (
          <div>
            <dt className="text-xs text-cs-secondary">{t("phone")}</dt>
            <dd className="text-cs-text">{a.phone}</dd>
          </div>
        )}
        {a.workEmail && (
          <div>
            <dt className="text-xs text-cs-secondary">{t("workEmail")}</dt>
            <dd className="text-cs-text">{a.workEmail}</dd>
          </div>
        )}
        <div>
          <dt className="text-xs text-cs-secondary">{t("created")}</dt>
          <dd className="text-cs-text">{fmtDateTime(a.createdAt)}</dd>
        </div>
        {a.reviewedAt && (
          <div>
            <dt className="text-xs text-cs-secondary">{t("approvedOn")}</dt>
            <dd className="text-cs-text">{fmtDateTime(a.reviewedAt)}</dd>
          </div>
        )}
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

/** Multi-select chip group (fieldset/legend semantics, aria-pressed toggles). */
function ChipGroup({
  legend,
  options,
  labels,
  selected,
  onToggle,
}: {
  legend: string;
  options: readonly string[];
  labels: Record<string, string>;
  selected: string[];
  onToggle: (v: string) => void;
}) {
  return (
    <fieldset className="w-full">
      <legend className="mb-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-cs-secondary">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((s) => {
          const on = selected.includes(s);
          return (
            <button
              key={s}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(s)}
              className={`cs-badge border transition ${
                on ? "border-blue-400/40 bg-blue-500/15 text-blue-200" : "border-cs-border bg-cs-elevated text-cs-secondary hover:text-cs-text"
              }`}
            >
              {labels[s] ?? s}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export default function WorkerApplyPage() {
  const { t } = useLang();
  const [me, setMe] = useState<SessionUser | null | undefined>(undefined);
  const [existing, setExisting] = useState<AppRow | null | undefined>(undefined);
  const [justSubmitted, setJustSubmitted] = useState(false);

  const [employeeId, setEmployeeId] = useState("");
  const [departmentCode, setDepartmentCode] = useState("");
  const [designation, setDesignation] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [equipment, setEquipment] = useState<string[]>([]);
  const [experience, setExperience] = useState("");
  const [serviceAreasText, setServiceAreasText] = useState("");
  const [phone, setPhone] = useState("");
  const [workEmail, setWorkEmail] = useState("");
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
      if (u.role !== "CITIZEN") {
        window.location.href = u.role === "WORKER" ? "/worker" : "/official";
        return;
      }
      setMe(u);
      // Load own application first — prevents duplicate submission for
      // PENDING/APPROVED cases (the server also 409-guards this).
      api<{ application: AppRow | null }>("/api/worker/apply")
        .then((r) => alive && setExisting(r.application))
        .catch(() => alive && setExisting(null));
    });
    return () => {
      alive = false;
    };
  }, []);

  const toggle = (list: string[], set: (v: string[]) => void) => (v: string) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const eid = employeeId.trim().toUpperCase();
    if (!departmentCode || !EMPLOYEE_ID_REGEX.test(eid)) return;
    const serviceAreas = serviceAreasText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    setApplying(true);
    setError("");
    try {
      const res = await api<{ application: AppRow }>("/api/worker/apply", {
        body: {
          employeeId: eid,
          departmentCode,
          ...(designation.trim() ? { designation: designation.trim() } : {}),
          skills,
          equipment,
          ...(experience.trim() ? { experience: experience.trim() } : {}),
          serviceAreas,
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          ...(workEmail.trim() ? { workEmail: workEmail.trim() } : {}),
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
          <PageHeader title={t("applyTitle")} />
          <LoginPrompt />
        </div>
      </AppShell>
    );
  }

  const blocked = existing !== undefined && existing !== null && existing.status !== "REJECTED";

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-4">
        <PageHeader title={t("applyTitle")} subtitle={t("applySub")} />

        {existing === undefined ? (
          <Skeleton className="h-40" />
        ) : (
          <>
            {existing && <ApplicationCard a={existing} />}

            {blocked ? (
              justSubmitted && (
                <p role="status" className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
                  {t("applyOk")}
                </p>
              )
            ) : (
              <>
                {justSubmitted && (
                  <p className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200" role="status">
                    {t("applyOk")}
                  </p>
                )}
                {existing?.status === "REJECTED" && (
                  <p className="text-sm text-cs-secondary">{t("applySub")}</p>
                )}
                <form onSubmit={submit} className="cs-card cs-fade-up space-y-4 p-5">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Input
                      label={t("employeeId")}
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
                      options={[{ value: "", label: "—" }, ...DEPARTMENT_CODES.map((c) => ({ value: c, label: c }))]}
                    />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Input label={`${t("designation")} (${t("optional")})`} value={designation} onChange={(e) => setDesignation(e.target.value)} maxLength={80} />
                    <Input label={`${t("phone")} (${t("optional")})`} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" />
                    <Input label={`${t("workEmail")} (${t("optional")})`} type="email" value={workEmail} onChange={(e) => setWorkEmail(e.target.value)} autoComplete="email" />
                  </div>
                  <ChipGroup legend={t("skills")} options={Object.keys(workerSkillLabels)} labels={workerSkillLabels} selected={skills} onToggle={toggle(skills, setSkills)} />
                  <ChipGroup legend={t("equipment")} options={Object.keys(workerEquipmentLabels)} labels={workerEquipmentLabels} selected={equipment} onToggle={toggle(equipment, setEquipment)} />
                  <div className="w-full">
                    <label htmlFor="experience" className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.06em] text-cs-secondary">
                      {t("experience")}
                    </label>
                    <textarea
                      id="experience"
                      rows={3}
                      maxLength={500}
                      value={experience}
                      onChange={(e) => setExperience(e.target.value)}
                      className="cs-input"
                    />
                    <p className="mt-1 text-xs text-cs-faint">{t("experienceHint")}</p>
                  </div>
                  <Input label={`${t("serviceAreas")} (${t("optional")})`} hint={t("serviceAreasHint")} value={serviceAreasText} onChange={(e) => setServiceAreasText(e.target.value)} />

                  <div aria-live="polite">{error && <ErrorNote message={error} />}</div>

                  <Button type="submit" disabled={applying}>
                    {applying ? t("applying") : t("submitApplication")}
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
