import type { VisionDetection, ResolutionVerdict } from "./ai/types";

/**
 * Explicit provider states (Phase 4, Workstream B). Repo convention keeps
 * honesty in the provider-id string ("dev:hint", "dev:heuristic",
 * "yolo-service"); providerState adds a machine-readable dimension for
 * dashboards, health, and the UI so "development/mock" can never pass as a
 * real model.
 */
export const PROVIDER_STATES = ["REAL_YOLO", "DEV_HINT", "UNAVAILABLE", "ERROR"] as const;
export type ProviderState = (typeof PROVIDER_STATES)[number];

export function providerStateFor(providerId: string): ProviderState {
  if (providerId === "yolo-service") return "REAL_YOLO";
  if (providerId.startsWith("dev:")) return "DEV_HINT";
  return "UNAVAILABLE";
}

/**
 * Structured verification outcome (B7). verified:boolean is preserved for
 * backwards compatibility; verificationResult carries the explicit state so
 * "inconclusive" or "verifier unavailable" can never be presented as an
 * approval or a genuine failure.
 */
export const VERIFICATION_RESULTS = ["VERIFIED", "FAILED", "INCONCLUSIVE", "UNAVAILABLE"] as const;
export type VerificationResultState = (typeof VERIFICATION_RESULTS)[number];

/**
 * Fail-safe derivation (B10): anything that is not an explicit model-verified
 * pass maps to a non-approving state. UNAVAILABLE / ERROR verdicts never
 * auto-approve a repair.
 */
export function verificationResultFor(verdict: Pick<ResolutionVerdict, "verified" | "provider">): VerificationResultState {
  if (verdict.provider === "unavailable") return "UNAVAILABLE";
  return verdict.verified ? "VERIFIED" : "FAILED";
}

/** Explicit "verifier could not run" verdict — always fail-safe. */
export function unavailableVerdict(reason: string): ResolutionVerdict {
  return {
    verified: false,
    confidence: 0,
    reason,
    provider: "unavailable",
    confidenceKind: "UNKNOWN",
    verificationResult: "UNAVAILABLE",
  };
}

/**
 * Route-level outcome policy (fail-safe, B10): only VERIFIED resolves a case;
 * FAILED reopens (with escalation policy preserved from Phase 3); everything
 * else HOLDS at VERIFICATION for manual review — no approval, no punishment.
 * Pure function so the policy is unit-testable without HTTP or Prisma.
 */
export type VerificationDecision = { outcome: "RESOLVE" | "REOPEN" | "HOLD"; escalate: boolean };

export function decisionForVerification(
  result: VerificationResultState,
  opts: { reopenedCount: number; severity: string }
): VerificationDecision {
  if (result === "VERIFIED") return { outcome: "RESOLVE", escalate: false };
  if (result === "FAILED") {
    const escalate = opts.reopenedCount >= 2 || opts.severity === "CRITICAL" || opts.severity === "HIGH";
    return { outcome: "REOPEN", escalate };
  }
  return { outcome: "HOLD", escalate: false };
}

/** Stronger result type for internal callers (route + agent activity detail). */
export type DetailedVerification = ResolutionVerdict & {
  detections: VisionDetection[];
  model?: string;
  beforeAvailable: boolean;
  beforeMime: string | null;
};

/** Structural image validation shared by all providers (B5). */
export type ImageInspection =
  | { ok: true; format: string }
  | { ok: false; error: string };

export function inspectImageBytes(bytes: Buffer): ImageInspection {
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  if (bytes.length < 12) return { ok: false, error: "Image file is too small to be valid" };
  if (starts([0xff, 0xd8, 0xff])) return { ok: true, format: "image/jpeg" };
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ok: true, format: "image/png" };
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return { ok: true, format: "image/webp" };
  if (starts([0x66, 0x74, 0x79, 0x70], 4)) {
    // ISOBMFF family: HEIC brands live at offset 8.
    const brand = bytes.subarray(8, 12).toString("latin1");
    if (brand.startsWith("heic") || brand.startsWith("heix") || brand.startsWith("mif1") || brand.startsWith("msf1")) {
      return { ok: true, format: "image/heic" };
    }
    return { ok: false, error: "Unsupported image format" };
  }
  return { ok: false, error: "File content is not a recognized image format" };
}

/**
 * Confidence transparency (B9): dev providers must not dress heuristic scores
 * up as model confidence — the kind travels with every verdict.
 */
export function confidenceKindFor(providerId: string): "MODEL" | "HEURISTIC" | "UNKNOWN" {
  if (providerId === "yolo-service") return "MODEL";
  if (providerId.startsWith("dev:")) return "HEURISTIC";
  return "UNKNOWN";
}
