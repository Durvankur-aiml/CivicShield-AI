"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Button, EmptyState, ErrorNote, LoginPrompt, PageHeader, Skeleton } from "@/components/ui";
import { api, fetchMe, fmtAgo, fmtDateTime, type SessionUser } from "@/lib/client";
import { useLang } from "@/lib/i18n";
import {
  AlertTriangle,
  ArrowUpRight,
  Bell,
  BellOff,
  Check,
  CheckCheck,
  ClipboardCheck,
  Clock,
  HandCoins,
  RefreshCw,
  Repeat,
  ShieldAlert,
  Wrench,
  type LucideIcon,
} from "lucide-react";

/** PublicNotification shape — verified in src/lib/notificationDomain.ts. */
type PublicNotification = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  complaintId: string | null;
  assignmentId: string | null;
  readAt: string | null;
  createdAt: string;
};

type NotifResponse = { notifications: PublicNotification[]; unreadCount: number };

/** Backend notification type → lucide icon. Unknown types fall back to Bell. */
const TYPE_ICONS: Record<string, LucideIcon> = {
  ASSIGNMENT_OFFERED: HandCoins,
  ASSIGNMENT_REJECTED: ClipboardCheck,
  ASSIGNMENT_ACCEPTED: ClipboardCheck,
  ASSIGNMENT_STARTED: Wrench,
  ASSIGNMENT_COMPLETED: ClipboardCheck,
  OFFICIAL_OVERRIDE: ShieldAlert,
  SLA_WARNING: Clock,
  SLA_BREACH: AlertTriangle,
  ESCALATION: Repeat,
};

export default function NotificationsPage() {
  const { t } = useLang();
  const [me, setMe] = useState<SessionUser | null | undefined>(undefined);
  const [items, setItems] = useState<PublicNotification[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");

  const load = useCallback(async (only: boolean) => {
    setError("");
    setFeedback("");
    try {
      const res = await api<NotifResponse>(`/api/notifications?limit=50${only ? "&unread=true" : ""}`);
      setItems(res.notifications);
      setUnread(res.unreadCount);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    fetchMe().then((u) => {
      if (!alive) return;
      setMe(u);
      if (u) load(false);
    });
    return () => {
      alive = false;
    };
  }, [load]);

  async function markRead(id: string) {
    setBusyId(id);
    setError("");
    try {
      await api("/api/notifications", { body: { id } });
      setItems((prev) => (prev ? prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)) : prev));
      setUnread((u) => Math.max(0, u - 1));
      setFeedback(t("notifSynced"));
      window.dispatchEvent(new Event("cs:notifications-sync"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function markAllRead() {
    setError("");
    try {
      await api("/api/notifications", { body: { all: true } });
      setUnread(0);
      setFeedback(t("notifAllSynced"));
      window.dispatchEvent(new Event("cs:notifications-sync"));
      if (unreadOnly) {
        await load(true); // unread-only view is now genuinely empty
      } else {
        setItems((prev) => (prev ? prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })) : prev));
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function toggleUnreadOnly() {
    const next = !unreadOnly;
    setUnreadOnly(next);
    load(next);
  }

  if (me === undefined) {
    return (
      <AppShell>
        <div className="mx-auto max-w-3xl space-y-4">
          <Skeleton className="h-10 w-48" />
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      </AppShell>
    );
  }

  if (me === null) {
    return (
      <AppShell>
        <div className="mx-auto max-w-3xl space-y-4">
          <PageHeader title={t("notifTitle")} />
          <LoginPrompt />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-4">
        <PageHeader
          title={t("notifTitle")}
          actions={
            <>
              <Button
                variant={unreadOnly ? "primary" : "secondary"}
                size="sm"
                aria-pressed={unreadOnly}
                onClick={toggleUnreadOnly}
              >
                {t("filterUnread")}
                {unread > 0 && <span className="tnum">({unread})</span>}
              </Button>
              <Button variant="secondary" size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => load(unreadOnly)}>
                {t("refresh")}
              </Button>
              {unread > 0 && (
                <Button variant="secondary" size="sm" icon={<CheckCheck className="h-3.5 w-3.5" />} onClick={markAllRead}>
                  {t("markAllRead")}
                </Button>
              )}
            </>
          }
        />

        <div aria-live="polite">
          {error && <ErrorNote message={error} />}
          {feedback && !error && (
            <p role="status" className="cs-fade-up rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
              {feedback}
            </p>
          )}
        </div>

        {items === null && !error ? (
          [0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)
        ) : items !== null && items.length === 0 ? (
          <EmptyState
            icon={<BellOff className="h-5 w-5" />}
            title={unreadOnly ? t("updatesEmptyTitle") : t("notifEmpty")}
            hint={unreadOnly ? t("updatesEmptyHint") : t("notifEmptyHint")}
          />
        ) : (
          items !== null && (
            <ul className="space-y-2">
              {items.map((n) => {
                const Icon = TYPE_ICONS[n.type] ?? Bell;
                return (
                  <li key={n.id} className={`cs-card cs-fade-up p-4 transition-colors hover:border-blue-400/30 ${n.readAt ? "" : "border-blue-400/20"}`}>
                    <div className="flex items-start gap-3">
                      <span
                        className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-cs-border bg-cs-elevated text-blue-300"
                        aria-hidden
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className={`text-sm ${n.readAt ? "font-normal text-cs-secondary" : "font-semibold text-cs-text"}`}>{n.title}</p>
                          {!n.readAt && (
                            <span className="cs-badge border-blue-400/30 bg-blue-500/10 text-blue-300">
                              <span className="h-1.5 w-1.5 rounded-full bg-blue-400" aria-hidden />
                              {t("filterUnread")}
                            </span>
                          )}
                        </div>
                        {n.body && <p className="mt-1 text-sm text-cs-secondary">{n.body}</p>}
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-cs-faint">
                          <span title={fmtDateTime(n.createdAt)}>{fmtAgo(n.createdAt)}</span>
                          {n.complaintId && (
                            <Link
                              href={`/complaints/${n.complaintId}`}
                              className="inline-flex items-center gap-1 rounded-md text-blue-300 transition hover:text-blue-200"
                            >
                              {t("viewReport")}
                              <ArrowUpRight className="h-3 w-3" aria-hidden />
                            </Link>
                          )}
                          {!n.readAt && (
                            <button
                              onClick={() => markRead(n.id)}
                              disabled={busyId === n.id}
                              className="inline-flex items-center gap-1 rounded-md text-cs-secondary transition hover:text-cs-text disabled:opacity-50"
                            >
                              <Check className="h-3.5 w-3.5" aria-hidden />
                              {t("markRead")}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )
        )}
      </div>
    </AppShell>
  );
}
