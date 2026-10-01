"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Bell, FolderOpen, LogOut, Plus, Radar, TrendingUp, Wrench, IdCard, UserPlus, Users, type LucideIcon } from "lucide-react";
import { fetchMe, api, type SessionUser } from "@/lib/client";
import { LANGS, useLang } from "@/lib/i18n";
import { Logo } from "./Logo";
import { getFirebaseAuth } from "@/lib/firebase";
import { signOut } from "firebase/auth";

type NavItem = { href: string; label: string; labelKey?: string; icon: LucideIcon };

const NAV: Record<SessionUser["role"], NavItem[]> = {
  CITIZEN: [
    { href: "/citizen/submit", label: "Report", icon: Plus },
    { href: "/citizen", label: "My Reports", icon: FolderOpen },
    { href: "/worker/apply", label: "Apply as worker", labelKey: "applyNav", icon: UserPlus },
  ],
  OFFICIAL: [
    { href: "/official", label: "Command Center", icon: Radar },
    { href: "/official/analytics", label: "Civic intelligence", labelKey: "analyticsNav", icon: TrendingUp },
    { href: "/official/workers", label: "Workers", labelKey: "workersNav", icon: Users },
  ],
  WORKER: [
    { href: "/worker", label: "My Tasks", icon: Wrench },
    { href: "/worker/profile", label: "Profile", labelKey: "profileNav", icon: IdCard },
  ],
};

/** Role-aware navigation shell: glass top bar + mobile bottom tab bar. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [unread, setUnread] = useState(0);
  const [badgeTick, setBadgeTick] = useState(0);
  const { lang, setLang, t } = useLang();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    fetchMe().then((u) => {
      if (!alive) return;
      setMe(u);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Notification badge — the API's real unreadCount, re-synced on route change
  // and when the notifications page dispatches cs:notifications-sync after a
  // mark-read mutation. No polling and no client-side fabrication.
  useEffect(() => {
    if (!me) return;
    let alive = true;
    api<{ unreadCount: number }>("/api/notifications?limit=1")
      .then((r) => {
        if (alive) setUnread(r.unreadCount);
      })
      .catch(() => {});
    const sync = () => setBadgeTick((v) => v + 1);
    window.addEventListener("cs:notifications-sync", sync);
    return () => {
      alive = false;
      window.removeEventListener("cs:notifications-sync", sync);
    };
  }, [me, pathname, badgeTick]);

  async function logout() {
    // Sign out of both layers: Firebase (browser) + our session cookie (server).
    await signOut(getFirebaseAuth()).catch(() => {});
    await api("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const items = (me ? NAV[me.role] : []).map((n) => ({ ...n, label: n.labelKey ? t(n.labelKey) : n.label }));

  /** Longest-matching nav entry wins, so /official/analytics doesn't light up /official too. */
  const isActive = (href: string) => {
    if (!(pathname === href || (href !== "/" && pathname.startsWith(href)))) return false;
    return !items.some((m) => m.href !== href && m.href.length > href.length && (pathname === m.href || pathname.startsWith(m.href)));
  };

  return (
    <div className="flex min-h-screen flex-col">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b border-cs-border bg-cs-bg/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:px-6">
          <Link href="/" aria-label="CivicShield AI home" className="rounded-md">
            <Logo />
          </Link>

          {/* Desktop nav */}
          <nav className="ml-6 hidden flex-1 items-center gap-1 sm:flex" aria-label="Primary">
            {items.map((n) => {
              const active = isActive(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={active ? "page" : undefined}
                  className={`group flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition ${
                    active ? "bg-blue-500/15 font-medium text-blue-300" : "text-cs-secondary hover:bg-white/5 hover:text-cs-text"
                  }`}
                >
                  <n.icon className="h-4 w-4 transition-transform duration-150 group-hover:scale-110" aria-hidden />
                  {n.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <select
              aria-label="Language"
              value={lang}
              onChange={(e) => setLang(e.target.value as typeof lang)}
              className="hidden rounded-lg border border-cs-border bg-cs-elevated px-2 py-1.5 text-xs text-cs-text sm:block"
            >
              {LANGS.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>

            {!loading && me && (
              <Link
                href="/notifications"
                aria-label={`${t("notifTitle")}${unread > 0 ? ` — ${unread} ${t("filterUnread")}` : ""}`}
                className="relative grid h-9 w-9 place-items-center rounded-lg text-cs-secondary transition hover:bg-white/5 hover:text-cs-text"
              >
                <Bell className="h-[18px] w-[18px]" aria-hidden />
                {unread > 0 && (
                  <span
                    className="tnum absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-blue-500 px-1 text-[10px] font-bold text-white"
                    aria-hidden
                  >
                    {unread > 9 ? "9+" : unread}
                  </span>
                )}
              </Link>
            )}

            {loading ? null : me ? (
              <div className="flex items-center gap-2">
                <span className="hidden items-center gap-2 text-sm text-cs-secondary md:flex">
                  <span className="grid h-7 w-7 place-items-center rounded-full border border-cs-border bg-cs-elevated text-xs font-semibold text-blue-300" aria-hidden>
                    {me.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="max-w-28 truncate">{me.name}</span>
                  <span className="rounded-md border border-cs-border bg-cs-elevated px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-cs-secondary">
                    {me.role.toLowerCase()}
                  </span>
                </span>
                <button onClick={logout} className="cs-btn cs-btn-secondary px-3! py-1.5! text-xs!">
                  <LogOut className="h-3.5 w-3.5" aria-hidden />
                  {t("logout")}
                </button>
              </div>
            ) : (
              <Link href="/login" className="cs-btn cs-btn-primary px-3.5! py-1.5! text-xs!">
                {t("login")}
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 pb-24 sm:px-6 sm:pb-8">{children}</main>

      {/* Mobile bottom nav */}
      {me && items.length > 0 && (
        <nav
          aria-label="Primary mobile"
          className="fixed inset-x-0 bottom-0 z-40 border-t border-cs-border bg-cs-bg/90 backdrop-blur-md sm:hidden"
        >
          <div className="mx-auto flex max-w-md items-stretch justify-around px-2 py-1.5">
            {items.map((n) => {
              const active = isActive(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-w-20 flex-col items-center gap-1 rounded-lg px-3 py-1.5 text-[11px] transition ${
                    active ? "text-blue-300" : "text-cs-secondary"
                  }`}
                >
                  <n.icon className={`h-4.5 w-4.5 ${active ? "scale-110" : ""} transition-transform`} aria-hidden />
                  {n.label}
                </Link>
              );
            })}
          </div>
        </nav>
      )}

      <footer className="border-t border-cs-border px-4 py-5 text-center text-xs text-cs-faint">
        CivicShield AI — original hackathon build. Secure Google sign-in.
      </footer>
    </div>
  );
}
