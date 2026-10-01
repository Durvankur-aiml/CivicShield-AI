import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePrismaMock, mockPrismaModule } from "./helpers/prisma-mock";

/**
 * Regression tests for Phase 1 §8.2: demo SLA controls default-secure.
 * The real route guard runs with the Prisma boundary mocked.
 */

const prisma = makePrismaMock();
mockPrismaModule(prisma);

const route = await import("@/app/api/demo/sla/route");

function officialReq(body: unknown): Request {
  return new Request("http://localhost/api/demo/sla", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Opaque session-JWT shape; requireRole is not reachable here because
      // the demo-mode guard must reject BEFORE authentication in deployed
      // environments. In dev mode the fake session hits the mocked prisma.
      cookie: "cs_session=fake",
    },
    body: JSON.stringify(body),
  });
}

describe("demo SLA endpoint protection (§8.2)", () => {
  beforeEach(() => {
    vi.stubEnv("DEMO_MODE", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.restoreAllMocks();
  });

  it("rejects on a deployed environment (production) without explicit DEMO_MODE=true — before any DB access", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await route.POST(officialReq({ complaintId: "c1", mode: "breach" }));
    expect(res.status).toBe(403);
  });

  it("rejects on a Vercel PREVIEW deployment without DEMO_MODE=true", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "preview");
    const res = await route.POST(officialReq({ complaintId: "c1", mode: "breach" }));
    expect(res.status).toBe(403);
  });

  it("rejects on a Vercel deployment flagged via VERCEL=1 without DEMO_MODE=true", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "1");
    const res = await route.POST(officialReq({ complaintId: "c1", mode: "breach" }));
    expect(res.status).toBe(403);
  });

  it("DEMO_MODE=false is refused everywhere, even in local development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEMO_MODE", "false");
    const res = await route.POST(officialReq({ complaintId: "c1", mode: "breach" }));
    expect(res.status).toBe(403);
  });
});
