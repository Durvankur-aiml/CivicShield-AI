import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { makePrismaMock, mockPrismaModule } from "./helpers/prisma-mock";

/**
 * Phase 4 — verification outcome state machine (route-level, mocked Prisma +
 * mocked verifier/auth boundaries). Proves the fail-safe policy: only VERIFIED
 * resolves; FAILED reopens/escalates (Phase 3 policy preserved);
 * INCONCLUSIVE/UNAVAILABLE HOLD at VERIFICATION with no approval and no
 * punishment.
 */

const prisma = makePrismaMock();
mockPrismaModule(prisma);

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireUser: vi.fn() };
});
vi.mock("@/lib/agent/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/tools")>();
  return { ...actual, verifyResolution: vi.fn(), escalateComplaint: vi.fn() };
});

const { POST } = await import("@/app/api/complaints/[id]/verify/route");
const { requireUser } = await import("@/lib/auth");
const { verifyResolution, escalateComplaint } = await import("@/lib/agent/tools");

const WORKER = { id: "u_worker", name: "Worker W", role: "WORKER", email: "w@example.com" };

const complaintRow = (over: Record<string, unknown> = {}) => ({
  id: "c1", refCode: "CS-2026-000123", category: "POTHOLE", severity: "MEDIUM",
  status: "IN_PROGRESS", assignedToId: "u_worker", reporterId: "u_citizen",
  reopenedCount: 0, photoKey: "report/2026-09-30/abc.jpg",
  ...over,
});

const jpegFile = (bytes: number[]) =>
  new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...bytes])], "after.jpg", { type: "image/jpeg" });

function buildRequest(): Request {
  const fd = new FormData();
  fd.set("afterImage", jpegFile([1, 2, 3]));
  return new Request("http://localhost/api/complaints/c1/verify", { method: "POST", body: fd });
}

const verdictOf = (over: Record<string, unknown>) => ({
  verified: false, confidence: 0.2, reason: "heuristic", provider: "dev:heuristic",
  confidenceKind: "HEURISTIC", ...over,
});

describe("verify route — explicit result states and fail-safe outcomes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireUser as Mock).mockResolvedValue(WORKER);
    prisma.complaint.findUnique.mockResolvedValue(complaintRow());
    prisma.complaint.update.mockImplementation(async ({ data }: { data: { status?: string } }) => ({
      status: data.status ?? "VERIFICATION",
    }));
    prisma.timelineEvent.create.mockResolvedValue({});
    prisma.agentActivity.create.mockResolvedValue({});
    prisma.user.update.mockResolvedValue({});
    prisma.notification.create.mockResolvedValue({ id: "n1" });
    prisma.storedFile.findUnique.mockResolvedValue({
      key: "report/2026-09-30/abc.jpg", mime: "image/jpeg",
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]),
      size: 7, createdAt: new Date(),
    });
  });

  it("VERIFIED resolves the case, stores verificationResult, rewards karma", async () => {
    (verifyResolution as Mock).mockResolvedValue(verdictOf({ verified: true, confidence: 0.9, verificationResult: "VERIFIED" }));
    const res = await POST(buildRequest(), { params: Promise.resolve({ id: "c1" }) });
    const body = await res.json();
    expect(body.verdict.verificationResult).toBe("VERIFIED");
    expect(body.status).toBe("RESOLVED");
    const update = prisma.complaint.update.mock.calls.at(-1)![0].data;
    expect(update).toMatchObject({ status: "RESOLVED", verificationResult: "VERIFIED", verified: true });
  });

  it("FAILED reopens the case with verificationResult FAILED (no resolution)", async () => {
    (verifyResolution as Mock).mockResolvedValue(verdictOf({ verificationResult: "FAILED" }));
    const res = await POST(buildRequest(), { params: Promise.resolve({ id: "c1" }) });
    const body = await res.json();
    expect(body.status).toBe("REOPENED");
    const update = prisma.complaint.update.mock.calls.at(-1)![0].data;
    expect(update).toMatchObject({ status: "REOPENED", verificationResult: "FAILED", verified: false });
  });

  it("FAILED does not escalate on first failure at MEDIUM severity (Phase 3 policy)", async () => {
    (verifyResolution as Mock).mockResolvedValue(verdictOf({ verificationResult: "FAILED" }));
    await POST(buildRequest(), { params: Promise.resolve({ id: "c1" }) });
    expect(escalateComplaint).not.toHaveBeenCalled();
  });

  it("FAILED escalates when reopenedCount ≥ 2 (Phase 3 policy preserved)", async () => {
    prisma.complaint.findUnique.mockResolvedValue(complaintRow({ reopenedCount: 2 }));
    (verifyResolution as Mock).mockResolvedValue(verdictOf({ verificationResult: "FAILED" }));
    (escalateComplaint as Mock).mockResolvedValue({ status: "ESCALATED", escalationCount: 1 });
    const res = await POST(buildRequest(), { params: Promise.resolve({ id: "c1" }) });
    const body = await res.json();
    expect(body.status).toBe("ESCALATED");
    expect(escalateComplaint).toHaveBeenCalledTimes(1);
  });

  it("INCONCLUSIVE HOLDS at VERIFICATION — no reopen, no resolve, no escalation", async () => {
    (verifyResolution as Mock).mockResolvedValue(verdictOf({ verified: false, confidence: 0, verificationResult: "INCONCLUSIVE" }));
    const res = await POST(buildRequest(), { params: Promise.resolve({ id: "c1" }) });
    const body = await res.json();
    expect(body.status).toBe("VERIFICATION");
    const update = prisma.complaint.update.mock.calls.at(-1)![0].data;
    expect(update).toMatchObject({ verificationResult: "INCONCLUSIVE", verified: false });
    expect(update.status).toBeUndefined(); // status untouched — case held
    expect(escalateComplaint).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled(); // no karma on hold
  });

  it("UNAVAILABLE HOLDS at VERIFICATION — verifier failure never auto-approves", async () => {
    (verifyResolution as Mock).mockResolvedValue({
      verified: false, confidence: 0, reason: "verifier down", provider: "unavailable",
      verificationResult: "UNAVAILABLE", confidenceKind: "UNKNOWN",
    });
    const res = await POST(buildRequest(), { params: Promise.resolve({ id: "c1" }) });
    const body = await res.json();
    expect(body.status).toBe("VERIFICATION");
    expect(body.verdict.verificationResult).toBe("UNAVAILABLE");
    const update = prisma.complaint.update.mock.calls.at(-1)![0].data;
    expect(update.verificationResult).toBe("UNAVAILABLE");
    expect(update.status).toBeUndefined();
  });

  it("the BEFORE image bytes from storage reach the verifier (evidence path intact)", async () => {
    (verifyResolution as Mock).mockResolvedValue(verdictOf({ verificationResult: "INCONCLUSIVE", confidence: 0 }));
    await POST(buildRequest(), { params: Promise.resolve({ id: "c1" }) });
    const call = (verifyResolution as Mock).mock.calls[0][0];
    expect(call.beforeImage).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]));
    expect(call.beforeMime).toBe("image/jpeg");
    expect(Buffer.isBuffer(call.afterImage)).toBe(true);
  });

  it("audit activity never contains raw image bytes (B12)", async () => {
    (verifyResolution as Mock).mockResolvedValue(verdictOf({ verified: true, confidence: 0.9, verificationResult: "VERIFIED" }));
    await POST(buildRequest(), { params: Promise.resolve({ id: "c1" }) });
    for (const call of prisma.agentActivity.create.mock.calls) {
      const detail = call[0].data.detail;
      if (detail) {
        expect(detail).not.toContain("0xff");
        expect(detail.length).toBeLessThan(2000);
      }
    }
  });

  it("legacy boolean-only verdicts are mapped by the fail-safe derivation", async () => {
    (verifyResolution as Mock).mockResolvedValue({ verified: false, confidence: 0.3, reason: "still visible", provider: "dev:heuristic" });
    const res = await POST(buildRequest(), { params: Promise.resolve({ id: "c1" }) });
    const body = await res.json();
    expect(body.verdict.verificationResult).toBe("FAILED");
  });

  it("rejects a non-image AFTER payload renamed to .jpg (magic bytes enforced)", async () => {
    const fd = new FormData();
    fd.set("afterImage", new File([new TextEncoder().encode("<html>fak</html>")], "after.jpg", { type: "image/jpeg" }));
    const res = await POST(
      new Request("http://localhost/api/complaints/c1/verify", { method: "POST", body: fd }),
      { params: Promise.resolve({ id: "c1" }) }
    );
    expect(res.status).toBe(400);
  });
});
