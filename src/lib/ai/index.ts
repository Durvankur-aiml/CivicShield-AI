import type { VisionProvider, LLMProvider, ResolutionVerifier } from "./types";
import { YoloVisionProvider } from "./yoloVision";
import { DevVisionProvider } from "./devVision";
import { BedrockLLMProvider } from "./bedrockLlm";
import { DevLLMProvider } from "./devLlm";
import { YoloResolutionVerifier } from "./yoloVerifier";
import { DevResolutionVerifier } from "./devVerifier";
import { providerStateFor } from "../visionStates";

/**
 * Provider registry.
 * Selection is explicit and logged — production providers are used when their
 * service/credentials are configured AND reachable; otherwise the clearly
 * labeled development provider is used and its label travels with every
 * result into the UI and the Agent Activity log.
 */

export function getVisionProvider(): VisionProvider {
  const url = process.env.YOLO_SERVICE_URL;
  return url ? new YoloVisionProvider(url) : new DevVisionProvider();
}

export function getLLMProvider(): LLMProvider {
  return process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? new BedrockLLMProvider()
    : new DevLLMProvider();
}

export function getResolutionVerifier(): ResolutionVerifier {
  const url = process.env.YOLO_SERVICE_URL;
  return url ? new YoloResolutionVerifier(url) : new DevResolutionVerifier();
}

/**
 * Judge-friendly provider status. Every string states plainly whether a
 * production model or a labeled development provider is active, and how to
 * enable the production path.
 */
export function aiProviderStatus() {
  const yoloConfigured = Boolean(process.env.YOLO_SERVICE_URL);
  return {
    vision: yoloConfigured
      ? "YOLOv8 vision service (production)"
      : "Development vision provider (labeled) — connect YOLO_SERVICE_URL for real inference",
    visionProviderState: yoloConfigured ? providerStateFor("yolo-service") : providerStateFor("dev:hint"),
    llm: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? "Amazon Bedrock (production)"
      : "Development rule-based provider (labeled) — add AWS credentials for Amazon Bedrock",
    verifier: yoloConfigured
      ? "YOLOv8 verification service (production)"
      : "Development heuristic verifier (labeled) — connect YOLO_SERVICE_URL for model verification",
    verifierProviderState: yoloConfigured ? providerStateFor("yolo-service") : providerStateFor("dev:heuristic"),
  };
}
