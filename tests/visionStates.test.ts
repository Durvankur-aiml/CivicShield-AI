import { afterEach, describe, expect, it, vi } from "vitest";
import {
  providerStateFor,
  verificationResultFor,
  decisionForVerification,
  unavailableVerdict,
  inspectImageBytes,
  confidenceKindFor,
} from "@/lib/visionStates";
import { DevVisionProvider } from "@/lib/ai/devVision";
import { DevResolutionVerifier } from "@/lib/ai/devVerifier";
import { YoloResolutionVerifier } from "@/lib/ai/yoloVerifier";
import { aiProviderStatus } from "@/lib/ai";

/**
 * Phase 4 Workstream B — vision/verification honesty (unit, mocked fetch).
 *
 * REAL YOLO INFERENCE NOT TESTED: the CivicAI `best.pt` weight is NOT present
 * in this environment (vision-service/model/ contains only a README), so these
 * are provider-boundary and honesty tests — they are NOT "real YOLO tests".
 */

describe("provider states (B2) — machine-readable honesty", () => {
  it("labels the real YOLO service REAL_YOLO", () => {
    expect(providerStateFor("yolo-service")).toBe("REAL_YOLO");
  });

  it("labels every development provider DEV_HINT (never passes as a real model)", () => {
    expect(providerStateFor("dev:hint")).toBe("DEV_HINT");
    expect(providerStateFor("dev:heuristic")).toBe("DEV_HINT");
  });

  it("unknown/absent providers are UNAVAILABLE — never silently real", () => {
    expect(providerStateFor("unavailable")).toBe("UNAVAILABLE");
    expect(providerStateFor("")).toBe("UNAVAILABLE");
  });

  it("health status exposes the provider states", () => {
    const prev = process.env.YOLO_SERVICE_URL;
    delete process.env.YOLO_SERVICE_URL;
    expect(aiProviderStatus().visionProviderState).toBe("DEV_HINT");
    expect(aiProviderStatus().verifierProviderState).toBe("DEV_HINT");
    process.env.YOLO_SERVICE_URL = "http://yolo.test";
    expect(aiProviderStatus().visionProviderState).toBe("REAL_YOLO");
    if (prev) process.env.YOLO_SERVICE_URL = prev; else delete process.env.YOLO_SERVICE_URL;
  });
});

describe("verification result states (B7) — never reduced to a bare boolean", () => {
  it("maps a passing real verdict to VERIFIED", () => {
    expect(verificationResultFor({ verified: true, provider: "yolo-service" })).toBe("VERIFIED");
  });

  it("maps a failing real verdict to FAILED", () => {
    expect(verificationResultFor({ verified: false, provider: "yolo-service" })).toBe("FAILED");
  });

  it("maps an errored/unavailable verifier to UNAVAILABLE (fail-safe)", () => {
    expect(verificationResultFor({ verified: false, provider: "unavailable" })).toBe("UNAVAILABLE");
  });

  it("the explicit unavailable verdict can never approve anything", () => {
    const v = unavailableVerdict("verifier down");
    expect(v.verified).toBe(false);
    expect(v.verificationResult).toBe("UNAVAILABLE");
    expect(v.confidence).toBe(0);
    expect(v.provider).toBe("unavailable");
  });
});

describe("route outcome policy (B10) — fail-safe branching", () => {
  it("only VERIFIED resolves a case", () => {
    expect(decisionForVerification("VERIFIED", { reopenedCount: 0, severity: "LOW" })).toEqual({ outcome: "RESOLVE", escalate: false });
  });

  it("FAILED reopens and escalates on repeated failure", () => {
    expect(decisionForVerification("FAILED", { reopenedCount: 2, severity: "LOW" }).outcome).toBe("REOPEN");
    expect(decisionForVerification("FAILED", { reopenedCount: 2, severity: "LOW" }).escalate).toBe(true);
  });

  it("FAILED escalates for high-severity complaints (Phase 3 policy preserved)", () => {
    expect(decisionForVerification("FAILED", { reopenedCount: 0, severity: "CRITICAL" }).escalate).toBe(true);
    expect(decisionForVerification("FAILED", { reopenedCount: 0, severity: "HIGH" }).escalate).toBe(true);
    expect(decisionForVerification("FAILED", { reopenedCount: 0, severity: "MEDIUM" }).escalate).toBe(false);
  });

  it("INCONCLUSIVE and UNAVAILABLE HOLD the case — no approval, no punishment", () => {
    expect(decisionForVerification("INCONCLUSIVE", { reopenedCount: 5, severity: "CRITICAL" })).toEqual({ outcome: "HOLD", escalate: false });
    expect(decisionForVerification("UNAVAILABLE", { reopenedCount: 5, severity: "CRITICAL" })).toEqual({ outcome: "HOLD", escalate: false });
  });
});

describe("structural image inspection (B5) — no trust in client MIME alone", () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 0xaa)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(100)]);
  const heic = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypheic"), Buffer.alloc(100)]);

  it("recognizes the allowed formats by magic bytes", () => {
    expect(inspectImageBytes(jpeg)).toEqual({ ok: true, format: "image/jpeg" });
    expect(inspectImageBytes(png)).toEqual({ ok: true, format: "image/png" });
    expect(inspectImageBytes(webp)).toEqual({ ok: true, format: "image/webp" });
    expect(inspectImageBytes(heic)).toEqual({ ok: true, format: "image/heic" });
  });

  it("rejects text/HTML/script payloads renamed to images", () => {
    const html = Buffer.from("<!DOCTYPE html><script>alert(1)</script>");
    expect(inspectImageBytes(html).ok).toBe(false);
    expect(inspectImageBytes(Buffer.from("%PDF-1.7 malicious")).ok).toBe(false);
  });

  it("rejects truncated and empty-ish buffers", () => {
    expect(inspectImageBytes(Buffer.from([0xff, 0xd8])).ok).toBe(false);
    expect(inspectImageBytes(Buffer.alloc(0)).ok).toBe(false);
  });

  it("rejects unsupported ISOBMFF brands", () => {
    const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom"), Buffer.alloc(100)]);
    const r = inspectImageBytes(mp4);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Unsupported/i);
  });
});

describe("dev vision provider honesty (B11) — labeled, never fabricating", () => {
  it("hint-driven output is labeled DEV_HINT with HEURISTIC confidence", async () => {
    const r = await new DevVisionProvider().detect(Buffer.from("bytes"), "image/jpeg", { demoHint: "Pothole" });
    expect(r.provider).toBe("dev:hint");
    expect(r.providerState).toBe("DEV_HINT");
    expect(r.confidenceKind).toBe("HEURISTIC");
    expect(r.note).toContain("development provider");
  });

  it("without a hint it reports NO detection instead of inventing one", async () => {
    const r = await new DevVisionProvider().detect(Buffer.from("bytes"), "image/jpeg");
    expect(r.detections).toHaveLength(0);
    expect(r.category).toBeNull();
    expect(r.confidence).toBe(0);
  });
});

describe("dev verifier honesty (B8/B9) — INCONCLUSIVE instead of fake failures", () => {
  const imageBytes = (fill: number) =>
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100_000, fill)]);

  it("a verified brightened after-image is VERIFIED with HEURISTIC confidence kind", async () => {
    const v = await new DevResolutionVerifier().verify({
      category: "POTHOLE", originalDescription: "pothole",
      beforeImage: imageBytes(10), beforeMime: "image/jpeg", afterImage: imageBytes(200), afterMime: "image/jpeg",
    });
    expect(v.verified).toBe(true);
    expect(v.verificationResult).toBe("VERIFIED");
    expect(v.confidenceKind).toBe("HEURISTIC");
  });

  it("without a before-image the result is INCONCLUSIVE, not a fabricated failure", async () => {
    const v = await new DevResolutionVerifier().verify({
      category: "POTHOLE", originalDescription: "pothole",
      beforeImage: null, beforeMime: null, afterImage: imageBytes(200), afterMime: "image/jpeg",
    });
    expect(v.verified).toBe(false);
    expect(v.verificationResult).toBe("INCONCLUSIVE");
  });

  it("corrupt image bytes are INCONCLUSIVE — the heuristic never 'analyzes' garbage", async () => {
    const v = await new DevResolutionVerifier().verify({
      category: "POTHOLE", originalDescription: "pothole",
      beforeImage: Buffer.from("this is not an image at all"), beforeMime: "image/jpeg",
      afterImage: imageBytes(200), afterMime: "image/jpeg",
    });
    expect(v.verificationResult).toBe("INCONCLUSIVE");
    expect(v.verified).toBe(false);
  });

  it("corrupt AFTER bytes are rejected before any pass can occur", async () => {
    const v = await new DevResolutionVerifier().verify({
      category: "POTHOLE", originalDescription: "pothole",
      beforeImage: imageBytes(10), beforeMime: "image/jpeg",
      afterImage: Buffer.from("<html>fake</html>"), afterMime: "image/jpeg",
    });
    expect(v.verified).toBe(false);
    expect(v.verificationResult).toBe("INCONCLUSIVE");
  });
});

describe("real provider boundary (B2/B3) — wiring only; real inference NOT TESTED", () => {
  const fetchMock = vi.fn();
  afterEach(() => vi.restoreAllMocks());

  const validInput = {
    category: "POTHOLE", originalDescription: "deep pothole",
    beforeImage: Buffer.from([1, 2, 3]), beforeMime: "image/jpeg",
    afterImage: Buffer.from([4, 5, 6]), afterMime: "image/jpeg",
  };

  it("a 503 from the service becomes an explicit UNAVAILABLE verdict (no fake boolean)", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ detail: "Weights not found" }), { status: 503 }));
    const v = await new YoloResolutionVerifier("http://yolo.test").verify(validInput);
    expect(v.verificationResult).toBe("UNAVAILABLE");
    expect(v.verified).toBe(false);
    expect(v.confidence).toBe(0);
    expect(v.reason).toContain("unavailable");
  });

  it("an explicit INCONCLUSIVE state from the service is preserved", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ verified: false, result: "INCONCLUSIVE", confidence: 0.1, reason: "nothing detectable" }), { status: 200 })
    );
    const v = await new YoloResolutionVerifier("http://yolo.test").verify(validInput);
    expect(v.verificationResult).toBe("INCONCLUSIVE");
    expect(v.confidenceKind).toBe("MODEL");
  });

  it("a real pass is VERIFIED with MODEL confidence kind", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ verified: true, result: "VERIFIED", confidence: 0.91, reason: "issue gone" }), { status: 200 })
    );
    const v = await new YoloResolutionVerifier("http://yolo.test").verify(validInput);
    expect(v.verificationResult).toBe("VERIFIED");
    expect(v.confidenceKind).toBe("MODEL");
  });

  it("other HTTP errors stay visible (thrown), never silently faked", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(new YoloResolutionVerifier("http://yolo.test").verify(validInput)).rejects.toThrow(/500/);
  });
});

describe("audit trail payload hygiene (B12)", () => {
  it("verdicts serialize without any image bytes", async () => {
    const v = unavailableVerdict("no verifier");
    const s = JSON.stringify(v);
    expect(s).not.toContain("255"); // no byte-array dumps
    expect(JSON.parse(s)).not.toHaveProperty("beforeImage");
    expect(JSON.parse(s)).not.toHaveProperty("afterImage");
  });
});

describe("confidence labeling (B9)", () => {
  it("only the real service earns MODEL kind; dev providers stay HEURISTIC", () => {
    expect(confidenceKindFor("yolo-service")).toBe("MODEL");
    expect(confidenceKindFor("dev:hint")).toBe("HEURISTIC");
    expect(confidenceKindFor("dev:heuristic")).toBe("HEURISTIC");
    expect(confidenceKindFor("unavailable")).toBe("UNKNOWN");
  });
});
