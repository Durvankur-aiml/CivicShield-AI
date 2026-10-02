import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { makePrismaMock, mockPrismaModule } from "./helpers/prisma-mock";

/**
 * Citizen delete-before-assignment (B4/B6) — route-level, mocked Prisma +
 * mocked auth/storage boundaries. Proves the authorization rules (owner +
 * RECEIVED + no assignment, decided on CURRENT DB state), the race-safe
 * conditional delete, and the best-effort photo cleanup.
 *
 * NOTE on related data: the handler intentionally creates/deletes NO child
 * records itself — timeline events, agent activities, escalations and
 * notifications are removed by the schema's ON DELETE CASCADE and the
 * duplicateOf self-relation by ON DELETE SET NULL. A mocked Prisma client
 * cannot prove database FK actions; that remains the job of a live-DB smoke
 * run (see tests/helpers/prisma-mock.ts header). What CAN be proven here is
 * that the handler never leaves orphans of its own making.
 */

const prisma = makePrismaMock();
mockPrismaModule(prisma);

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireUser: vi.fn() };
});
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, deleteImage: vi.fn() };
});

const { DELETE } = await import("@/app/api/complaints/[id]/route");
const { requireUser, ApiError } = await import("@/lib/auth");
const { deleteImage } = await import("@/lib/storage");

const CITIZEN = { id: "u_citizen", name: "Citizen C", role: "CITIZEN", email: "c@example.com" };

const complaintRow = (over: Record<string, unknown> = {}) => ({
  id: "c1", reporterId: "u_citizen", status: "RECEIVED",
  activeAssignmentId: null, assignedToId: null,
  photoKey: "report/2026-10-02/abc.jpg",
  ...over,
});

/** The eligibility guard the handler must re-check at WRITE time. */
const GUARD_WHERE = {
  id: "c1", reporterId: "u_citizen", status: "RECEIVED",
  activeAssignmentId: null, assignedToId: null,
};

function del(id = "c1"): Promise<Response> {
  return DELETE(new Request(`http://localhost/api/complaints/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}

describe("DELETE /api/complaints/[id] — citizen deletes own unassigned report", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireUser as Mock).mockResolvedValue(CITIZEN);
    (deleteImage as Mock).mockResolvedValue(true);
    prisma.complaint.findUnique.mockResolvedValue(complaintRow());
    prisma.complaint.deleteMany.mockResolvedValue({ count: 1 });
  });

  it("deletes own unassigned complaint: 200 ok, guard where-clause, photo cleanup", async () => {
    const res = await del();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(prisma.complaint.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.complaint.deleteMany.mock.calls[0][0].where).toEqual(GUARD_WHERE);
    expect(deleteImage).toHaveBeenCalledWith("report/2026-10-02/abc.jpg");
  });

  it("rejects deletion of ANOTHER user's complaint (403, nothing deleted)", async () => {
    prisma.complaint.findUnique.mockResolvedValue(complaintRow({ reporterId: "u_other" }));
    const res = await del();
    expect(res.status).toBe(403);
    expect(prisma.complaint.deleteMany).not.toHaveBeenCalled();
    expect(deleteImage).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests (401)", async () => {
    (requireUser as Mock).mockRejectedValue(new ApiError(401, "Authentication required"));
    const res = await del();
    expect(res.status).toBe(401);
    expect(prisma.complaint.deleteMany).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing (or already deleted) complaint", async () => {
    prisma.complaint.findUnique.mockResolvedValue(null);
    const res = await del();
    expect(res.status).toBe(404);
    expect(prisma.complaint.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects a complaint with an ACTIVE assignment (409, 'assigned' message)", async () => {
    prisma.complaint.findUnique.mockResolvedValue(
      complaintRow({ activeAssignmentId: "a1", status: "ASSIGNED", assignedToId: "u_worker" })
    );
    const res = await del();
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toMatch(/assigned/i);
    expect(prisma.complaint.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects when an assignment EVER existed (assignedToId set, none active)", async () => {
    prisma.complaint.findUnique.mockResolvedValue(
      complaintRow({ activeAssignmentId: null, assignedToId: "u_worker", status: "VERIFICATION" })
    );
    const res = await del();
    expect(res.status).toBe(409);
    expect(prisma.complaint.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects a RESOLVED complaint (409, status in message)", async () => {
    prisma.complaint.findUnique.mockResolvedValue(complaintRow({ status: "RESOLVED" }));
    const res = await del();
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toMatch(/RESOLVED/);
    expect(prisma.complaint.deleteMany).not.toHaveBeenCalled();
  });

  it("STALE-UI RACE: row read as eligible but write-time re-check matches nothing → 409, complaint survives", async () => {
    // The browser showed the report as deletable; an assignment transaction
    // committed between the read and the deleteMany, so the conditional
    // where-clause (status/assignment guard) matches zero rows.
    prisma.complaint.deleteMany.mockResolvedValue({ count: 0 });
    const res = await del();
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toMatch(/no longer/i);
    expect(prisma.complaint.deleteMany.mock.calls[0][0].where).toEqual(GUARD_WHERE);
    expect(deleteImage).not.toHaveBeenCalled(); // nothing was deleted
  });

  it("duplicate delete is safe: the second request 404s instead of crashing", async () => {
    const first = await del();
    expect(first.status).toBe(200);
    // Second click after the row is gone: findUnique finds nothing.
    prisma.complaint.findUnique.mockResolvedValue(null);
    const second = await del();
    expect(second.status).toBe(404);
    expect(prisma.complaint.deleteMany).toHaveBeenCalledTimes(1); // never re-deleted
  });

  it("photo cleanup is BEST-EFFORT: a storage failure never blocks the deletion", async () => {
    (deleteImage as Mock).mockRejectedValue(new Error("storage down"));
    const res = await del();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("no photo → no cleanup call; handler creates NO child records (cascade is the schema's job)", async () => {
    prisma.complaint.findUnique.mockResolvedValue(complaintRow({ photoKey: null }));
    const res = await del();
    expect(res.status).toBe(200);
    expect(deleteImage).not.toHaveBeenCalled();
    // The handler must not fabricate its own cleanup/orphan records —
    // timeline/notification handling belongs to the DB FK actions.
    expect(prisma.timelineEvent.create).not.toHaveBeenCalled();
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(prisma.agentActivity.create).not.toHaveBeenCalled();
  });
});
