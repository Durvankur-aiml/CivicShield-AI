import { describe, it, expect } from "vitest";
import { DevVisionProvider } from "@/lib/ai/devVision";
import { DevLLMProvider } from "@/lib/ai/devLlm";
import { DevResolutionVerifier } from "@/lib/ai/devVerifier";
import { getVisionProvider, getLLMProvider, getResolutionVerifier } from "@/lib/ai";

describe("DevVisionProvider (labeled dev provider)", () => {
  it("maps a demo hint to a category and always labels itself", async () => {
    const r = await new DevVisionProvider().detect(Buffer.from("x"), "image/jpeg", { demoHint: "Pothole" });
    expect(r.provider).toBe("dev:hint");
    expect(r.category).toBe("POTHOLE");
    expect(r.note).toContain("Simulated detection");
  });

  it("returns no detection without a hint — never fabricates", async () => {
    const r = await new DevVisionProvider().detect(Buffer.from("x"), "image/jpeg");
    expect(r.category).toBeNull();
    expect(r.detections).toHaveLength(0);
  });
});

describe("DevLLMProvider (labeled dev provider)", () => {
  it("classifies English keyword complaints", async () => {
    const r = await new DevLLMProvider().reason({ description: "Garbage not collected near the school for a week", visionCategory: null, visionConfidence: null, language: "en" });
    expect(r.category).toBe("GARBAGE");
    expect(r.provider).toBe("dev:rules");
  });

  it("classifies Hindi and Marathi keyword complaints", async () => {
    const hi = await new DevLLMProvider().reason({ description: "सड़क पर बड़ा गड्ढा है", visionCategory: null, visionConfidence: null, language: "hi" });
    expect(hi.category).toBe("POTHOLE");
    const mr = await new DevLLMProvider().reason({ description: "इथे कचरा जमला आहे", visionCategory: null, visionConfidence: null, language: "mr" });
    expect(mr.category).toBe("GARBAGE");
  });

  it("defers to confident vision results", async () => {
    const r = await new DevLLMProvider().reason({ description: "garbage on the road", visionCategory: "WATERLOGGING", visionConfidence: 0.9, language: "en" });
    expect(r.category).toBe("WATERLOGGING");
  });
});

describe("DevResolutionVerifier (labeled dev provider)", () => {
  // Phase 4: the verifier structurally inspects bytes before heuristics, so
  // fixtures must carry a real JPEG header (routes already magic-byte-check
  // uploads, so real inputs always do).
  const imageBytes = (fill: number) =>
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100_000, fill)]);

  it("verifies a brightened after-image for a dark issue (pothole filled)", async () => {
    const before = imageBytes(10); // dark
    const after = imageBytes(200); // bright
    const v = await new DevResolutionVerifier().verify({ category: "POTHOLE", originalDescription: "pothole", beforeImage: before, afterImage: after });
    expect(v.verified).toBe(true);
    expect(v.confidence).toBeGreaterThan(0.6);
  });

  it("rejects when the after-image stays dark (issue persists)", async () => {
    const before = imageBytes(10);
    const after = imageBytes(15);
    const v = await new DevResolutionVerifier().verify({ category: "POTHOLE", originalDescription: "pothole", beforeImage: before, afterImage: after });
    expect(v.verified).toBe(false);
  });
});

describe("provider registry respects configuration", () => {
  it("falls back to labeled dev providers without service config", () => {
    const prev = process.env.YOLO_SERVICE_URL;
    delete process.env.YOLO_SERVICE_URL;
    expect(getVisionProvider().id).toBe("dev:hint");
    expect(getResolutionVerifier().id).toBe("dev:heuristic");
    delete process.env.AWS_ACCESS_KEY_ID;
    expect(getLLMProvider().id).toBe("dev:rules");
    if (prev) process.env.YOLO_SERVICE_URL = prev;
  });
});
