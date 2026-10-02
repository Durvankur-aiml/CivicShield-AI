import { describe, expect, it } from "vitest";
import {
  CATEGORY_REQUIREMENTS,
  SCORE_WEIGHTS,
  requirementsForComplaint,
  checkEligibility,
  scoreCandidate,
  rankCandidates,
  hasUsableCoordinates,
  type ComplaintRequirements,
} from "@/lib/assignmentDomain";
import type { WorkerProfile, Complaint } from "@prisma/client";

/** Deterministic policy tests — no DB involved. */

const profile = (over: Partial<WorkerProfile> = {}): WorkerProfile =>
  ({
    id: "wp1",
    userId: "u1",
    employeeId: "DEMO-PWD-001",
    departmentId: "PWD",
    designation: "Road Repair Technician",
    skills: ["ROAD_REPAIR", "ASPHALT_LAYING"],
    equipment: ["DRILL"],
    availability: "AVAILABLE",
    serviceAreas: ["Ward 1", "Ward 5"],
    baseLat: 16.6952,
    baseLng: 74.4574,
    maxActiveAssignments: 3,
    phone: null,
    workEmail: null,
    approvedById: "official",
    approvedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as WorkerProfile;

const requirements = (over: Partial<ComplaintRequirements> = {}): ComplaintRequirements => ({
  departmentCode: "PWD",
  category: "POTHOLE",
  requiredSkills: ["ROAD_REPAIR"],
  requiredEquipment: ["DRILL"],
  serviceArea: "Ward 1",
  ...over,
});

const complaint = (over: Partial<Complaint> = {}): Pick<Complaint, "lat" | "lng" | "severity" | "slaDueAt" | "status" | "createdAt"> =>
  ({
    lat: 16.6952,
    lng: 74.4574,
    severity: "HIGH",
    slaDueAt: new Date(Date.now() + 24 * 3600_000),
    status: "RECEIVED",
    createdAt: new Date(),
    ...over,
  }) as Pick<Complaint, "lat" | "lng" | "severity" | "slaDueAt" | "status" | "createdAt">;

describe("requirements mapping (deterministic, documented policy)", () => {
  it("maps each category to conservative capability requirements", () => {
    expect(CATEGORY_REQUIREMENTS.POTHOLE).toEqual({ skills: ["ROAD_REPAIR"], equipment: ["DRILL"] });
    expect(CATEGORY_REQUIREMENTS.WATERLOGGING).toEqual({ skills: ["DRAINAGE_CLEARING"], equipment: ["WATER_PUMP"] });
    expect(CATEGORY_REQUIREMENTS.OTHER).toEqual({ skills: [], equipment: [] });
  });

  it("derives requirements from complaint department/category/ward", () => {
    const req = requirementsForComplaint({ category: "POTHOLE", ward: "Ward 3", department: { code: "PWD" } });
    expect(req).toEqual({
      departmentCode: "PWD",
      category: "POTHOLE",
      requiredSkills: ["ROAD_REPAIR"],
      requiredEquipment: ["DRILL"],
      serviceArea: "Ward 3",
    });
  });

  it("falls back to GEN with no hard demands for unknown categories", () => {
    const req = requirementsForComplaint({ category: "MYSTERY", ward: null, department: null });
    expect(req.departmentCode).toBe("GEN");
    expect(req.requiredSkills).toEqual([]);
    expect(req.requiredEquipment).toEqual([]);
  });
});

describe("hard eligibility (gates scoring — never rescued by score)", () => {
  it("accepts a fully qualified worker", () => {
    const r = checkEligibility(profile(), requirements(), 0, new Set());
    expect(r.eligible).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("excludes wrong-department workers", () => {
    const r = checkEligibility(profile({ departmentId: "SWM" }), requirements(), 0, new Set());
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/different department/);
  });

  it("excludes unavailable workers (OFF_DUTY / SUSPENDED)", () => {
    for (const availability of ["OFF_DUTY", "SUSPENDED"] as const) {
      const r = checkEligibility(profile({ availability }), requirements(), 0, new Set());
      expect(r.eligible).toBe(false);
      expect(r.reasons.join(" ")).toMatch(/availability/);
    }
  });

  it("excludes workers missing a required skill", () => {
    const r = checkEligibility(profile({ skills: ["WASTE_COLLECTION"] }), requirements(), 0, new Set());
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/missing required skill/);
  });

  it("excludes workers missing required equipment", () => {
    const r = checkEligibility(profile({ equipment: [] }), requirements(), 0, new Set());
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/missing required equipment/);
  });

  it("excludes workers outside the complaint's service area", () => {
    const r = checkEligibility(profile({ serviceAreas: ["Ward 7"] }), requirements(), 0, new Set());
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/service area/);
  });

  it("excludes workers at capacity", () => {
    const r = checkEligibility(profile({ maxActiveAssignments: 3 }), requirements(), 3, new Set());
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/at capacity/);
  });

  it("excludes workers rejected earlier in this request", () => {
    const r = checkEligibility(profile(), requirements(), 0, new Set(["u1"]));
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/excluded/);
  });

  it("a very close, low-workload wrong-department worker is still INELIGIBLE", () => {
    const wrongDept = profile({ departmentId: "SWM", baseLat: 16.6952001, baseLng: 74.4574001, maxActiveAssignments: 9 });
    const r = checkEligibility(wrongDept, requirements(), 0, new Set());
    expect(r.eligible).toBe(false);
  });

  it("workers with no declared service areas are not hard-failed on area", () => {
    const r = checkEligibility(profile({ serviceAreas: [] }), requirements(), 0, new Set());
    expect(r.eligible).toBe(true);
  });
});

describe("scoring (documented weights, 0..100)", () => {
  it("full match + zero load + zero distance ≈ near-maximum", () => {
    const s = scoreCandidate(profile({ maxActiveAssignments: 3 }), requirements(), 0, complaint());
    expect(s.score).toBeGreaterThan(85);
    const total = s.breakdown.reduce((a, b) => a + b.points, 0);
    expect(Math.abs(total - s.score)).toBeLessThan(0.01);
  });

  it("weights sum to 100 and breakdown respects the maxima", () => {
    expect(Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    const s = scoreCandidate(profile(), requirements(), 0, complaint());
    for (const b of s.breakdown) {
      expect(b.points).toBeGreaterThanOrEqual(0);
      expect(b.points).toBeLessThanOrEqual(b.max);
    }
  });

  it("prefers the closer worker when all else is equal", () => {
    const near = scoreCandidate(profile({ userId: "near", baseLat: 16.6952, baseLng: 74.4574 }), requirements(), 0, complaint());
    const far = scoreCandidate(profile({ userId: "far", baseLat: 16.71, baseLng: 74.47 }), requirements(), 0, complaint());
    expect(near.score).toBeGreaterThan(far.score);
    expect(near.breakdown.find((b) => b.factor === "distance")!.points).toBeGreaterThan(
      far.breakdown.find((b) => b.factor === "distance")!.points
    );
  });

  it("prefers the lower-workload worker when all else is equal", () => {
    const light = scoreCandidate(profile(), requirements(), 0, complaint());
    const busy = scoreCandidate(profile(), requirements(), 2, complaint());
    expect(light.score).toBeGreaterThan(busy.score);
  });

  it("rewards better skill coverage", () => {
    const partial = scoreCandidate(profile({ skills: [] }), requirements({ requiredSkills: ["ROAD_REPAIR", "ASPHALT_LAYING"] }), 0, complaint());
    const full = scoreCandidate(profile({ skills: ["ROAD_REPAIR", "ASPHALT_LAYING"] }), requirements({ requiredSkills: ["ROAD_REPAIR", "ASPHALT_LAYING"] }), 0, complaint());
    expect(full.score).toBeGreaterThan(partial.score);
  });

  it("rewards equipment coverage", () => {
    const withEquip = scoreCandidate(profile({ equipment: ["DRILL", "JCB_EXCAVATOR"] }), requirements({ requiredEquipment: ["DRILL", "JCB_EXCAVATOR"] }), 0, complaint());
    const half = scoreCandidate(profile({ equipment: ["DRILL"] }), requirements({ requiredEquipment: ["DRILL", "JCB_EXCAVATOR"] }), 0, complaint());
    expect(withEquip.score).toBeGreaterThan(half.score);
  });

  it("urgency rises as the SLA clock is consumed (documented saturation)", () => {
    const fresh = scoreCandidate(profile(), requirements(), 0, complaint({ createdAt: new Date(), slaDueAt: new Date(Date.now() + 24 * 3600_000) }));
    const late = scoreCandidate(profile(), requirements(), 0, complaint({
      createdAt: new Date(Date.now() - 23 * 3600_000),
      slaDueAt: new Date(Date.now() + 1 * 3600_000),
    }));
    const u1 = fresh.breakdown.find((b) => b.factor === "urgency")!.points;
    const u2 = late.breakdown.find((b) => b.factor === "urgency")!.points;
    expect(u2).toBeGreaterThan(u1);
    expect(u2).toBeLessThanOrEqual(SCORE_WEIGHTS.urgency);
  });

  it("breached SLA tops out urgency", () => {
    const breached = scoreCandidate(profile(), requirements(), 0, complaint({
      createdAt: new Date(Date.now() - 48 * 3600_000),
      slaDueAt: new Date(Date.now() - 2 * 3600_000),
    }));
    expect(breached.breakdown.find((b) => b.factor === "urgency")!.points).toBe(SCORE_WEIGHTS.urgency);
  });

  it("no SLA clock → zero urgency; no worker coordinates → neutral distance", () => {
    const s = scoreCandidate(profile({ baseLat: null, baseLng: null }), requirements(), 0, complaint({ slaDueAt: null }));
    expect(s.breakdown.find((b) => b.factor === "urgency")!.points).toBe(0);
    expect(s.breakdown.find((b) => b.factor === "distance")!.points).toBeCloseTo(SCORE_WEIGHTS.distance * 0.5, 2);
    expect(s.distanceM).toBeNull();
  });
});

describe("deterministic tie-breaking", () => {
  it("score DESC → distance ASC → employeeId ASC, always stable", () => {
    const a = { ...scoreCandidate(profile({ userId: "ua", employeeId: "DEMO-PWD-001", baseLat: 16.6952, baseLng: 74.4574 }), requirements(), 0, complaint()) };
    const b = { ...scoreCandidate(profile({ userId: "ub", employeeId: "DEMO-PWD-002", baseLat: 16.6952, baseLng: 74.4574 }), requirements(), 0, complaint()) };
    // Identical scores and distances → employeeId decides, same order every time.
    const ranked = [b, a].sort(rankCandidates);
    expect(ranked[0].profile.employeeId).toBe("DEMO-PWD-001");
    expect([b, a].sort(rankCandidates)).toEqual(ranked);
  });

  it("equal scores rank by distance; null distances rank last", () => {
    const near = scoreCandidate(profile({ employeeId: "B", baseLat: 16.6952, baseLng: 74.4574 }), requirements(), 0, complaint());
    const noLoc = scoreCandidate(profile({ employeeId: "A", baseLat: null, baseLng: null }), requirements(), 0, complaint());
    expect(rankCandidates(near, noLoc)).toBeLessThan(0); // near first
    expect(rankCandidates(noLoc, near)).toBeGreaterThan(0);
  });
});

describe("coordinate usability (objective 3 hardening)", () => {
  it("recognizes valid coordinate pairs", () => {
    expect(hasUsableCoordinates(16.6952, 74.4574)).toBe(true);
    expect(hasUsableCoordinates(-90, 180)).toBe(true);
    expect(hasUsableCoordinates(0, 0)).toBe(true);
  });

  it("rejects missing, non-finite, and out-of-range coordinates", () => {
    expect(hasUsableCoordinates(null, null)).toBe(false);
    expect(hasUsableCoordinates(undefined, undefined)).toBe(false);
    expect(hasUsableCoordinates(Number.NaN, 74)).toBe(false);
    expect(hasUsableCoordinates(16, Number.POSITIVE_INFINITY)).toBe(false);
    expect(hasUsableCoordinates(91, 74)).toBe(false); // lat out of range
    expect(hasUsableCoordinates(16, 181)).toBe(false); // lng out of range
  });

  it("invalid complaint coordinates fall back to the neutral distance instead of poisoning the score", () => {
    // A NaN coordinate would make Haversine return NaN, which would make the
    // whole score NaN and break deterministic ranking. The guard keeps the
    // documented neutral-0.5 fallback instead.
    const poisoned = scoreCandidate(
      profile({ baseLat: 16.6952, baseLng: 74.4574 }),
      requirements(),
      0,
      complaint({ lat: Number.NaN, lng: Number.NaN })
    );
    expect(poisoned.distanceM).toBeNull();
    expect(Number.isFinite(poisoned.score)).toBe(true);
    const distanceFactor = poisoned.breakdown.find((b) => b.factor === "distance");
    expect(distanceFactor?.points).toBeCloseTo(SCORE_WEIGHTS.distance * 0.5, 2);
    expect(distanceFactor?.note).toContain("neutral");
  });
});
