import { z } from "zod";

/** All enum-like values in one place — validated strings, kept provider-portable. */

export const ROLES = ["CITIZEN", "WORKER", "OFFICIAL"] as const;
export const CATEGORIES = [
  "POTHOLE",
  "GARBAGE",
  "WATERLOGGING",
  "STREETLIGHT",
  "ROAD_DAMAGE",
  "WASTE_OVERFLOW",
  "OTHER",
] as const;
export const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const STATUSES = [
  "RECEIVED",
  "ASSIGNED",
  "IN_PROGRESS",
  "VERIFICATION",
  "RESOLVED",
  "REOPENED",
  "ESCALATED",
  "CLOSED",
] as const;
export const DEPARTMENT_CODES = ["PWD", "SWM", "ELECT", "WATER", "HEALTH", "GEN"] as const;
export const LANGUAGES = ["en", "hi", "mr"] as const;

// ── Geospatial reliability (Phase 4) ───────────────────────────────────

/** How a complaint's authoritative coordinates were obtained. */
export const LOCATION_SOURCES = ["GPS", "MANUAL", "MAP_PIN", "UNKNOWN"] as const;
export type LocationSource = (typeof LOCATION_SOURCES)[number];

/**
 * Product accuracy policy for device-provided coordinates (meters).
 * These are PRODUCT thresholds for a municipal demo app — they are NOT a
 * scientifically universal standard. Centralized here so no "accuracy > 100"
 * magic numbers are scattered through random files.
 */
export const ACCURACY_GOOD_METERS = 25; // GPS-grade — safe for duplicate + assignment distance
export const ACCURACY_DEGRADED_METERS = 150; // coarse fix (wifi/cell) — usable, flag as approximate
export const ACCURACY_MAX_METERS = 10000; // beyond this the fix is useless — require reconfirmation
export const ACCURACY_LEVELS = ["GOOD", "DEGRADED", "POOR", "UNKNOWN"] as const;
export type AccuracyLevel = (typeof ACCURACY_LEVELS)[number];

/**
 * The only hardcoded coordinates allowed in the app: the demo map center
 * (Kolhapur). These are a map VIEWPORT default — NEVER a substitute for a
 * real location reading. Submit flow must send no coordinates rather than
 * silently substituting these.
 */
export const DEMO_MAP_CENTER = { lat: 16.6952, lng: 74.4574 } as const;

/**
 * Vision: machine-readable confidence label on a verification verdict.
 * Deliberately NOT 0..1 inference values — dev providers must not dress
 * heuristic scores up as model confidence (no fake 0.87s).
 */
export const CONFIDENCE_KINDS = ["MODEL", "HEURISTIC", "UNKNOWN"] as const;
export type ConfidenceKind = (typeof CONFIDENCE_KINDS)[number];

// ── Worker domain (Phase 2A) ────────────────────────────────────────────

/** WorkerProfile operational state. */
export const WORKER_AVAILABILITY = ["AVAILABLE", "OFF_DUTY", "SUSPENDED"] as const;
/** WorkerApplication review lifecycle. */
export const APPLICATION_STATUS = ["PENDING", "APPROVED", "REJECTED"] as const;

/** Structured skill taxonomy (drives review UI + future assignment matching). */
export const WORKER_SKILLS = [
  "ROAD_REPAIR",
  "ASPHALT_LAYING",
  "DRAINAGE_CLEARING",
  "WASTE_COLLECTION",
  "WASTE_SORTING",
  "HAZMAT_HANDLING",
  "ELECTRICAL_REPAIR",
  "STREETLIGHT_MAINTENANCE",
  "PLUMBING",
  "WATER_PUMP_OPERATION",
  "PEST_CONTROL",
  "SANITATION_INSPECTION",
] as const;

export const WORKER_EQUIPMENT = [
  "COMPACTOR_TRUCK",
  "DUMPER",
  "JCB_EXCAVATOR",
  "ROAD_ROLLER",
  "POLE_TRUCK",
  "GENERATOR",
  "WATER_PUMP",
  "CHAINSAW",
  "DRILL",
  "SAFETY_HARNESS",
] as const;

export const workerAvailabilityLabels: Record<string, string> = {
  AVAILABLE: "Available",
  OFF_DUTY: "Off duty",
  SUSPENDED: "Suspended",
};

export const workerSkillLabels: Record<string, string> = {
  ROAD_REPAIR: "Road repair",
  ASPHALT_LAYING: "Asphalt laying",
  DRAINAGE_CLEARING: "Drainage clearing",
  WASTE_COLLECTION: "Waste collection",
  WASTE_SORTING: "Waste sorting",
  HAZMAT_HANDLING: "Hazmat handling",
  ELECTRICAL_REPAIR: "Electrical repair",
  STREETLIGHT_MAINTENANCE: "Streetlight maintenance",
  PLUMBING: "Plumbing",
  WATER_PUMP_OPERATION: "Water pump operation",
  PEST_CONTROL: "Pest control",
  SANITATION_INSPECTION: "Sanitation inspection",
};

export const workerEquipmentLabels: Record<string, string> = {
  COMPACTOR_TRUCK: "Compactor truck",
  DUMPER: "Dumper",
  JCB_EXCAVATOR: "JCB excavator",
  ROAD_ROLLER: "Road roller",
  POLE_TRUCK: "Pole truck",
  GENERATOR: "Generator",
  WATER_PUMP: "Water pump",
  CHAINSAW: "Chainsaw",
  DRILL: "Drill",
  SAFETY_HARNESS: "Safety harness",
};

/**
 * Employee ID shape: 2–10 uppercase alphanumerics with an optional inner
 * hyphen (e.g. "PWD-014", "SWM112", "E102"). Normalized to uppercase —
 * the application-level normalization mirrors what the DB constraint
 * relies on, so "pwd-014" and "PWD-014" are the same identity.
 */
export const EMPLOYEE_ID_REGEX = /^[A-Z0-9]{2,10}(-[A-Z0-9]{1,8})?$/;

export const SLA_HOURS: Record<string, number> = {
  CRITICAL: Number(process.env.SLA_HOURS_CRITICAL ?? 12),
  HIGH: Number(process.env.SLA_HOURS_HIGH ?? 24),
  MEDIUM: Number(process.env.SLA_HOURS_MEDIUM ?? 48),
  LOW: Number(process.env.SLA_HOURS_LOW ?? 72),
};

/**
 * SLA warning threshold (Phase 3): a warning fires once this fraction of the
 * SLA window has been consumed while the work is not yet completed.
 * Centralized here — the sweep, tests, and docs all reference this constant;
 * do not scatter magic numbers.
 */
export const SLA_WARNING_FRACTION = 0.75;

/** In-app notification types (Phase 3) — repo convention: validated strings. */
export const NOTIFICATION_TYPES = [
  "ASSIGNMENT_OFFERED",
  "ASSIGNMENT_ACCEPTED",
  "ASSIGNMENT_REJECTED",
  "ASSIGNMENT_REASSIGNED",
  "ASSIGNMENT_STARTED",
  "ASSIGNMENT_COMPLETED",
  "SLA_WARNING",
  "SLA_BREACH",
  "ESCALATION",
  "OFFICIAL_OVERRIDE",
  "SYSTEM",
] as const;

/**
 * Operational SLA states (Phase 3). These are ALWAYS DERIVED from
 * authoritative timestamps/state (deriveSlaState in src/lib/slaDomain.ts) —
 * never stored as a redundant authoritative column, so stored state cannot
 * contradict reality.
 */
export const SLA_STATES = ["ON_TRACK", "WARNING", "BREACHED", "ESCALATED", "RESOLVED"] as const;

export const categoryLabels: Record<string, string> = {
  POTHOLE: "Pothole",
  GARBAGE: "Garbage",
  WATERLOGGING: "Waterlogging",
  STREETLIGHT: "Damaged Streetlight",
  ROAD_DAMAGE: "Road Damage",
  WASTE_OVERFLOW: "Overflowing Waste",
  OTHER: "Other Civic Issue",
};

export const statusLabels: Record<string, string> = {
  RECEIVED: "Received",
  ASSIGNED: "Assigned",
  IN_PROGRESS: "In Progress",
  VERIFICATION: "Verification",
  RESOLVED: "Resolved",
  REOPENED: "Reopened",
  ESCALATED: "Escalated",
  CLOSED: "Closed",
};

export const severityLabels: Record<string, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  CRITICAL: "Critical",
};

/** Category → department routing table (original mapping for this project). */
export const CATEGORY_DEPARTMENT: Record<string, string> = {
  POTHOLE: "PWD",
  ROAD_DAMAGE: "PWD",
  WATERLOGGING: "WATER",
  GARBAGE: "SWM",
  WASTE_OVERFLOW: "SWM",
  STREETLIGHT: "ELECT",
  OTHER: "GEN",
};

export const complaintInput = z.object({
  description: z.string().trim().min(10, "Describe the issue in at least 10 characters").max(2000),
  category: z.enum(CATEGORIES).optional(),
  // Coordinates are optional-but-validated: present → must be finite and in
  // range; absent → the complaint is created without a physical location
  // rather than silently landing at (0,0) or a demo center.
  lat: coordinateNumber(-90, 90).optional(),
  lng: coordinateNumber(-180, 180).optional(),
  // Honest GPS capture metadata (Phase 4). Never trusted blindly: the route
  // clamps accuracy through the central accuracy policy in src/lib/location.ts.
  accuracyMeters: z.number().min(0).max(100000).finite().nullable().optional(),
  locationSource: z.enum(LOCATION_SOURCES).optional(),
  locationCapturedAt: z.coerce.date().nullable().optional(),
  address: z.string().trim().max(300).optional(),
  ward: z.string().trim().max(80).optional(),
  language: z.enum(LANGUAGES).default("en"),
  transcript: z.string().max(4000).optional(),
  photoKey: z.string().max(300).optional(),
  source: z.enum(["CITIZEN", "DEMO"]).default("CITIZEN"),
});

/**
 * Finite-number validation for coordinates shared by complaintInput. Rejects
 * NaN / ±Infinity (zod's z.number() alone accepts NaN without .finite(), and
 * a bare Number("abc") coercion in the route would slip through as NaN).
 */
export function coordinateNumber(min: number, max: number) {
  return z.number().min(min).max(max).finite();
}

// ── Worker domain validation (Phase 2A) ────────────────────────────────

export const employeeIdSchema = z
  .string()
  .trim()
  .min(2, "Employee ID must be 2–12 characters")
  .max(19, "Employee ID must be 2–12 characters")
  .transform((v) => v.toUpperCase())
  .refine((v) => EMPLOYEE_ID_REGEX.test(v), "Employee ID must be like PWD-014, SWM112 or E102");

export const workerApplicationInput = z.object({
  employeeId: employeeIdSchema,
  departmentCode: z.enum(DEPARTMENT_CODES),
  designation: z.string().trim().min(2).max(80).optional(),
  skills: z.array(z.enum(WORKER_SKILLS)).max(8, "At most 8 skills").default([]),
  equipment: z.array(z.enum(WORKER_EQUIPMENT)).max(8, "At most 8 equipment items").default([]),
  experience: z.string().trim().max(500).optional(),
  serviceAreas: z.array(z.string().trim().min(1).max(60)).max(10, "At most 10 service areas").default([]),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9\s-]{5,17}$/, "Enter a valid phone number")
    .optional(),
  workEmail: z.string().trim().email().max(120).optional(),
});

export const workerApplicationReviewInput = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  rejectionReason: z.string().trim().min(5, "Provide a rejection reason (min 5 characters)").max(300).optional(),
});

export type WorkerApplicationInput = z.infer<typeof workerApplicationInput>;
export type WorkerApplicationReviewInput = z.infer<typeof workerApplicationReviewInput>;

export type ComplaintInput = z.infer<typeof complaintInput>;
