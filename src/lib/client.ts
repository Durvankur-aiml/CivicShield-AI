"use client";

/** Small typed fetch wrapper with cookie auth + uniform error surfacing. */
export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; formData?: FormData } = {}
): Promise<T> {
  const init: RequestInit = { method: opts.method ?? (opts.body || opts.formData ? "POST" : "GET") };
  if (opts.formData) {
    init.body = opts.formData;
  } else if (opts.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { ...init, credentials: "include" });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; issues?: Array<{ path: string; message: string }> };
  if (!res.ok) {
    const detail = data.issues?.map((i) => `${i.path}: ${i.message}`).join(", ");
    throw new Error(detail || data.error || `Request failed (${res.status})`);
  }
  return data;
}

export type SessionUser = { id: string; name: string; email: string; role: "CITIZEN" | "WORKER" | "OFFICIAL" };
export async function fetchMe(): Promise<SessionUser | null> {
  try {
    const { user } = await api<{ user: SessionUser }>("/api/auth/me");
    return user;
  } catch {
    return null;
  }
}

export function fmtDateTime(d: string | Date | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function fmtAgo(d: string | Date | null | undefined) {
  if (!d) return "";
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Countdown for FUTURE deadlines ("4h left") — fmtAgo is for past events. */
export function fmtCountdown(d: string | Date | null | undefined) {
  if (!d) return "—";
  const s = Math.floor((new Date(d).getTime() - Date.now()) / 1000);
  if (s <= 0) return "breached";
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m left`;
  if (s < 86400) return `${Math.floor(s / 3600)}h left`;
  return `${Math.floor(s / 86400)}d left`;
}
