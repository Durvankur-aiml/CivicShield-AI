import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression tests for Phase 1 P0-4: BEFORE-image MIME propagation to the
 * real YOLO verification provider.
 *
 * SCOPE — provider WIRING only. These tests prove the application sends the
 * BEFORE image bytes and MIME type, the AFTER image, and the category in the
 * multipart request to /verify. They do NOT execute real YOLO inference:
 * the CivicAI `best.pt` weight is not available in this environment, so real
 * inference remains UNTESTED here (see vision-service/README.md and the Phase
 * 1 report — real-model verification requires the weight + a running service).
 */

const fetchMock = vi.fn();

const { YoloResolutionVerifier } = await import("@/lib/ai/yoloVerifier");

describe("YoloResolutionVerifier BEFORE-image wiring (P0-4)", () => {
  beforeEach(() => {
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends BEFORE bytes with the BEFORE MIME, AFTER bytes, and the category", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ verified: true, confidence: 0.9, reason: "issue gone" }), { status: 200 })
    );

    const beforeBytes = Buffer.from([1, 2, 3, 4, 5]);
    const afterBytes = Buffer.from([9, 8, 7, 6, 5, 4]);
    const verifier = new YoloResolutionVerifier("http://yolo.test");

    const verdict = await verifier.verify({
      category: "POTHOLE",
      originalDescription: "deep pothole",
      beforeImage: beforeBytes,
      beforeMime: "image/png", // the exact field that was previously null
      afterImage: afterBytes,
      afterMime: "image/jpeg",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://yolo.test/verify");
    expect(init.method).toBe("POST");

    const form = init.body as FormData;
    const before = form.get("before") as File;
    const after = form.get("after") as File;
    expect(before).toBeTruthy();
    expect(before.type).toBe("image/png"); // MIME now propagates — was hardcoded null
    expect(after.type).toBe("image/jpeg");
    expect(form.get("category")).toBe("POTHOLE");

    // Bytes round-trip intact through the Blob parts.
    expect(Buffer.from(await before.arrayBuffer())).toEqual(beforeBytes);
    expect(Buffer.from(await after.arrayBuffer())).toEqual(afterBytes);

    expect(verdict.verified).toBe(true);
    expect(verdict.provider).toBe("yolo-service");
  });

  it("omits the BEFORE part entirely when no before-image exists (optional stays optional)", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ verified: false, confidence: 0.4, reason: "still visible" }), { status: 200 })
    );

    const verifier = new YoloResolutionVerifier("http://yolo.test");
    await verifier.verify({
      category: "GARBAGE",
      originalDescription: "overflowing bin",
      beforeImage: null,
      beforeMime: null,
      afterImage: Buffer.from([1]),
      afterMime: "image/jpeg",
    });

    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(form.get("before")).toBeNull();
    expect(form.get("after")).toBeTruthy();
    expect(form.get("category")).toBe("GARBAGE");
  });

  it("throws on a non-OK service response (failures stay visible, never silently faked)", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

    const verifier = new YoloResolutionVerifier("http://yolo.test");
    await expect(
      verifier.verify({
        category: "POTHOLE",
        originalDescription: "d",
        beforeImage: Buffer.from([1]),
        beforeMime: "image/jpeg",
        afterImage: Buffer.from([2]),
        afterMime: "image/jpeg",
      })
    ).rejects.toThrow(/YOLO verify responded 500/);
  });
});
