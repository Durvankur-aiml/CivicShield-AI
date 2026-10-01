/**
 * AI provider interfaces.
 *
 * RULE: production results are never simulated. Each provider reports its own
 * `provider` id ("yolo-service", "bedrock", "dev:heuristic", ...) and the UI +
 * Agent Activity log always display it, so a judge can always see whether a
 * real model or the clearly-labeled development provider produced a result.
 */

export type VisionDetection = {
  label: string;
  confidence: number;
  /** Dev providers label their numbers HEURISTIC — never model output. */
  confidenceKind?: ConfidenceKind;
  bbox?: [number, number, number, number];
};

export type VisionResult = {
  provider: string; // e.g. "yolo-service" or "dev:hint"
  providerState: import("../visionStates").ProviderState; // REAL_YOLO | DEV_HINT | UNAVAILABLE | ERROR
  detections: VisionDetection[];
  category: string | null; // mapped civic category or null
  confidence: number; // overall confidence 0..1
  confidenceKind: ConfidenceKind; // MODEL vs HEURISTIC vs UNKNOWN
  model?: string; // weight file name when a real model ran (e.g. "civicai-best.pt")
  note?: string; // human-readable note shown in UI (e.g. "Simulated detection")
};

export interface VisionProvider {
  readonly id: string;
  detect(image: Buffer, mime: string, opts?: { demoHint?: string }): Promise<VisionResult>;
}

export type LLMResult = {
  provider: string; // e.g. "bedrock:claude-3-haiku" or "dev:rules"
  summary: string;
  category: string;
  reasoning: string[]; // concise decision explanations (no hidden chain-of-thought)
};

export interface LLMProvider {
  readonly id: string;
  reason(input: {
    description: string;
    visionCategory: string | null;
    visionConfidence: number | null;
    language: string;
  }): Promise<LLMResult>;
}

import type { ConfidenceKind } from "../constants";
import type { VerificationResultState } from "../visionStates";

export type ResolutionVerdict = {
  verified: boolean;
  confidence: number;
  reason: string;
  provider: string;
  /** Explicit outcome state — VERIFIED | FAILED | INCONCLUSIVE | UNAVAILABLE. */
  verificationResult: VerificationResultState;
  /** Confidence transparency: real model score vs labeled heuristic. */
  confidenceKind: ConfidenceKind;
};

export interface ResolutionVerifier {
  readonly id: string;
  verify(input: {
    category: string;
    originalDescription: string;
    beforeImage: Buffer | null;
    beforeMime: string | null;
    afterImage: Buffer;
    afterMime: string;
  }): Promise<ResolutionVerdict>;
}
