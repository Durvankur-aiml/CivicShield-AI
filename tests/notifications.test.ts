import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePrismaMock, mockPrismaModule } from "./helpers/prisma-mock";

/**
 * Phase 3 — notification domain tests (unit, mocked Prisma).
 * Covers: idempotent event-key creation, ownership-scoped read state,
 * unread counts, and the public payload shape (privacy).
 */

const prisma = makePrismaMock();
mockPrismaModule(prisma);

const {
  send,
  sendMany,
  notificationKeys,
  listMyNotifications,
  unreadCountFor,
  markNotificationRead,
  markAllNotificationsRead,
} = await import("@/lib/notificationDomain");

/** The mock structurally satisfies the writer contract; cast once here. */
const db = prisma as unknown as import("@/lib/notificationDomain").NotificationWriter;

const WORKER = { id: "u_w", email: "w@x.test", name: "W", role: "WORKER" as const, departmentId: null };
const OTHER = { id: "u_o", email: "o@x.test", name: "O", role: "CITIZEN" as const, departmentId: null };

const notifRow = (over: Record<string, unknown> = {}) => ({
  id: "n1",
  recipientId: "u_w",
  type: "ASSIGNMENT_OFFERED",
  title: "New assignment: CS-2026-000001",
  body: "accept or reject",
  complaintId: "c1",
  assignmentId: "a1",
  dedupeKey: "k1",
  data: null,
  readAt: null,
  createdAt: new Date(),
  ...over,
});

function p2002(): Error & { code: string } {
  const err = new Error("Unique constraint failed on the constraint: `Notification_dedupeKey_key`") as Error & { code: string };
  err.code = "P2002";
  return err;
}

describe("idempotent notification creation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a notification with recipient, type, context, and event key", async () => {
    prisma.notification.create.mockResolvedValue({ id: "n_new" });
    const res = await send(db, {
      recipientId: "u_w",
      type: "ASSIGNMENT_OFFERED",
      title: "T",
      body: "B",
      complaintId: "c1",
      assignmentId: "a1",
      dedupeKey: notificationKeys.assignmentOffered("a1"),
    });
    expect(res.id).toBe("n_new");
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        recipientId: "u_w",
        type: "ASSIGNMENT_OFFERED",
        complaintId: "c1",
        assignmentId: "a1",
        dedupeKey: "assignment:offered:a1",
        data: null,
      }),
    });
  });

  it("a repeated event does NOT create a duplicate (P2002 on dedupeKey → silent skip)", async () => {
    prisma.notification.create.mockRejectedValue(p2002());
    const res = await send(db, {
      recipientId: "u_w", type: "SLA_WARNING", title: "T", dedupeKey: "sla:warning:a1",
    });
    expect(res.id).toBeNull();
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
  });

  it("non-deduplication errors propagate (real failures are not swallowed)", async () => {
    prisma.notification.create.mockRejectedValue(new Error("connection lost"));
    await expect(
      send(db, { recipientId: "u_w", type: "SYSTEM", title: "T" })
    ).rejects.toThrow("connection lost");
  });

  it("no dedupeKey (null) means always-create — citizen-facing messages are not deduped", async () => {
    prisma.notification.create.mockResolvedValue({ id: "n2" }).mockResolvedValueOnce({ id: "n1" });
    await send(db, { recipientId: "u_w", type: "SYSTEM", title: "1" });
    const res = await send(db, { recipientId: "u_w", type: "SYSTEM", title: "2" });
    expect(res.id).toBe("n2");
    expect(prisma.notification.create).toHaveBeenCalledTimes(2);
  });

  it("sendMany batches with skipDuplicates and reports the inserted count", async () => {
    prisma.notification.createMany.mockResolvedValue({ count: 2 });
    const n = await sendMany(db, [
      { recipientId: "u1", type: "SYSTEM", title: "a", dedupeKey: "k1" },
      { recipientId: "u2", type: "SYSTEM", title: "b", dedupeKey: "k2" },
    ]);
    expect(n).toBe(2);
    expect(prisma.notification.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true })
    );
  });

  it("sendMany falls back to sequential idempotent sends when createMany is unsupported", async () => {
    prisma.notification.createMany.mockRejectedValue(new Error("not supported"));
    prisma.notification.create
      .mockResolvedValueOnce({ id: "n1" })
      .mockRejectedValueOnce(p2002());
    const n = await sendMany(db, [
      { recipientId: "u1", type: "SYSTEM", title: "a", dedupeKey: "k1" },
      { recipientId: "u2", type: "SYSTEM", title: "b", dedupeKey: "k2" },
    ]);
    expect(n).toBe(1);
  });
});

describe("notification read lifecycle + ownership", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists only the current user's notifications with unread count", async () => {
    prisma.notification.findMany.mockResolvedValue([notifRow()]);
    prisma.notification.count.mockResolvedValue(1);
    const { notifications, unreadCount } = await listMyNotifications(WORKER);
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ recipientId: "u_w" }) })
    );
    expect(notifications).toHaveLength(1);
    expect(unreadCount).toBe(1);
    expect(notifications[0].createdAt).toBeTypeOf("string");
  });

  it("unread-only filter scopes both the list and the count", async () => {
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);
    await listMyNotifications(WORKER, { unreadOnly: true });
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ readAt: null }) })
    );
    expect(prisma.notification.count).toHaveBeenCalledWith({ where: { recipientId: "u_w", readAt: null } });
  });

  it("a user cannot mark another user's notification read (404 — no existence leak)", async () => {
    prisma.notification.findUnique.mockResolvedValue(notifRow({ recipientId: OTHER.id }));
    await expect(markNotificationRead(WORKER, "n1")).rejects.toMatchObject({ status: 404 });
  });

  it("an unknown notification id is also 404 (same error — nothing leaked)", async () => {
    prisma.notification.findUnique.mockResolvedValue(null);
    await expect(markNotificationRead(WORKER, "missing")).rejects.toMatchObject({ status: 404 });
  });

  it("mark read is idempotent — second call updates nothing", async () => {
    prisma.notification.findUnique.mockResolvedValue(notifRow({ readAt: new Date() }));
    const res = await markNotificationRead(WORKER, "n1");
    expect(res.ok).toBe(true);
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });

  it("mark read stamps readAt on the recipient's own notification", async () => {
    prisma.notification.findUnique.mockResolvedValue(notifRow());
    prisma.notification.update.mockResolvedValue({});
    await markNotificationRead(WORKER, "n1");
    expect(prisma.notification.update).toHaveBeenCalledWith({
      where: { id: "n1" },
      data: { readAt: expect.any(Date) },
    });
  });

  it("mark-all is scoped server-side to the current user's unread rows", async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 3 });
    const res = await markAllNotificationsRead(WORKER);
    expect(res.updated).toBe(3);
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { recipientId: "u_w", readAt: null },
      data: { readAt: expect.any(Date) },
    });
  });

  it("unreadCountFor counts only the current user's unread", async () => {
    prisma.notification.count.mockResolvedValue(7);
    expect(await unreadCountFor(WORKER)).toBe(7);
    expect(prisma.notification.count).toHaveBeenCalledWith({ where: { recipientId: "u_w", readAt: null } });
  });

  it("public payload exposes no contact data or internal metadata", () => {
    // toPublicNotification is exercised via listMyNotifications above; the
    // mapped shape is asserted here explicitly for the privacy contract.
    prisma.notification.findMany.mockResolvedValue([
      notifRow({ data: JSON.stringify({ internal: "secret" }) }),
    ]);
    prisma.notification.count.mockResolvedValue(0);
    return listMyNotifications(WORKER).then(({ notifications }) => {
      const keys = Object.keys(notifications[0]).sort();
      expect(keys).toEqual([
        "assignmentId", "body", "complaintId", "createdAt", "id", "readAt", "title", "type",
      ]);
      // data is never serialized out; recipient identity is implicit (it's mine).
      expect(JSON.stringify(notifications[0])).not.toContain("secret");
    });
  });
});

describe("deterministic event keys", () => {
  it("are stable per (event, scope) and unique across events", () => {
    expect(notificationKeys.assignmentOffered("a1")).toBe(notificationKeys.assignmentOffered("a1"));
    const keys = [
      notificationKeys.assignmentOffered("a1"),
      notificationKeys.assignmentAccepted("a1"),
      notificationKeys.assignmentRejected("a1"),
      notificationKeys.assignmentReassigned("a1"),
      notificationKeys.assignmentStarted("a1"),
      notificationKeys.assignmentCompleted("a1"),
      notificationKeys.officialOverride("a1"),
      notificationKeys.slaWarning("a1"),
      notificationKeys.slaBreach("a1"),
      notificationKeys.escalation("c1", 1),
      notificationKeys.escalation("c1", 2),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});
