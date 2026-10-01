/**
 * Time-window handling for analytics (Phase 5).
 *
 * TIMESTAMP CONVENTION (documented in docs/CIVIC_INTELLIGENCE.md):
 * - The database stores UTC instants (Prisma DateTime). All filtering uses
 *   UTC Date objects — never strings parsed by the server's local timezone.
 * - A window is HALF-OPEN: [from, to) — `from` inclusive, `to` exclusive.
 *   This makes adjacent windows non-overlapping and sums reproducible.
 * - Windows are bounded: `to` may not be in the future and the range may not
 *   exceed MAX_RANGE_DAYS, so no query can scan the full history unbounded
 *   without an explicit caller decision.
 */

import { ApiError } from "../auth";

export const WINDOW_PRESETS = ["24h", "7d", "30d", "90d"] as const;
export type WindowPreset = (typeof WINDOW_PRESETS)[number];

/** Hard cap so analytics queries stay bounded (spec §15). */
export const MAX_RANGE_DAYS = 366;

export type TimeWindow = {
  from: Date;
  to: Date;
  preset: WindowPreset | "custom";
};

/** Maps to a 400 JSON response via the shared handleRouteError pipeline. */
export class TimeWindowError extends ApiError {
  constructor(message: string) {
    super(400, message);
  }
}

const HOURS = {
  "24h": 24,
  "7d": 7 * 24,
  "30d": 30 * 24,
  "90d": 90 * 24,
} as const;

/**
 * Parses a window from query parameters.
 * - `window=7d` (or 24h/30d/90d) → trailing window ending at `to`.
 * - `from` + `to` (ISO 8601) → custom range, validated and bounded.
 * Absent `to` defaults to "now". Malformed, reversed, future or oversized
 * ranges throw TimeWindowError (route maps to 400).
 */
export function parseWindow(params: URLSearchParams, now: Date = new Date()): TimeWindow {
  const preset = params.get("window");
  const fromRaw = params.get("from");
  const toRaw = params.get("to");

  if (fromRaw != null && toRaw != null) {
    const from = parseIso(fromRaw, "from");
    const to = parseIso(toRaw, "to");
    if (from.getTime() >= to.getTime()) {
      throw new TimeWindowError("Invalid range: 'from' must be before 'to'");
    }
    if (to.getTime() > now.getTime() + 60_000) {
      throw new TimeWindowError("Invalid range: 'to' may not be in the future");
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
      throw new TimeWindowError(`Invalid range: maximum ${MAX_RANGE_DAYS} days`);
    }
    return { from, to, preset: "custom" };
  }

  if (fromRaw != null || toRaw != null) {
    throw new TimeWindowError("Provide both 'from' and 'to', or use the 'window' parameter");
  }

  const hours = HOURS[(preset ?? "") as WindowPreset];
  if (!hours) {
    throw new TimeWindowError(`Unknown window '${preset ?? ""}'. Use one of: ${WINDOW_PRESETS.join(", ")} or from/to.`);
  }
  const to = now;
  const from = new Date(to.getTime() - hours * 3_600_000);
  return { from, to, preset: preset as WindowPreset };
}

function parseIso(value: string, field: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new TimeWindowError(`Invalid ISO timestamp for '${field}'`);
  }
  return d;
}
