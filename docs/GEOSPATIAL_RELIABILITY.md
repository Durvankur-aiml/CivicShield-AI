# Geospatial Reliability — Location Architecture (Phase 4)

Workstream A of Phase 4. Goal: when someone asks *"where exactly was this complaint reported?"* the system answers with **authoritative coordinates + accuracy + capture time + source**, not merely "some address string".

---

## 1. The authority rule

> **Coordinates are the authoritative physical location. The address is descriptive metadata.**

Concretely:

- `Complaint.lat` / `Complaint.lng` (nullable) are the only location fields any distance, duplicate, map, or assignment logic may consume.
- `Complaint.address` is display/human context. It is never parsed into coordinates, never used to "correct" a GPS fix, and never the map marker source.
- Reverse geocoding can **add** an address; it can never **modify or destroy** coordinates.

## 2. Where coordinates originate and travel (the full pipeline)

| Stage | File | Behavior |
|---|---|---|
| Capture (browser) | `src/app/citizen/submit/page.tsx` | `navigator.geolocation.getCurrentPosition` with `enableHighAccuracy: true`, 10 s timeout, 5 min `maximumAge`. Captures `coords.accuracy` and `pos.timestamp` verbatim. |
| Client-side guard | same file | Coordinates are re-validated against finite/range rules even though the browser is "trusted" — a broken device fix is refused, not stored. |
| Submit | same file | `lat`/`lng`/`accuracyMeters`/`locationCapturedAt`/`locationSource` are sent **only when actually known**. No silent fallback location, ever. |
| Server validation | `src/app/api/complaints/route.ts` | `parseCoordinateField` + `validateLat`/`validateLng` at the domain boundary → `400 INVALID_COORDINATES` (machine-readable) for NaN/±Infinity/range/garbage strings. Absent fields stay absent. |
| Normalization | `src/lib/location.ts` (`normalizeLocation`) | Clamps accuracy to the policy ceiling, canonicalizes source, validates capture time. |
| Reverse geocode (optional) | `src/lib/geocode.ts` | `describeCoordinatesCached` — best-effort address metadata only. Fills `address`/`ward` **only if the citizen did not type one**. Failure → `null`, coordinates untouched. |
| Persistence | `src/lib/agent/orchestrator.ts` → `createComplaint` | `lat`, `lng`, `accuracyMeters`, `locationSource`, `locationCapturedAt` stored as-is (no rounding, no swapping). |
| Consumption | `duplicate.ts`, `assignmentDomain.ts`, `CivicMap.tsx`, detail page | All null-safe; see §5–§7. |

## 3. Coordinate validation (server-side, mandatory)

Implemented in `src/lib/location.ts` and re-exported as zod schema in `src/lib/constants.ts` (`complaintInput`):

- Latitude: numeric, finite, −90..90.
- Longitude: numeric, finite, −180..180.
- Accuracy: numeric, finite, ≥ 0 (≤ 100 000 at the zod edge, clamped to policy in `normalizeLocation`).
- Rejected: `NaN`, `±Infinity`, out-of-range, non-numeric strings, `null`-where-provided-garbage.
- The route answers invalid coordinates with `400 { code: "INVALID_COORDINATES" }` so clients can react programmatically.
- **Lat/lng swap:** the canonical order is `(lat, lng)` everywhere. The only external boundary is the browser Geolocation API, whose `coords.latitude`/`coords.longitude` map 1:1 — no provider in the pipeline uses `(lng, lat)` ordering. `tests/location.test.ts` pins the `haversineMeters` argument order.

## 4. Accuracy policy (centralized — no scattered magic numbers)

Product policy thresholds live in `src/lib/constants.ts` and are **explicitly product decisions, not scientific truth**:

| Level | Threshold | Meaning |
|---|---|---|
| `GOOD` | ≤ `ACCURACY_GOOD_METERS` (25 m) | GPS-grade; safe for duplicate + assignment distance |
| `DEGRADED` | ≤ `ACCURACY_DEGRADED_METERS` (150 m) | Usable, flagged as approximate |
| `POOR` | > 150 m (clamped at `ACCURACY_MAX_METERS` = 10 km) | Should be reconfirmed |
| `UNKNOWN` | device reported no accuracy | Absence is **not** precision |

- `accuracyLevel()` / `isUsableAccuracy()` in `src/lib/location.ts` are the only classifiers.
- The browser-reported value is stored verbatim (clamped only at 10 km to blunt hostile/buggy clients). The submit UI shows the true `±N m` badge, color-coded by the same policy. Nothing ever fabricates "±5 m".

## 5. Location-less complaints (first-class state)

A complaint may exist with `lat = null, lng = null`:

- **Duplicate intelligence** (`src/lib/duplicate.ts`): returns no match when either side lacks coordinates — proximity can never be invented.
- **Assignment engine** (`src/lib/assignmentDomain.ts`): distance factor falls back to its existing neutral 0.5 weight ("no complaint coordinates — neutral"). Phase 2B **weights are untouched**.
- **Map** (`src/components/CivicMap.tsx`): location-less complaints are simply not plotted; the counter reflects reality.
- **Detail page**: shows "Not captured" instead of fake numbers.

## 6. Reverse geocoding

- A clean provider boundary exists in `src/lib/geocode.ts` (`ReverseGeocoder` interface + `getReverseGeocoder()`).
- The default provider is `NoopReverseGeocoder` — **no external geocoding service is configured or called in this phase** (spec A10 forbids blindly adding one). A real provider (e.g. Nominatim) implements the same interface and registers at the single `getReverseGeocoder()` seam.
- Contract enforced by code + tests: reverse geocoding returns **address metadata only** (never coordinates), never throws, and a failure leaves valid coordinates fully intact.
- A small TTL cache (10 min, 500 entries, keys rounded for cache lookup only) prevents repeated lookups for the same coordinates.

## 7. Distance calculations

- Single implementation: `haversineMeters` in `src/lib/duplicate.ts` (Phase 1 duplicate intelligence). No second distance implementation was created.
- Assignment scoring uses it with **authoritative complaint coordinates** and worker `baseLat/baseLng`; when either side is missing, distance is neutral — never fabricated.

## 8. Machine-readable geolocation errors

`LOCATION_ERROR_CODES` in `src/lib/location.ts`:

`GEO_UNSUPPORTED` · `PERMISSION_DENIED` · `POSITION_UNAVAILABLE` · `TIMEOUT` · `INVALID_COORDINATES` · `UNKNOWN`

- `locationErrorCode()` maps `GeolocationPositionError.code` (1/2/3) to these stable codes.
- The submit UI renders a `role="alert"` panel with `data-loc-error=<CODE>` — friendly copy today, machine-consumable tomorrow.
- A location failure **never crashes the complaint flow** and **never substitutes a default location**: the user can retry or continue with a typed landmark. This replaced the previous behavior of silently snapping to the demo city center.

## 9. Location privacy

- Coordinates are stored with full precision but **displayed rounded** (5–6 decimals) in the UI; the address (when present) is the human-facing location.
- No precise coordinates are written to logs: agent-activity details carry refCodes/verdicts, not lat/lng dumps; the geocode cache stores address metadata only.
- Existing RBAC is unchanged: citizens see their own complaints, workers the location needed for assigned work, officials per existing rules. No new coordinate-bearing endpoint was added.

## 10. Capture time / staleness

- `locationCapturedAt` preserves the device reading time (`pos.timestamp`).
- `isLocationFresh()` (policy: 30 min, `LOCATION_FRESHNESS_MS`) classifies staleness for consumers; an unknown capture time is treated as **not fresh**, and future timestamps are never fresh.

## 11. Verification status

| Capability | Status |
|---|---|
| Server-side coordinate/accuracy validation | **VERIFIED** (tests/location.test.ts) |
| Accuracy policy centralized | **VERIFIED** |
| Honest GPS capture (accuracy + timestamp + source) | **VERIFIED** at module level — BROWSER GPS INTEGRATION NOT TESTED (no device sensors in this environment) |
| No silent fallback location | **VERIFIED** (fallback removed from submit page; only `DEMO_MAP_CENTER` viewport default remains) |
| Reverse-geocode failure isolation | **VERIFIED** (noop boundary; no external provider configured) |
| Null-safe map / duplicate / assignment | **VERIFIED** |
| Live PostgreSQL persistence of new fields | **NOT TESTED** (no live DB/Docker in this environment) |
| Real reverse-geocode provider | **NOT IMPLEMENTED** (boundary + noop only, by design) |
| Map-pin (MAP_PIN) capture UI | **NOT IMPLEMENTED** (source taxonomy supports it) |
