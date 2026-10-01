import { prisma } from "./db";
import { ApiError, type SessionUser } from "./auth";

/**
 * In-app notification domain (Phase 3).
 *
 * ARCHITECTURE (separation of concerns):
 *   Assignment  → operational state
 *   Notification → message delivered to a recipient
 *   SLA state   → derived from timestamps (slaDomain.ts)
 *   AgentActivity → audit/history
 * These are deliberately separate concepts and separate storage.
 *
 * PROVIDER BOUNDARY: notifications are IN-APP ONLY (rows in the Notification
 * table, delivered via the worker/official notification APIs). There is NO
 * email, SMS, or push provider in this repository — none is implemented and
 * none is faked. The send() indirection below is the seam where future
 * providers would attach; it is intentionally minimal.
 *
 * IDEMPOTENCY: every event-scoped notification carries a deterministic
 * dedupeKey enforced by a database UNIQUE constraint. Retried actions and
 * repeated cron sweeps cannot create duplicates — the winner inserts, every
 * other attempt is a no-op. Notifications without a natural event key use
 * dedupeKey: null and are always created (e.g. citizen-facing messages).
 */

/** Deterministic event keys — one key per (event, scope) pair. */
export const notificationKeys = {
  assignmentOffered: (assignmentId: string) => `assignment:offered:${assignmentId}`,
  assignmentAccepted: (assignmentId: string) => `assignment:accepted:${assignmentId}`,
  assignmentRejected: (assignmentId: string) => `assignment:rejected:${assignmentId}`,
  assignmentReassigned: (assignmentId: string) => `assignment:reassigned:${assignmentId}`,
  assignmentStarted: (assignmentId: string) => `assignment:started:${assignmentId}`,
  assignmentCompleted: (assignmentId: string) => `assignment:completed:${assignmentId}`,
  officialOverride: (assignmentId: string) => `assignment:override:${assignmentId}`,
  slaWarning: (assignmentId: string) => `sla:warning:${assignmentId}`,
  slaBreach: (assignmentId: string) => `sla:breach:${assignmentId}`,
  escalation: (complaintId: string, level: number) => `escalation:${complaintId}:${level}`,
} as const;

/**
 * Prisma transaction client type (interactive $transaction callback arg) —
 * covers both the global client and tx clients, so notification writes can be
 * coupled to domain transactions. Test mocks are cast at the test boundary.
 */
type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
/** Anything that can create notifications: the global client or a tx client. */
export type NotificationWriter = TxClient;

type SendInput = {
  recipientId: string;
  type: string;
  title: string;
  body?: string;
  complaintId?: string | null;
  assignmentId?: string | null;
  dedupeKey?: string | null;
  data?: unknown;
};

/**
 * Create one in-app notification. Duplicate-key safe: when dedupeKey already
 * exists, the insert is skipped silently (idempotent by design). Safe to call
 * inside transactions (pass the tx client) — atomicity is the caller's.
 */
export async function send(db: NotificationWriter, n: SendInput): Promise<{ id: string | null }> {
  try {
    const created = await db.notification.create({
      data: {
        recipientId: n.recipientId,
        type: n.type,
        title: n.title,
        body: n.body ?? null,
        complaintId: n.complaintId ?? null,
        assignmentId: n.assignmentId ?? null,
        dedupeKey: n.dedupeKey ?? null,
        data: n.data != null ? JSON.stringify(n.data) : null,
      },
    });
    return { id: created.id };
  } catch (err) {
    if (isP2002(err)) return { id: null }; // duplicate event → already delivered
    throw err;
  }
}

function isP2002(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "P2002" || /unique constraint|duplicate key/i.test(e?.message ?? "");
}

/**
 * sendMany — batch idempotent creation for sweeps (e.g. all workers eligible
 * for escalation review). Uses createMany + skipDuplicates, falling back to
 * sequential send() on engines without skipDuplicates support. Never throws
 * on duplicates.
 */
export async function sendMany(db: NotificationWriter, items: SendInput[]): Promise<number> {
  if (items.length === 0) return 0;
  const rows = items.map((n) => ({
    recipientId: n.recipientId,
    type: n.type,
    title: n.title,
    body: n.body ?? null,
    complaintId: n.complaintId ?? null,
    assignmentId: n.assignmentId ?? null,
    dedupeKey: n.dedupeKey ?? null,
    data: n.data != null ? JSON.stringify(n.data) : null,
  }));
  try {
    const res = await db.notification.createMany({ data: rows, skipDuplicates: true });
    return res.count;
  } catch {
    // Fallback (mock clients / older engines): sequential idempotent sends.
    let count = 0;
    for (const n of items) {
      const r = await send(db, n);
      if (r.id != null) count += 1;
    }
    return count;
  }
}

/** Shape returned to clients — no contact data, no internal ids beyond context. */
export type PublicNotification = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  complaintId: string | null;
  assignmentId: string | null;
  readAt: string | null;
  createdAt: string;
};

export function toPublicNotification(n: {
  id: string;
  type: string;
  title: string;
  body: string | null;
  complaintId: string | null;
  assignmentId: string | null;
  readAt: Date | null;
  createdAt: Date;
}): PublicNotification {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    complaintId: n.complaintId,
    assignmentId: n.assignmentId,
    readAt: n.readAt ? n.readAt.toISOString() : null,
    createdAt: n.createdAt.toISOString(),
  };
}

/** List the CURRENT user's notifications (server identity is authoritative). */
export async function listMyNotifications(
  user: SessionUser,
  opts: { unreadOnly?: boolean; limit?: number } = {}
): Promise<{ notifications: PublicNotification[]; unreadCount: number }> {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 100);
  const [rows, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { recipientId: user.id, ...(opts.unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    unreadCountFor(user),
  ]);
  return { notifications: rows.map(toPublicNotification), unreadCount };
}

export async function unreadCountFor(user: SessionUser): Promise<number> {
  return prisma.notification.count({ where: { recipientId: user.id, readAt: null } });
}

/**
 * Mark ONE notification read — only the recipient may do this (403/404 for
 * everyone else; existence of another user's notification is not leaked).
 */
export async function markNotificationRead(user: SessionUser, notificationId: string): Promise<{ ok: true }> {
  const n = await prisma.notification.findUnique({ where: { id: notificationId } });
  if (!n || n.recipientId !== user.id) throw new ApiError(404, "Notification not found");
  if (n.readAt) return { ok: true }; // idempotent
  await prisma.notification.update({ where: { id: n.id }, data: { readAt: new Date() } });
  return { ok: true };
}

/**
 * Mark all of the CURRENT user's notifications read (idempotent — a second
 * call updates nothing). updateMany is scoped by recipientId server-side.
 */
export async function markAllNotificationsRead(user: SessionUser): Promise<{ updated: number }> {
  const res = await prisma.notification.updateMany({
    where: { recipientId: user.id, readAt: null },
    data: { readAt: new Date() },
  });
  return { updated: res.count };
}
