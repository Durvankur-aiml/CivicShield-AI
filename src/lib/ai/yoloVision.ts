import type { VisionProvider, VisionResult } from "./types";
import { providerStateFor, confidenceKindFor } from "../visionStates";

/**
 * YOLOv8 vision provider — production path.
 * Calls the vision service's POST /predict, which runs the CivicAI
 * custom-trained weight (best.pt) and reports results by reading
 * model.names — the service never substitutes a model.
 *
 * If the service is not configured/unreachable, callers fall back to the
 * clearly-labeled dev provider — never to a silent fake.
 */
export class YoloVisionProvider implements VisionProvider {
  readonly id = "yolo-service";

  constructor(private baseUrl: string) {}

  async detect(image: Buffer, mime: string): Promise<VisionResult> {
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(image)], { type: mime }), "upload.jpg");
    const res = await fetch(`${this.baseUrl}/predict`, { method: "POST", body: form, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      let detail = `YOLO service responded ${res.status}`;
      try {
        const err = (await res.json()) as { detail?: string };
        if (err?.detail) detail += `: ${err.detail}`;
      } catch {
        // keep status-only message
      }
      throw new Error(detail);
    }
    const data = (await res.json()) as {
      category: string | null;
      confidence: number;
      model: string;
      detections: Array<{ label: string; confidence: number; x1?: number; y1?: number; x2?: number; y2?: number }>;
      note?: string | null;
    };

    const detections = data.detections
      .filter((d) => d.confidence >= 0.25)
      .map((d) => ({
        label: d.label,
        confidence: d.confidence,
        confidenceKind: "MODEL" as const,
        bbox: [d.x1, d.y1, d.x2, d.y2].every((v) => typeof v === "number")
          ? ([d.x1!, d.y1!, d.x2!, d.y2!] as [number, number, number, number])
          : undefined,
      }));

    return {
      provider: this.id,
      providerState: providerStateFor(this.id), // REAL_YOLO — the service ran actual inference
      model: data.model, // e.g. "civicai-best.pt" — surfaced in UI + agent log
      detections,
      category: data.category ?? null,
      confidence: data.confidence ?? detections[0]?.confidence ?? 0,
      confidenceKind: confidenceKindFor(this.id), // MODEL
      note: data.note ?? (detections.length ? undefined : "Model ran but found no known civic issue"),
    };
  }
}

/**
 * Maps model label names to CivicShield civic categories — by NAME, never by
 * class ID. CivicAI's documented names (pothole, garbage, water, streetlight)
 * are covered; unknown names fall through to OTHER and still appear verbatim
 * in the agent log.
 */
export function mapYoloLabel(label: string): string | null {
  const l = label.toLowerCase();
  if (l.includes("pothole")) return "POTHOLE";
  if (l.includes("garbage") || l.includes("trash") || l.includes("waste")) return "GARBAGE";
  if (l.includes("water") || l.includes("flood")) return "WATERLOGGING";
  if (l.includes("streetlight") || l.includes("street_light") || l.includes("street light") || l.includes("lamp")) return "STREETLIGHT";
  if (l.includes("road") || l.includes("crack")) return "ROAD_DAMAGE";
  return "OTHER";
}
