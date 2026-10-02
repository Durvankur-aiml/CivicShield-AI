"use client";

import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Button, EmptyState, ErrorNote, LoginPrompt, Modal, PageHeader, SectionHeading, Skeleton, TableHead, TableShell, TableStateRow, Textarea } from "@/components/ui";
import { api, fetchMe, fmtDateTime, homeForRole, type SessionUser } from "@/lib/client";
import { departmentLabel } from "@/lib/constants";
import { useLang } from "@/lib/i18n";
import { BadgeCheck, ClipboardList, RefreshCw, X } from "lucide-react";

/** PublicOfficialApplication + applicant block — verified in officialDomain.ts. */
type ApplicationRow = {
  id: string;
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
  applicant: { id: string; name: string; email: string; image: string | null };
};

/** PublicOfficialProfile + user linkage — verified in officialDomain.ts. */
type OfficialRow = {
  userId: string;
  userName: string;
  userEmail: string;
  officialId: string;
  departmentCode: string;
  departmentName: string;
  designation: string | null;
  municipality: string;
  serviceAreas: string[];
  approvedAt: string;
};

export default function AdminOfficialApplicationsPage() {
  const { t } = useLang();
  const [me, setMe] = useState<SessionUser | null | undefined>(undefined);
  const [profiles, setProfiles] = useState<OfficialRow[] | null>(null);
  const [apps, setApps] = useState<ApplicationRow[] | null>(null);
  const [tab, setTab] = useState<"applications" | "officials">("applications");
  const [rejecting, setRejecting] = useState<ApplicationRow | null>(null);
  const [reason, setReason] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setError("");
    const d = await api<{ applications: ApplicationRow[]; profiles: OfficialRow[] }>("/api/admin/official-applications").catch(() => null);
    if (d) {
      setApps(d.applications);
      setProfiles(d.profiles);
    } else {
      setError(t("loadFailed"));
    }
  }, [t]);

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
      load();
    });
    return () => {
      alive = false;
      setNotice(""); // drop the success notice when leaving the page
    };
  }, [load]);

  /** Approve/reject with the exact backend body; refreshes after mutation. */
  async function decide(app: ApplicationRow, decision: "APPROVE" | "REJECT", rejectionReason?: string) {
    setBusyId(app.id);
    setError("");
    try {
      await api("/api/admin/official-applications/review", {
        body: { applicationId: app.id, decision, ...(decision === "REJECT" ? { rejectionReason } : {}) },
      });
      setNotice(decision === "APPROVE" ? t("officialApprovedOk") : t("officialRejectedOk"));
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
          <PageHeader title={t("adminApplicationsNav")} />
          <LoginPrompt />
        </div>
      </AppShell>
    );
  }

  const pendingCount = apps?.length ?? 0;
  const officials = profiles ?? [];

  return (
    <AppShell>
      <div className="mx-auto max-w-6xl space-y-4">
        <PageHeader
          title={t("adminApplicationsNav")}
          subtitle={t("adminReviewSub")}
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

        <div role="tablist" aria-label={t("adminApplicationsNav")} className="flex flex-wrap gap-2">
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
          <button
            role="tab"
            aria-selected={tab === "officials"}
            onClick={() => setTab("officials")}
            className={`cs-badge border px-3 py-1.5 text-xs font-semibold transition ${
              tab === "officials" ? "border-blue-400/40 bg-blue-500/15 text-blue-200" : "border-cs-border bg-cs-elevated text-cs-secondary hover:text-cs-text"
            }`}
          >
            <BadgeCheck className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />
            {t("adminVerifiedOfficials")} ({officials.length})
          </button>
        </div>

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
                        <p className="mt-0.5 font-mono text-xs text-cs-secondary">
                          {t("municipalEmployeeId")}: {a.employeeId} · {t("department")}: {a.departmentCode ? departmentLabel(a.departmentCode) : "—"} · {t("municipality")}: {a.municipality}
                        </p>
                        {(a.designation || a.serviceAreas.length > 0) && (
                          <p className="mt-0.5 text-xs text-cs-secondary">
                            {a.designation ? `${t("designation")}: ${a.designation}` : ""}
                            {a.designation && a.serviceAreas.length > 0 ? " · " : ""}
                            {a.serviceAreas.length > 0 ? `${t("serviceAreas")}: ${a.serviceAreas.join(", ")}` : ""}
                          </p>
                        )}
                        {a.experience && <p className="mt-0.5 max-w-2xl text-xs text-cs-faint">{a.experience}</p>}
                        {a.applicationDetails && <p className="mt-0.5 max-w-2xl text-xs text-cs-faint">{a.applicationDetails}</p>}
                        <p className="mt-1 text-[11px] text-cs-faint">{fmtDateTime(a.createdAt)}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button size="sm" disabled={busyId === a.id} onClick={() => decide(a, "APPROVE")}>
                          {t("approve")}
                        </Button>
                        <Button variant="danger" size="sm" icon={<X className="h-3.5 w-3.5" />} disabled={busyId === a.id} onClick={() => setRejecting(a)}>
                          {t("reject")}
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {tab === "officials" && (
          <section>
            <SectionHeading title={t("adminVerifiedOfficials")} hint={t("adminRegistryHint")} />
            <TableShell>
              <TableHead columns={[t("thWorker"), t("officialIdLabel"), t("department"), t("designation"), t("municipality"), t("serviceAreas"), t("approvedOn")]} />
              <tbody>
                <TableStateRow
                  colSpan={7}
                  loading={profiles === null}
                  error={error && profiles === null ? error : ""}
                  empty={profiles !== null && officials.length === 0 ? t("noVerifiedOfficials") : ""}
                />
                {profiles !== null &&
                  officials.map((p) => (
                    <tr key={p.userId} className="border-b border-cs-border/60">
                      <td className="px-4 py-3 font-medium text-cs-text">
                        {p.userName}
                        <span className="ml-1.5 text-xs text-cs-faint">{p.userEmail}</span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-emerald-300">{p.officialId}</td>
                      <td className="px-4 py-3 text-cs-secondary">{p.departmentCode ? departmentLabel(p.departmentCode) : "—"}</td>
                      <td className="px-4 py-3 text-cs-secondary">{p.designation ?? "—"}</td>
                      <td className="px-4 py-3 text-cs-secondary">{p.municipality}</td>
                      <td className="max-w-56 truncate px-4 py-3 text-xs text-cs-secondary" title={p.serviceAreas.join(", ")}>
                        {p.serviceAreas.length ? p.serviceAreas.join(", ") : t("none")}
                      </td>
                      <td className="px-4 py-3 text-xs text-cs-secondary">{fmtDateTime(p.approvedAt)}</td>
                    </tr>
                  ))}
              </tbody>
            </TableShell>
          </section>
        )}
      </div>

      {/* Reject modal — reason is REQUIRED (min 5 chars, mirrors server rule). */}
      <Modal
        open={rejecting !== null}
        onClose={() => {
          setRejecting(null);
          setReason("");
        }}
        title={t("officialRejectTitle")}
      >
        {rejecting && (
          <div className="space-y-3">
            <p className="text-sm text-cs-secondary">
              {rejecting.applicant.name} · <span className="font-mono">{rejecting.employeeId}</span>
            </p>
            <p className="text-xs text-cs-secondary">{t("rejectHint")}</p>
            <Textarea label={t("rejectionReason")} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={300} />
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <Button
                variant="secondary"
                onClick={() => {
                  setRejecting(null);
                  setReason("");
                }}
              >
                {t("cancel")}
              </Button>
              <Button variant="danger" disabled={busyId === rejecting.id || reason.trim().length < 5} onClick={() => decide(rejecting, "REJECT", reason.trim())}>
                {busyId === rejecting.id ? t("applying") : t("confirmRejectAction")}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </AppShell>
  );
}
