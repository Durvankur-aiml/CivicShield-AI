import { describe, it, expect } from "vitest";
import { haversineMeters, jaccardSimilarity, findBestDuplicate, type DuplicateCandidate } from "@/lib/duplicate";

const now = new Date();

const candidate: DuplicateCandidate = {
  id: "c1", refCode: "CS-2026-000001", category: "POTHOLE", description: "Deep pothole near the bus stand on main road",
  lat: 16.6952, lng: 74.4574, createdAt: new Date(now.getTime() - 3600_000), // 1h ago
};

describe("haversineMeters", () => {
  it("measures short urban distances plausibly", () => {
    const d = haversineMeters(16.6952, 74.4574, 16.6953, 74.4576);
    expect(d).toBeGreaterThan(10);
    expect(d).toBeLessThan(60);
  });
  it("is zero for identical points", () => {
    expect(haversineMeters(16.69, 74.45, 16.69, 74.45)).toBe(0);
  });
});

describe("jaccardSimilarity", () => {
  it("scores identical text at 1 and disjoint text low", () => {
    const a = "deep pothole near bus stand";
    expect(jaccardSimilarity(a, a)).toBe(1);
    expect(jaccardSimilarity(a, "streetlight not working at night")).toBeLessThan(0.2);
  });
});

describe("findBestDuplicate", () => {
  const incoming = {
    category: "POTHOLE",
    description: "Big deep pothole near the bus stand, main road",
    lat: 16.69525, lng: 74.45742, createdAt: now,
  };

  it("links a nearby, same-category, similar complaint", () => {
    const m = findBestDuplicate(incoming, [candidate]);
    expect(m).not.toBeNull();
    expect(m?.candidate.refCode).toBe("CS-2026-000001");
    expect(m?.distanceM).toBeLessThan(30);
    expect(m?.reasons.length).toBe(4);
  });

  it("ignores far-away complaints", () => {
    const far = { ...candidate, lat: 16.71, lng: 74.47 };
    expect(findBestDuplicate(incoming, [far])).toBeNull();
  });

  it("ignores different categories", () => {
    expect(findBestDuplicate({ ...incoming, category: "GARBAGE" }, [candidate])).toBeNull();
  });

  it("ignores stale complaints outside the time window", () => {
    const stale = { ...candidate, createdAt: new Date(now.getTime() - 200 * 3600_000) };
    expect(findBestDuplicate(incoming, [stale])).toBeNull();
  });
});
