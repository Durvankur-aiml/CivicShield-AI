import type { VisionProvider, VisionResult } from "./types";
import { CATEGORIES, categoryLabels } from "../constants";

/**
 * Development vision provider — CLEARLY LABELED, never silently used.
 *
 * A real hackathon demo cannot guarantee YOLO weights/network on every machine,
 * so this provider lets the demo continue honestly:
 *  - if the submitter supplies a demo hint (UI shows "Simulated detection"),
 *    that hint is mapped to a category, or
 *  - with no hint it returns "no detection" and the pipeline continues on the
 *    citizen's text description alone.
 *
 * Every result carries provider="dev:hint" + providerState="DEV_HINT" and a
 * visible note; confidence is explicitly HEURISTIC kind so a simulated number
 * is never presented as model output.
 */
export class DevVisionProvider implements VisionProvider {
  readonly id = "dev:hint";

  async detect(_image: Buffer, _mime: string, opts?: { demoHint?: string }): Promise<VisionResult> {
    const hint = (opts?.demoHint ?? "").trim();
    const known = CATEGORIES.find((c) => c !== "OTHER" && categoryLabels[c].toLowerCase() === hint.toLowerCase())
      ?? CATEGORIES.find((c) => c !== "OTHER" && hint.toLowerCase().includes(categoryLabels[c].toLowerCase().split(" ")[0]));

    if (known) {
      return {
        provider: this.id,
        providerState: "DEV_HINT",
        detections: [{ label: categoryLabels[known], confidence: 0.87, confidenceKind: "HEURISTIC" }],
        category: known,
        confidence: 0.87,
        confidenceKind: "HEURISTIC",
        note: "Simulated detection (development provider) — connect YOLO_SERVICE_URL for real inference",
      };
    }
    return {
      provider: this.id,
      providerState: "DEV_HINT",
      detections: [],
      category: null,
      confidence: 0,
      confidenceKind: "HEURISTIC",
      note: "Development provider active — no real model inference performed",
    };
  }
}
