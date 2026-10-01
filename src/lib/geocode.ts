/**
 * Reverse-geocoding provider boundary (Phase 4, Workstream A).
 *
 * A reverse geocoder transforms coordinates → human-readable ADDRESS METADATA.
 * The address is descriptive; it NEVER replaces or corrects the coordinates,
 * and a geocode failure must never destroy valid coordinates.
 *
 * No concrete provider is configured in this phase (spec A10: do not blindly
 * add a random provider). The noop provider makes the boundary explicit and
 * testable; a real provider (e.g. Nominatim) implements the same interface and
 * is registered here — nothing else in the codebase changes.
 */
import type { Coordinates } from "./location";

export type ReverseGeocodeResult = {
  /** Descriptive label, e.g. "Near bus stand, Ward 2, Kolhapur". */
  address: string;
  /** Sub-city / ward hint for routing, when the provider offers one. */
  ward?: string;
  provider: string;
} | null;

export interface ReverseGeocoder {
  readonly id: string;
  reverse(input: Coordinates): Promise<ReverseGeocodeResult>;
}

/** Default provider: performs no lookup, honestly reports why. */
export class NoopReverseGeocoder implements ReverseGeocoder {
  readonly id = "noop";

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async reverse(_input?: Coordinates): Promise<ReverseGeocodeResult> {
    return null;
  }
}

/** Returns the configured geocoder. No external provider is set up yet. */
export function getReverseGeocoder(): ReverseGeocoder {
  return new NoopReverseGeocoder();
}

/**
 * Resolves address metadata for coordinates without ever throwing and without
 * ever returning coordinates — failure degrades to null and the caller keeps
 * its valid coordinates untouched.
 */
export async function describeCoordinates(input: Coordinates): Promise<ReverseGeocodeResult> {
  const geocoder = getReverseGeocoder();
  try {
    return await geocoder.reverse(input);
  } catch {
    return null; // address metadata is optional; coordinates remain authoritative
  }
}

/**
 * Small TTL cache so identical coordinates are not re-geocoded repeatedly
 * within one process (performance rule I). Keyed by rounded coordinates —
 * the rounding is for CACHE KEYS ONLY, never for stored data.
 */
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; result: ReverseGeocodeResult }>();

function cacheKey(c: Coordinates): string {
  return `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`;
}

export async function describeCoordinatesCached(input: Coordinates): Promise<ReverseGeocodeResult> {
  const key = cacheKey(input);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;
  const result = await describeCoordinates(input);
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), result });
  return result;
}

/** Test helper: clear the memo cache between tests. */
export function clearGeocodeCache(): void {
  cache.clear();
}
