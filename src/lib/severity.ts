import { SLA_HOURS } from "./constants";

/**
 * Original severity + priority engine.
 * Deterministic and explainable: every point contribution is returned so the
 * Agent log can show WHY a severity/priority was chosen — never a black box.
 */

export type SeverityFactors = {
  base: number; // category baseline risk 1..5
  keywordPoints: number; // urgency language in description
  visionPoints: number; // vision confidence contribution
  contextPoints: number; // sensitive-area / road-importance hints
};

export type SeverityResult = {
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  score: number; // 0..10
  factors: SeverityFactors;
  reasons: string[];
};

const CATEGORY_BASE: Record<string, number> = {
  POTHOLE: 3,
  ROAD_DAMAGE: 4,
  WATERLOGGING: 4,
  GARBAGE: 2,
  WASTE_OVERFLOW: 3,
  STREETLIGHT: 2,
  OTHER: 2,
};

const URGENCY_KEYWORDS: Array<{ words: string[]; points: number; label: string }> = [
  { words: ["accident", "crash", "injured", "injury"], points: 3, label: "mentions accidents/injuries" },
  { words: ["dangerous", "hazard", "unsafe", "risk", "life"], points: 2.5, label: "describes a safety hazard" },
  { words: ["child", "school", "hospital", "ambulance", "emergency"], points: 2, label: "near a sensitive area (school/hospital)" },
  { words: ["deep", "huge", "large", "blocked", "overflowing", "flood", "drowning"], points: 1.5, label: "reports large scale / blockage" },
  { words: ["urgent", "immediately", "daily", "everyday", "weeks", "months"], points: 1, label: "long-standing or urgent language" },
  { words: ["night", "dark", "evening"], points: 1, label: "visibility concerns at night" },
];

const AREA_KEYWORDS = ["main road", "highway", "junction", "intersection", "market", "bus stand", "station", "bridge"];

export function computeSeverity(category: string, description: string, visionConfidence?: number | null): SeverityResult {
  const base = CATEGORY_BASE[category] ?? 2;
  const text = description.toLowerCase();
  let keywordPoints = 0;
  const reasons: string[] = [];

  for (const grp of URGENCY_KEYWORDS) {
    if (grp.words.some((w) => text.includes(w))) {
      keywordPoints += grp.points;
      reasons.push(`Description ${grp.label}`);
    }
  }

  const visionPoints = visionConfidence != null ? Math.min(2, visionConfidence * 2) : 0;
  if (visionConfidence != null) {
    reasons.push(`Vision model confidence ${(visionConfidence * 100).toFixed(0)}%`);
  }

  let contextPoints = 0;
  if (AREA_KEYWORDS.some((a) => text.includes(a))) {
    contextPoints += 1.5;
    reasons.push("Located on a major road / public junction");
  }

  const score = Math.max(0, Math.min(10, base + keywordPoints + visionPoints + contextPoints));
  const severity = score >= 8 ? "CRITICAL" : score >= 6 ? "HIGH" : score >= 3.5 ? "MEDIUM" : "LOW";
  if (reasons.length === 0) reasons.push("Standard category baseline risk");
  return { severity, score, factors: { base, keywordPoints, visionPoints, contextPoints }, reasons };
}

export type PriorityResult = { priority: number; reasons: string[] };

/**
 * Priority 1..100 combines severity with corroborating duplicate reports —
 * more nearby reports of the same issue raise urgency of the whole cluster.
 */
export function computePriority(
  severity: string,
  opts: { nearbyReports?: number; description?: string } = {}
): PriorityResult {
  const severityBase: Record<string, number> = { LOW: 25, MEDIUM: 50, HIGH: 75, CRITICAL: 90 };
  let priority = severityBase[severity] ?? 40;
  const reasons: string[] = [`${severity} severity baseline`];

  const nearby = opts.nearbyReports ?? 0;
  if (nearby > 0) {
    const bump = Math.min(10, nearby * 3);
    priority += bump;
    reasons.push(`${nearby} nearby report(s) corroborate this issue (+${bump})`);
  }

  const text = (opts.description ?? "").toLowerCase();
  if (AREA_KEYWORDS.some((a) => text.includes(a))) {
    priority += 5;
    reasons.push("High-traffic public location (+5)");
  }

  return { priority: Math.max(1, Math.min(100, Math.round(priority))), reasons };
}

export function slaDueAtFor(severity: string, from: Date = new Date()): { hours: number; dueAt: Date } {
  const hours = SLA_HOURS[severity] ?? 72;
  return { hours, dueAt: new Date(from.getTime() + hours * 3600_000) };
}
