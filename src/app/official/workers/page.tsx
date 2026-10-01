"use client";

import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import {
  Button,
  EmptyState,
  ErrorNote,
  LoginPrompt,
  Modal,
  PageHeader,
  SectionHeading,
  Skeleton,
  TableHead,
  TableShell,
  TableStateRow,
} from "@/components/ui";
import { api, fetchMe, fmtDateTime, type SessionUser } from "@/lib/client";
import { useLang } from "@/lib/i18n";
import { workerAvailabilityLabels, workerEquipmentLabels, workerSkillLabels } from "@/lib/constants";
import { BadgeCheck, Ban, Check, ClipboardList, RefreshCw } from "lucide-react";

/** Registry profile + worker user row — verified in src/lib/workerDomain.ts. */
type RegistryProfile = {
  id: string;
  employeeId: string;
  departmentCode: string;
  departmentName: string;
  designation: string | null;
  skills: string[];
  equipment: string[];
  availability: string;
  serviceAreas: string[];
};

type WorkerUser = {
  id: string;
  name: string;
  departmentId: string | null;
  profile: RegistryProfile | null;
};

/** Pending application incl. applicant block — verified in workerDomain. */
type ApplicationRow = {
  id: string;
  employeeId: string;
  departmentCode: string;
  designation: string | null;
  skills: string[];
  equipment: string[];
  experience: string | null;
  serviceAreas: string[];
  createdAt: string;
  applicant: { id: string; name: string; email: string; image: string | null };
};

const availabilityTone: Record<string, string> = {
  AVAILABLE: "border-emerald-400/30 bg-emerald-500/10 text-emerald-300",
  OFF_DUTY: "border-slate-400/25 bg-slate-500/10 text-slate-300",
  SUSPENDED: "border-red-400/30 bg-red-500/10 text-red-300",
};

export default function OfficialWorkersPage() {
  const { t } = useLang();
  const [me, setMe] = useState<SessionUser | null | undefined>(undefined);
  const [users, setUsers] = useState<WorkerUser[] | null>(null);
  const [apps, setApps] = useState<ApplicationRow[] | null>(null);
  const [tab, setTab] = useState<"workers" | "applications">("workers");
  const [rejecting, setRejecting] = useState<ApplicationRow | null>(null);
  const [reason, setReason] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setError("");
    const [w, a] = await Promise.all([
      api<{ users: WorkerUser[] }>("/api/official/workers").catch(() => null),
      api<{ applications: ApplicationRow[] }>("/api/official/worker-applications").catch(() => null),
    ]);
    if (w) setUsers(w.users);
    if (a) setApps(a.applications);
    if (!w && !a) setError(t("loadFailed"));
  }, [t]);

  useEffect(() => {
    let alive = true;
    fetchMe().then((u) => {
      if (!alive) return;
      if (!u) {
        setMe(null);
        return;
      }
      if (u.role !== "OFFICIAL") {
        window.location.href = u.role === "WORKER" ? "/worker" : "/citizen";
        return;
      }
      setMe(u);
      load();
    });
    return () => {
      alive = false;
      setNotice(""); // drop the success notice when leaving the page
    };
  }, [load]);

  /** Approve/reject with the exact backend body; refreshes the list after mutation. */
  async function decide(app: ApplicationRow, decision: "APPROVE" | "REJECT", rejectionReason?: string) {
    setBusyId(app.id);
    setError("");
    try {
      await api("/api/official/worker-applications", {
        body: { applicationId: app.id, decision, ...(decision === "REJECT" ? { rejectionReason } : {}) },
      });
      setNotice(decision === "APPROVE" ? t("approvedOk") : t("rejectedOk"));
      setRejecting(null);
      setReason("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  if (me === undefined) {
    return (
      <AppShell>
        <div className="mx-auto max-w-6xl space-y-4">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-64" />
        </div>
      </AppShell>
    );
  }
  if (me === null) {
    return (
      <AppShell>
        <div className="mx-auto max-w-6xl space-y-4">
          <PageHeader title={t("workerMgmt")} />
          <LoginPrompt />
        </div>
      </AppShell>
    );
  }

  const pendingCount = apps?.length ?? 0;
  const workers = users ?? [];
  const withProfile = workers.filter((w) => w.profile).length;

  return (
    <AppShell>
      <div className="mx-auto max-w-6xl space-y-4">
        <PageHeader
          title={t("workerMgmt")}
          subtitle={t("workerMgmtSub")}
          actions={
            <Button variant="secondary" size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => load()}>
              {t("refresh")}
            </Button>
          }
        />

        <div aria-live="polite">
          {error && <ErrorNote message={error} />}
          {notice && !error && (
            <p role="status" className="cs-fade-up rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
              {notice}
            </p>
          )}
        </div>

        <div role="tablist" aria-label={t("workerMgmt")} className="flex flex-wrap gap-2">
          <button
            role="tab"
            aria-selected={tab === "workers"}
            onClick={() => setTab("workers")}
            className={`cs-badge border px-3 py-1.5 text-xs font-semibold transition ${
              tab === "workers" ? "border-blue-400/40 bg-blue-500/15 text-blue-200" : "border-cs-border bg-cs-elevated text-cs-secondary hover:text-cs-text"
            }`}
          >
            <BadgeCheck className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />
            {t("tabWorkers")} ({workers.length})
          </button>
          <button
            role="tab"
            aria-selected={tab === "applications"}
            onClick={() => setTab("applications")}
            className={`cs-badge border px-3 py-1.5 text-xs font-semibold transition ${
              tab === "applications" ? "border-blue-400/40 bg-blue-500/15 text-blue-200" : "border-cs-border bg-cs-elevated text-cs-secondary hover:text-cs-text"
            }`}
          >
            <ClipboardList className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />
            {t("tabApplications")} ({pendingCount})
          </button>
        </div>

        {tab === "workers" && (
          <section>
            <SectionHeading title={t("tabWorkers")} hint={`${withProfile} / ${workers.length}`} />
            <TableShell>
              <TableHead
                columns={[t("thWorker"), t("mEmployeeId"), t("department"), t("designation"), t("skills"), t("availability"), t("serviceAreas")]}
              />
              <tbody>
                <TableStateRow
                  colSpan={7}
                  loading={users === null}
                  error={error && users === null ? error : ""}
                  empty={users !== null && workers.length === 0 ? t("noVerifiedWorkers") : ""}
                />
                {users !== null &&
                  workers.map((w) => (
                    <tr key={w.id} className="border-b border-cs-border/60">
                      <td className="px-4 py-3 font-medium text-cs-text">{w.name}</td>
                      <td className="px-4 py-3 font-mono text-xs text-cs-secondary">
                        {w.profile ? w.profile.employeeId : <span className="text-cs-faint">— {t("legacyWorker")}</span>}
                      </td>
                      <td className="px-4 py-3 text-cs-secondary">{w.profile?.departmentCode ?? "—"}</td>
                      <td className="px-4 py-3 text-cs-secondary">{w.profile?.designation ?? "—"}</td>
                      <td className="max-w-56 truncate px-4 py-3 text-xs text-cs-secondary" title={w.profile?.skills.map((s) => workerSkillLabels[s] ?? s).join(", ")}>
                        {w.profile ? (w.profile.skills.length ? w.profile.skills.map((s) => workerSkillLabels[s] ?? s).join(", ") : t("none")) : "—"}
                      </td>
                      <td className="px-4 py-3">
                        {w.profile ? (
                          <span className={`cs-badge ${availabilityTone[w.profile.availability] ?? ""}`}>
                            {workerAvailabilityLabels[w.profile.availability] ?? w.profile.availability}
                          </span>
                        ) : (
                          <span className="text-xs text-cs-faint">—</span>
                        )}
                      </td>
                      <td className="max-w-56 truncate px-4 py-3 text-xs text-cs-secondary" title={w.profile?.serviceAreas.join(", ")}>
                        {w.profile ? (w.profile.serviceAreas.length ? w.profile.serviceAreas.join(", ") : t("none")) : "—"}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </TableShell>
          </section>
        )}

        {tab === "applications" && (
          <section>
            <SectionHeading title={t("tabApplications")} />
            {apps === null ? (
              <Skeleton className="h-24" />
            ) : apps.length === 0 ? (
              <EmptyState icon={<ClipboardList className="h-5 w-5" />} title={t("noPending")} />
            ) : (
              <ul className="space-y-3">
                {apps.map((a) => (
                  <li key={a.id} className="cs-card cs-fade-up p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-cs-text">
                          {a.applicant.name} <span className="text-cs-faint">· {a.applicant.email}</span>
                        </p>
                        <p className="font-mono text-xs text-cs-secondary">
                          {a.employeeId} · {a.departmentCode} · {fmtDateTime(a.createdAt)}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="success" icon={<Check className="h-3.5 w-3.5" />} disabled={busyId === a.id} onClick={() => decide(a, "APPROVE")}>
                          {t("approve")}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          icon={<Ban className="h-3.5 w-3.5" />}
                          disabled={busyId === a.id}
                          onClick={() => {
                            setReason("");
                            setRejecting(a);
                          }}
                        >
                          {t("reject")}
                        </Button>
                      </div>
                    </div>
                    <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
                      {a.designation && (
                        <div>
                          <dt className="text-cs-faint">{t("designation")}</dt>
                          <dd className="text-cs-secondary">{a.designation}</dd>
                        </div>
                      )}
                      <div>
                        <dt className="text-cs-faint">{t("skills")}</dt>
                        <dd className="text-cs-secondary">{a.skills.length ? a.skills.map((s) => workerSkillLabels[s] ?? s).join(", ") : t("none")}</dd>
                      </div>
                      <div>
                        <dt className="text-cs-faint">{t("equipment")}</dt>
                        <dd className="text-cs-secondary">{a.equipment.length ? a.equipment.map((s) => workerEquipmentLabels[s] ?? s).join(", ") : t("none")}</dd>
                      </div>
                      {a.experience && (
                        <div className="sm:col-span-2">
                          <dt className="text-cs-faint">{t("experience")}</dt>
                          <dd className="text-cs-secondary">{a.experience}</dd>
                        </div>
                      )}
                      {a.serviceAreas.length > 0 && (
                        <div className="sm:col-span-2">
                          <dt className="text-cs-faint">{t("serviceAreas")}</dt>
                          <dd className="text-cs-secondary">{a.serviceAreas.join(", ")}</dd>
                        </div>
                      )}
                    </dl>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* Reject modal — the backend requires a rejection reason (min 5 chars). */}
        <Modal
          open={rejecting !== null}
          onClose={() => setRejecting(null)}
          title={t("rejectAppTitle")}
          footer={
            <>
              <Button variant="secondary" size="sm" onClick={() => setRejecting(null)}>
                {t("cancel")}
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={reason.trim().length < 5 || busyId !== null}
                onClick={() => {
                  if (rejecting) void decide(rejecting, "REJECT", reason.trim());
                }}
              >
                {busyId ? t("applying") : t("confirmReject")}
              </Button>
            </>
          }
        >
          <p className="text-sm text-cs-secondary">{t("rejectHint")}</p>
          <div className="mt-3 w-full">
            <label htmlFor="rejection-reason" className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.06em] text-cs-secondary">
              {t("rejectionReason")}
            </label>
            <textarea
              id="rejection-reason"
              rows={3}
              maxLength={300}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="cs-input"
            />
          </div>
          {error && (
            <div className="mt-3">
              <ErrorNote message={error} />
            </div>
          )}
        </Modal>
      </div>
    </AppShell>
  );
}
