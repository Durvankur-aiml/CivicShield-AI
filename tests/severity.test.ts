import { describe, it, expect } from "vitest";
import { computeSeverity, computePriority, slaDueAtFor } from "@/lib/severity";

describe("computeSeverity", () => {
  it("returns LOW baseline for a mild issue with no signals", () => {
    const r = computeSeverity("STREETLIGHT", "The light near my house is not working.");
    expect(r.severity).toBe("LOW");
    expect(r.score).toBeLessThan(3.5);
  });

  it("escalates to CRITICAL for hazard language near sensitive areas", () => {
    const r = computeSeverity("POTHOLE", "Deep dangerous pothole on the main road near the school, an accident happened yesterday.");
    expect(r.severity).toBe("CRITICAL");
    expect(r.reasons.length).toBeGreaterThan(2);
  });

  it("adds vision confidence to the score", () => {
    const base = computeSeverity("POTHOLE", "There is a pothole here.");
    const withVision = computeSeverity("POTHOLE", "There is a pothole here.", 0.9);
    expect(withVision.score).toBeGreaterThan(base.score);
    expect(withVision.reasons.some((x) => x.includes("Vision model confidence"))).toBe(true);
  });

  it("never exceeds the 0..10 band", () => {
    const r = computeSeverity("WATERLOGGING", "Dangerous flood, deep water, accident risk, near hospital on main road, urgent, night", 1);
    expect(r.score).toBeLessThanOrEqual(10);
  });
});

describe("computePriority", () => {
  it("severity maps to baseline priority bands", () => {
    expect(computePriority("LOW").priority).toBe(25);
    expect(computePriority("CRITICAL").priority).toBe(90);
  });

  it("nearby corroborating reports raise priority", () => {
    const alone = computePriority("MEDIUM", {});
    const corroborated = computePriority("MEDIUM", { nearbyReports: 3 });
    expect(corroborated.priority).toBeGreaterThan(alone.priority);
    expect(corroborated.reasons.some((r) => r.includes("nearby report"))).toBe(true);
  });

  it("clamps to 1..100", () => {
    expect(computePriority("CRITICAL", { nearbyReports: 99, description: "main road junction" }).priority).toBeLessThanOrEqual(100);
  });
});

describe("slaDueAtFor", () => {
  it("uses configurable hours per severity", () => {
    const { hours, dueAt } = slaDueAtFor("HIGH", new Date("2026-09-20T10:00:00Z"));
    expect(hours).toBe(24);
    expect(dueAt.toISOString()).toBe("2026-09-21T10:00:00.000Z");
  });
});
