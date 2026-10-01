/**
 * Duplicate intelligence — original implementation.
 * Signals: geographic proximity (Haversine), same category, recent time window,
 * and description token similarity (Jaccard on meaningful words).
 */

const EARTH_RADIUS_M = 6371000;

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "is", "are", "there", "this", "that", "at", "in", "on", "of",
  "to", "near", "very", "please", "it", "its", "with", "for", "from", "has", "have", "be",
  "hai", "nahi", "kya", "mein", "me", "yaha", "yahan", "par", "ka", "ki", "ke", "ko", "se",
  "aahe", "ahe", "kade", "dilha", "bigda", "bada", "ek", "gav", "rasta", "rasta",
]);

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

export function jaccardSimilarity(a: string, b: string): number {
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

export type DuplicateCandidate = {
  id: string;
  refCode: string;
  category: string;
  description: string;
  lat: number | null; // Phase 4: coordinates may be absent on a complaint
  lng: number | null;
  createdAt: Date;
};

export type DuplicateMatch = {
  candidate: DuplicateCandidate;
  distanceM: number;
  textSimilarity: number;
  score: number; // 0..1 combined
  reasons: string[];
};

export type DuplicateOptions = {
  radiusM?: number;
  windowHours?: number;
  sameCategoryRequired?: boolean;
};

/**
 * Finds the best matching complaint for a new report.
 * Combined score: proximity (max 0.45) + category match (0.2) + recency (0.1) + text similarity (0.25).
 * score >= 0.55 is treated as "potentially the same issue".
 *
 * Phase 4: proximity requires real coordinates on BOTH sides — a complaint
 * without coordinates can never produce a geographic match (no invented
 * distances), so location-less reports simply return no duplicate.
 */
export function findBestDuplicate(
  incoming: { category: string; description: string; lat: number | null; lng: number | null; createdAt: Date },
  candidates: DuplicateCandidate[],
  opts: DuplicateOptions = {}
): DuplicateMatch | null {
  if (incoming.lat == null || incoming.lng == null) return null;
  const radiusM = opts.radiusM ?? 150;
  const windowHours = opts.windowHours ?? 72;
  const sameCategoryRequired = opts.sameCategoryRequired ?? true;

  let best: DuplicateMatch | null = null;
  for (const c of candidates) {
    if (c.lat == null || c.lng == null) continue;
    if (sameCategoryRequired && c.category !== incoming.category) continue;
    const ageH = (incoming.createdAt.getTime() - c.createdAt.getTime()) / 3600_000;
    if (ageH < -1 || ageH > windowHours) continue;

    const distanceM = haversineMeters(incoming.lat, incoming.lng, c.lat, c.lng);
    if (distanceM > radiusM) continue;

    const proximity = 1 - distanceM / radiusM; // 1 at same spot, 0 at radius edge
    const recency = 1 - Math.min(1, Math.max(0, ageH) / windowHours);
    const similarity = jaccardSimilarity(incoming.description, c.description);
    const catMatch = c.category === incoming.category ? 1 : 0;

    const score = proximity * 0.45 + catMatch * 0.2 + recency * 0.1 + similarity * 0.25;

    const match: DuplicateMatch = {
      candidate: c,
      distanceM: Math.round(distanceM),
      textSimilarity: Number(similarity.toFixed(2)),
      score: Number(score.toFixed(2)),
      reasons: [
        `${distanceM.toFixed(0)}m from existing report ${c.refCode}`,
        `same category (${c.category})`,
        `reported ${ageH < 24 ? `${Math.max(1, Math.round(ageH))}h` : `${Math.round(ageH / 24)}d`} ago`,
        `description similarity ${(similarity * 100).toFixed(0)}%`,
      ],
    };
    if (!best || match.score > best.score) best = match;
  }
  return best && best.score >= 0.55 ? best : null;
}
