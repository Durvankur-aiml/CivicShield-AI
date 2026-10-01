import { describe, expect, it } from "vitest";
import {
  parseWindow,
  TimeWindowError,
  WINDOW_PRESETS,
  MAX_RANGE_DAYS,
  countMetric,
  rateMetric,
  safeMean,
  safeMedian,
  durationMetric,
  envelope,
  MIN_SAMPLE,
} from "@/lib/analytics";
import { buildComplaintAnalytics, buildDailySeries } from "@/lib/analytics/complaints";
import { buildResolutionAnalytics } from "@/lib/analytics/resolution";
import { buildSlaAnalytics, type SlaComplaintRow } from "@/lib/analytics/sla";
import { buildWorkerAnalytics } from "@/lib/analytics/workers";
import { buildAssignmentAnalytics } from "@/lib/analytics/assignments";
import { buildDepartmentAnalytics } from "@/lib/analytics/departments";
import { buildVerificationAnalytics } from "@/lib/analytics/verification";
import { buildLocationAnalytics } from "@/lib/analytics/location";
import { buildTrend, directionFor } from "@/lib/analytics/trends";

/**
 * Phase 5 — analytics domain correctness (deterministic fixtures, no DB).
 * Aggregation SQL itself is NOT TESTED (no live PostgreSQL); the pure
 * builders that assemble every response are, so metric semantics,
 * zero-division, null handling, and statuses are pinned.
 */

const window = (hours = 24): ReturnType<typeof parseWindow> => ({
  from: new Date(Date.UTC(2026, 8, 30, 0, 0, 0)),
  to: new Date(Date.UTC(2026, 8, 30, 0, 0, 0) + hours * 3_600_000),
  preset: "24h",
});

// ── Response contract ─────────────────────────────────────────────────────
describe("metric contract (spec §13)", () => {
  it("a real zero is OK, not NO_DATA", () => {
    const m = countMetric(0);
    expect(m).toEqual({ value: 0, sampleSize: 0, status: "OK" });
  });

  it("a rate with zero denominator is NO_DATA (never a fake 0 or 100%)", () => {
    expect(rateMetric(0, 0).status).toBe("NO_DATA");
    expect(rateMetric(5, 0).value).toBeNull();
  });

  it("a rate from a single sample is INSUFFICIENT_DATA", () => {
    const m = rateMetric(1, 1);
    expect(m.status).toBe("INSUFFICIENT_DATA");
    expect(m.value).toBeNull();
    expect(m.sampleSize).toBe(1);
  });

  it("rates round deterministically and carry the sample size", () => {
    const m = rateMetric(1, 3);
    expect(m).toMatchObject({ value: 0.3333, sampleSize: 3, status: "OK" });
  });

  it("safeMean/safeMedian reject NaN, negative and infinite inputs", () => {
    expect(safeMean([Number.NaN, -5, Infinity])).toBeNull();
    expect(safeMedian([Number.NaN])).toBeNull();
    expect(safeMedian([3, 1, 2])).toBe(2); // odd count → middle of sorted [1,2,3]
    expect(safeMedian([5, 1, 3, 7])).toBe(3); // even count → deterministic lower-middle of [1,3,5,7]
  });

  it("duration metrics: NO_DATA when empty; a single sample is a real measurement", () => {
    expect(durationMetric([]).avg.status).toBe("NO_DATA");
    expect(durationMetric([5]).avg).toMatchObject({ value: 5, sampleSize: 1, status: "OK" });
    expect(durationMetric([5, 7]).avg).toMatchObject({ value: 6, status: "OK" });
  });

  it("envelope carries the window and a UTC ISO generatedAt", () => {
    const e = envelope(window());
    expect(e.window.preset).toBe("24h");
    expect(e.window.from).toBe("2026-09-30T00:00:00.000Z");
    expect(new Date(e.generatedAt).toISOString()).toBe(e.generatedAt);
  });
});

// ── Time windows ──────────────────────────────────────────────────────────
describe("time windows (spec §5)", () => {
  const now = new Date("2026-09-30T12:00:00Z");

  it("supports all presets with half-open [from, to) semantics", () => {
    for (const p of WINDOW_PRESETS) {
      const w = parseWindow(new URLSearchParams(`window=${p}`), now);
      expect(w.preset).toBe(p);
      expect(w.to.getTime() - w.from.getTime()).toBeGreaterThan(0);
      expect(w.to.getUTCDate()).toBe(30);
    }
    expect(MAX_RANGE_DAYS).toBe(366);
  });

  it("custom ranges validate: malformed, reversed, future, oversized", () => {
    expect(() => parseWindow(new URLSearchParams("from=oops&to=2026-09-30T00:00:00Z"), now)).toThrow(TimeWindowError);
    expect(() =>
      parseWindow(new URLSearchParams("from=2026-09-30T02:00:00Z&to=2026-09-30T01:00:00Z"), now)
    ).toThrow(TimeWindowError);
    expect(() =>
      parseWindow(new URLSearchParams("from=2026-09-29T00:00:00Z&to=2027-09-30T00:00:00Z"), now)
    ).toThrow(TimeWindowError);
    const ok = parseWindow(new URLSearchParams("from=2026-09-29T00:00:00Z&to=2026-09-30T00:00:00Z"), now);
    expect(ok.preset).toBe("custom");
    // 'to' 61s in the future is tolerated (clock skew), 2h is not
    expect(() => parseWindow(new URLSearchParams("from=2026-09-30T00:00:00Z&to=2026-09-30T14:00:00Z"), now)).toThrow(
      TimeWindowError
    );
  });

  it("half-preserved ranges are rejected", () => {
    expect(() => parseWindow(new URLSearchParams("from=2026-09-30T00:00:00Z"), now)).toThrow(TimeWindowError);
    expect(() => parseWindow(new URLSearchParams("to=2026-09-30T00:00:00Z"), now)).toThrow(TimeWindowError);
  });

  it("unknown window names are rejected with the valid options", () => {
    expect(() => parseWindow(new URLSearchParams("window=4h"), now)).toThrow(/24h, 7d, 30d, 90d/);
  });
});

// ── Complaint volume ──────────────────────────────────────────────────────
describe("complaint volume + time series", () => {
  it("totals, groupings and department code mapping derive from fixtures", () => {
    const w = window();
    const result = buildComplaintAnalytics(
      w,
      12,
      [
        { status: "RECEIVED", _count: { _all: 7 } },
        { status: "RESOLVED", _count: { _all: 5 } },
      ],
      [
        { category: "POTHOLE", _count: { _all: 8 } },
        { category: "GARBAGE", _count: { _all: 4 } },
      ],
      [
        { departmentId: "d1", _count: { _all: 9 } },
        { departmentId: "d2", _count: { _all: 3 } },
      ],
      [
        { createdAt: new Date("2026-09-29T10:00:00Z") },
        { createdAt: new Date("2026-09-29T23:59:59Z") },
        { createdAt: new Date("2026-09-30T01:00:00Z") },
      ],
      [
        { id: "d1", code: "PWD" },
        { id: "d2", code: "SWM" },
      ]
    );
    expect(result.totals.total).toMatchObject({ value: 12, status: "OK" });
    expect(result.totals.byStatus.value).toEqual([
      { key: "RECEIVED", count: 7 },
      { key: "RESOLVED", count: 5 },
    ]);
    expect(result.totals.byDepartment.value).toEqual([
      { key: "PWD", count: 9 },
      { key: "SWM", count: 3 },
    ]);
    // UTC day bucketing: 29T23:59:59Z belongs to the 29th, 30T01:00Z to the 30th
    expect(result.series.points).toEqual([
      { bucketStart: "2026-09-29T00:00:00.000Z", count: 2 },
      { bucketStart: "2026-09-30T00:00:00.000Z", count: 1 },
    ]);
  });

  it("empty windows produce an empty series (no padded zeros)", () => {
    const points = buildDailySeries([]);
    expect(points).toEqual([]);
  });

  it("bucket boundaries are UTC-day aligned regardless of local timezone", () => {
    const points = buildDailySeries([new Date("2026-01-01T00:30:00+05:30")]);
    // 2026-01-01T00:30+05:30 == 2025-12-31T19:00Z → previous UTC day
    expect(points[0].bucketStart).toBe("2025-12-31T00:00:00.000Z");
  });
});

// ── Resolution ────────────────────────────────────────────────────────────
describe("resolution analytics", () => {
  it("computes average, median and rate from lifecycle timestamps", () => {
    const w = window();
    const r = buildResolutionAnalytics(w, {
      resolved: 3,
      total: 4,
      reopened: 1,
      rows: [
        { createdAt: new Date("2026-09-29T00:00:00Z"), resolvedAt: new Date("2026-09-29T10:00:00Z") }, // 10h
        { createdAt: new Date("2026-09-29T00:00:00Z"), resolvedAt: new Date("2026-09-29T20:00:00Z") }, // 20h
        { createdAt: new Date("2026-09-29T00:00:00Z"), resolvedAt: new Date("2026-09-29T15:00:00Z") }, // 15h
      ],
    });
    expect(r.resolutionRate).toMatchObject({ value: 0.75, status: "OK" });
    expect(r.avgResolutionTime).toMatchObject({ value: 15, status: "OK" });
    expect(r.medianResolutionTime).toMatchObject({ value: 15, status: "OK" });
    expect(r.reopened).toMatchObject({ value: 1, status: "OK" });
  });

  it("no resolutions → NO_DATA durations; zero-division guarded", () => {
    const r = buildResolutionAnalytics(window(), { resolved: 0, total: 0, reopened: 0, rows: [] });
    expect(r.avgResolutionTime.status).toBe("NO_DATA");
    expect(r.resolutionRate.status).toBe("NO_DATA");
    expect(r.resolutionRate.value).toBeNull();
  });

  it("negative durations (clock anomalies) are excluded, never averaged in", () => {
    const r = buildResolutionAnalytics(window(), {
      resolved: 2,
      total: 2,
      reopened: 0,
      rows: [
        { createdAt: new Date("2026-09-29T10:00:00Z"), resolvedAt: new Date("2026-09-29T05:00:00Z") }, // -5h → excluded
        { createdAt: new Date("2026-09-29T00:00:00Z"), resolvedAt: new Date("2026-09-29T06:00:00Z") }, // 6h
      ],
    });
    expect(r.avgResolutionTime.value).toBe(6);
  });
});

// ── SLA ───────────────────────────────────────────────────────────────────
describe("SLA analytics (reuses slaStateFor)", () => {
  const base: SlaComplaintRow = {
    status: "IN_PROGRESS",
    slaDueAt: new Date("2026-09-30T12:00:00Z"),
    isOverdue: false,
    escalationCount: 0,
    createdAt: new Date("2026-09-30T00:00:00Z"),
    resolvedAt: null,
    activeAssignment: null,
  };

  it("distributes states via the Phase 3 derivation and computes compliance", () => {
    const w = window();
    const r = buildSlaAnalytics(
      w,
      {
        complaints: [
          { ...base }, // within window, no warning → ON_TRACK
          { ...base, isOverdue: true }, // → BREACHED
          { ...base, status: "ESCALATED", escalationCount: 1 }, // → ESCALATED
          { ...base, status: "RESOLVED", resolvedAt: new Date("2026-09-30T01:00:00Z") }, // → RESOLVED
          { ...base, activeAssignment: { slaWarnedAt: new Date(), slaBreachedAt: null, completedAt: null } }, // → WARNING
        ],
        assignedAts: [
          { createdAt: new Date("2026-09-30T00:00:00Z"), assignedAt: new Date("2026-09-30T02:00:00Z") },
          { createdAt: new Date("2026-09-30T00:00:00Z"), assignedAt: new Date("2026-09-30T04:00:00Z") },
        ],
        acceptances: [],
        completions: [],
      },
      new Date("2026-09-30T06:00:00Z") // 50% consumed → no derived warning
    );
    expect(r.distribution.onTrack.value).toBe(1);
    expect(r.distribution.warning.value).toBe(1);
    expect(r.distribution.breached.value).toBe(1);
    expect(r.distribution.escalated.value).toBe(1);
    expect(r.distribution.resolved.value).toBe(1);
    expect(r.complianceRate).toMatchObject({ value: 0.5, sampleSize: 4, status: "OK" });
    expect(r.avgTimeToAssignment).toMatchObject({ value: 3, status: "OK" }); // mean of 2h, 4h
  });

  it("empty cohort → NO_DATA compliance, never a fake 100%", () => {
    const r = buildSlaAnalytics(window(), { complaints: [], assignedAts: [], acceptances: [], completions: [] });
    expect(r.complianceRate.status).toBe("NO_DATA");
    expect(r.avgTimeToAssignment.status).toBe("NO_DATA");
  });
});

// ── Workers ───────────────────────────────────────────────────────────────
describe("worker analytics (raw facts, no rankings)", () => {
  it("workload, completed, rejected, reassignments and durations per worker", () => {
    const w = window();
    const r = buildWorkerAnalytics(w, {
      profiles: [
        { userId: "u1", employeeId: "PWD-001", name: "A", department: "PWD", availability: "AVAILABLE", maxActiveAssignments: 3 },
        { userId: "u2", employeeId: "SWM-002", name: "B", department: "SWM", availability: "OFF_DUTY", maxActiveAssignments: 3 },
      ],
      activeGroups: [{ workerId: "u1", _count: { _all: 2 } }],
      completedGroups: [{ workerId: "u1", _count: { _all: 3 } }],
      rejectedGroups: [{ workerId: "u2", _count: { _all: 1 } }],
      reassignedGroups: [],
      completionRows: [
        { workerId: "u1", startedAt: new Date("2026-09-29T00:00:00Z"), completedAt: new Date("2026-09-29T02:00:00Z") },
        { workerId: "u1", startedAt: new Date("2026-09-29T06:00:00Z"), completedAt: new Date("2026-09-29T10:00:00Z") },
      ],
    });
    expect(r.workers[0]).toMatchObject({ employeeId: "PWD-001", currentActive: 2, completedInWindow: 3, rejectedInWindow: 0 });
    expect(r.workers[0].avgCompletionHours).toMatchObject({ value: 3, status: "OK" });
    expect(r.workers[1]).toMatchObject({ currentActive: 0, rejectedInWindow: 1 });
    expect(r.summary.activeWorkers).toMatchObject({ value: 1, status: "OK" });
    expect(r.summary.totalWorkload).toMatchObject({ value: 2, status: "OK" });
    // privacy: identity limited to employeeId + name
    expect(Object.keys(r.workers[0])).not.toContain("email");
    expect(JSON.stringify(r.workers)).not.toContain("@");
  });

  it("a worker with no completions reports NO_DATA duration, not 0", () => {
    const r = buildWorkerAnalytics(window(), {
      profiles: [{ userId: "u1", employeeId: "X-1", name: "A", department: "GEN", availability: "AVAILABLE", maxActiveAssignments: 2 }],
      activeGroups: [],
      completedGroups: [],
      rejectedGroups: [],
      reassignedGroups: [],
      completionRows: [],
    });
    expect(r.workers[0].avgCompletionHours.status).toBe("NO_DATA");
    expect(r.workers[0].avgCompletionHours.value).toBeNull();
  });
});

// ── Assignments ───────────────────────────────────────────────────────────
describe("assignment analytics", () => {
  it("modes, rejection-driven reassignments, no-eligible count, acceptance rate", () => {
    const r = buildAssignmentAnalytics(window(), {
      offered: 10,
      accepted: 6,
      completed: 4,
      rejected: 2,
      cancelled: 1,
      reassigned: 3,
      auto: 8,
      manual: 1,
      override: 1,
      rejectionReassign: 2,
      noEligible: 1,
      scored: [],
    });
    expect(r.modes).toMatchObject({ auto: { value: 8 }, override: { value: 1 } });
    expect(r.rejectionDrivenReassignments.value).toBe(2);
    expect(r.noEligibleWorkerCases.value).toBe(1);
    expect(r.acceptanceRate).toMatchObject({ value: 0.6, status: "OK" });
    expect(r.overrideRate.value).toBeCloseTo(0.1, 4);
  });

  it("distance stats derive from the engine decision records; malformed skipped", () => {
    const r = buildAssignmentAnalytics(window(), {
      offered: 3,
      accepted: 3,
      completed: 0,
      rejected: 0,
      cancelled: 0,
      reassigned: 0,
      auto: 3,
      manual: 0,
      override: 0,
      rejectionReassign: 0,
      noEligible: 0,
      scored: [
        { decision: JSON.stringify({ selected: { distanceM: 120 } }) },
        { decision: JSON.stringify({ selected: { distanceM: 480 } }) },
        { decision: "not-json{" }, // malformed → excluded, never guessed
        { decision: JSON.stringify({ selected: { distanceM: null } }) }, // missing → excluded
      ],
    });
    expect(r.distance.sampleSize).toBe(2);
    expect(r.distance.avgMeters).toMatchObject({ value: 300, status: "OK" });
    expect(r.distance.medianMeters).toMatchObject({ value: 120, status: "OK" });
  });

  it("no scored assignments → NO_DATA distance", () => {
    const r = buildAssignmentAnalytics(window(), {
      offered: 0, accepted: 0, completed: 0, rejected: 0, cancelled: 0, reassigned: 0,
      auto: 0, manual: 0, override: 0, rejectionReassign: 0, noEligible: 0, scored: [],
    });
    expect(r.distance.avgMeters.status).toBe("NO_DATA");
    expect(r.acceptanceRate.status).toBe("NO_DATA");
  });
});

// ── Departments ───────────────────────────────────────────────────────────
describe("department analytics (descriptive, no rankings)", () => {
  it("per-department volume, SLA compliance, acceptance from complaint attribution", () => {
    const r = buildDepartmentAnalytics(window(), {
      departments: [
        { id: "d1", code: "PWD", name: "Public Works" },
        { id: "d2", code: "SWM", name: "Solid Waste" },
      ],
      volume: [
        { departmentId: "d1", _count: { _all: 10 } },
        { departmentId: "d2", _count: { _all: 5 } },
      ],
      open: [{ departmentId: "d1", _count: { _all: 4 } }],
      resolved: [{ departmentId: "d1", _count: { _all: 6 } }],
      breach: [{ departmentId: "d1", _count: { _all: 1 } }],
      durations: [
        { departmentId: "d1", createdAt: new Date("2026-09-29T00:00:00Z"), resolvedAt: new Date("2026-09-29T05:00:00Z") },
        { departmentId: "d1", createdAt: new Date("2026-09-29T00:00:00Z"), resolvedAt: new Date("2026-09-29T07:00:00Z") },
      ],
      createdAts: [{ departmentId: "d1", createdAt: new Date("2026-09-29T12:00:00Z") }],
      assignmentRows: [
        { status: "OFFERED", departmentId: "d1" },
        { status: "ACCEPTED", departmentId: "d1" },
        { status: "ACCEPTED", departmentId: "d1" },
        { status: "REASSIGNED", departmentId: "d2" },
      ],
    });
    const pwd = r.departments.find((d) => d.code === "PWD")!;
    expect(pwd.complaintVolume).toBe(10);
    expect(pwd.openWorkload).toBe(4);
    expect(pwd.resolutionRate).toMatchObject({ value: 0.6, status: "OK" });
    expect(pwd.slaCompliance).toMatchObject({ value: 0.75, status: "OK" }); // (4-1)/4
    expect(pwd.avgResolutionHours).toMatchObject({ value: 6, status: "OK" });
    expect(pwd.acceptanceRate).toMatchObject({ value: 0.6667, status: "OK" });
    expect(pwd.volumeSeries).toHaveLength(1);
    // SWM has volume but no resolution rows → honest statuses
    const swm = r.departments.find((d) => d.code === "SWM")!;
    expect(swm.avgResolutionHours.status).toBe("NO_DATA");
    expect(swm.slaCompliance.status).toBe("NO_DATA"); // 0 open → denominator 0
    expect(JSON.stringify(r)).not.toMatch(/best|worst|ranking/i);
  });
});

// ── Verification + Location ───────────────────────────────────────────────
describe("verification + location analytics (Phase 4 contract reuse)", () => {
  it("verification distribution, success and availability rates, per-provider confidence", () => {
    const r = buildVerificationAnalytics(window(), {
      byResult: [
        { verificationResult: "VERIFIED", _count: { _all: 6 } },
        { verificationResult: "FAILED", _count: { _all: 2 } },
        { verificationResult: "INCONCLUSIVE", _count: { _all: 1 } },
        { verificationResult: "UNAVAILABLE", _count: { _all: 1 } },
      ],
      neverVerified: 5,
      total: 15,
      confidenceRows: [
        { verificationProvider: "yolo-service", verificationConfidence: 0.9, verificationResult: "VERIFIED" },
        { verificationProvider: "yolo-service", verificationConfidence: 0.8, verificationResult: "VERIFIED" },
        { verificationProvider: "dev:heuristic", verificationConfidence: 0.6, verificationResult: "FAILED" },
      ],
    });
    expect(r.successRate).toMatchObject({ value: 0.75, status: "OK" }); // 6/(6+2)
    expect(r.availabilityRate).toMatchObject({ value: 0.9, status: "OK" }); // (6+2+1)/10
    expect(r.verificationRate).toMatchObject({ value: 0.6667, status: "OK" });
    expect(r.neverVerified.value).toBe(5);
    const yolo = r.avgConfidenceByProvider.find((p) => p.provider === "yolo-service")!;
    const dev = r.avgConfidenceByProvider.find((p) => p.provider === "dev:heuristic")!;
    expect(yolo).toMatchObject({ avgConfidence: 0.85, sampleSize: 2 });
    expect(dev).toMatchObject({ avgConfidence: 0.6, sampleSize: 1 });
  });

  it("MODEL and HEURISTIC confidence are never averaged together", () => {
    const r = buildVerificationAnalytics(window(), {
      byResult: [],
      neverVerified: 0,
      total: 0,
      confidenceRows: [{ verificationProvider: null, verificationConfidence: 0.5, verificationResult: "VERIFIED" }],
    });
    expect(r.avgConfidenceByProvider[0].provider).toBe("unknown");
  });

  it("location coverage + accuracy distribution reuses the Phase 4 policy", () => {
    const r = buildLocationAnalytics(window(), {
      rows: [
        { lat: 16.7, lng: 74.24, accuracyMeters: 10, locationSource: "GPS" }, // GOOD
        { lat: 16.7, lng: 74.24, accuracyMeters: 100, locationSource: "GPS" }, // DEGRADED
        { lat: 16.7, lng: 74.24, accuracyMeters: 5000, locationSource: null }, // POOR
        { lat: 16.7, lng: 74.24, accuracyMeters: null, locationSource: "MANUAL" }, // UNKNOWN
        { lat: null, lng: null, accuracyMeters: null, locationSource: null }, // no coords
      ],
      total: 5,
      bySource: [
        { locationSource: "GPS", _count: { _all: 2 } },
        { locationSource: "MANUAL", _count: { _all: 1 } },
      ],
    });
    expect(r.coordinateCoverage).toMatchObject({ value: 0.8, status: "OK" });
    expect(r.accuracy).toMatchObject({ good: { value: 1 }, degraded: { value: 1 }, poor: { value: 1 }, unknown: { value: 1 } });
    expect(r.bySource.value).toEqual([
      { key: "GPS", count: 2 },
      { key: "MANUAL", count: 1 },
    ]);
  });
});

// ── Trends ────────────────────────────────────────────────────────────────
describe("trends (descriptive deltas, never predictions)", () => {
  it("direction requires MIN_SAMPLE records in BOTH windows", () => {
    expect(directionFor(5, 2)).toBe("UP");
    expect(directionFor(2, 5)).toBe("DOWN");
    expect(directionFor(3, 3)).toBe("FLAT");
    expect(directionFor(1, 10)).toBe("INSUFFICIENT_DATA");
    expect(directionFor(10, 1)).toBe("INSUFFICIENT_DATA");
    expect(MIN_SAMPLE).toBe(2);
  });

  it("change values are null when insufficient; percentages relative to previous", () => {
    const t1 = buildTrend("complaint_volume", 1, 10);
    expect(t1.change).toBeNull();
    expect(t1.changePct).toBeNull();
    expect(t1.status).toBe("INSUFFICIENT_DATA");
    const t2 = buildTrend("complaint_volume", 8, 5);
    expect(t2).toMatchObject({ change: 3, changePct: 60, direction: "UP", status: "OK" });
    expect(t2.note).toContain("5 in the previous window");
  });

  it("an empty previous window is INSUFFICIENT_DATA (no direction from nothing)", () => {
    const t = buildTrend("resolutions", 4, 0);
    expect(t.change).toBeNull();
    expect(t.changePct).toBeNull();
    expect(t.direction).toBe("INSUFFICIENT_DATA");
    expect(t.note).toContain("previous window");
    // A real drop between two populated windows is a DOWN trend
    const drop = buildTrend("resolutions", 2, 5);
    expect(drop).toMatchObject({ change: -3, changePct: -60, direction: "DOWN", status: "OK" });
  });
});
