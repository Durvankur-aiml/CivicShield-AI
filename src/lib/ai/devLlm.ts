import type { LLMProvider, LLMResult } from "./types";
import { CATEGORIES } from "../constants";

/**
 * Development LLM provider — deterministic rule-based triage, CLEARLY LABELED.
 * Used when AWS credentials are not configured so the whole pipeline remains
 * demonstrable offline. Produces the same structured output shape as Bedrock.
 */
const HINTS: Array<{ words: string[]; category: (typeof CATEGORIES)[number] }> = [
  { words: ["pothole", "pot hole", "गड्ढा", "खड्डा", "खड्डी", "गाडीखोल", "ढगाळ"], category: "POTHOLE" },
  { words: ["garbage", "trash", "kachra", "कचरा", "कचऱ्या", "waste", "dustbin", "डंप"], category: "GARBAGE" },
  { words: ["water log", "waterlog", "waterlogging", "flood", "pani", "पाणी", "जल", "बर्फाळ"], category: "WATERLOGGING" },
  { words: ["streetlight", "street light", "light nahi", "बत्ती", "दिवा", "lamp", "उजेड"], category: "STREETLIGHT" },
  { words: ["road damage", "crack", "broken road", "रस्ता", "डाघ", "रस्त्यावर"], category: "ROAD_DAMAGE" },
  { words: ["overflow", "overflowing", "dump", "डंपिंग"], category: "WASTE_OVERFLOW" },
];

export class DevLLMProvider implements LLMProvider {
  readonly id = "dev:rules";

  async reason(input: {
    description: string;
    visionCategory: string | null;
    visionConfidence: number | null;
    language: string;
  }): Promise<LLMResult> {
    const text = input.description.toLowerCase();
    let category: (typeof CATEGORIES)[number] | null = null;
    const matchedWords: string[] = [];

    for (const hint of HINTS) {
      const hit = hint.words.find((w) => text.includes(w));
      if (hit) {
        category = hint.category;
        matchedWords.push(hit);
        break;
      }
    }
    // Vision result outranks keyword matching when confident.
    if (input.visionCategory && (input.visionConfidence ?? 0) >= 0.5) {
      const known = CATEGORIES.find((c) => c === input.visionCategory);
      if (known) category = known;
    }

    const finalCategory = category ?? "OTHER";
    const reasoning: string[] = [];
    if (input.visionCategory) {
      reasoning.push(
        `Vision provider detected ${input.visionCategory} at ${(100 * (input.visionConfidence ?? 0)).toFixed(0)}% confidence`
      );
    }
    if (matchedWords.length) {
      reasoning.push(`Complaint text matches "${matchedWords[0]}" → ${finalCategory}`);
    }
    if (!input.visionCategory && !matchedWords.length) {
      reasoning.push("No strong vision or keyword signal — classified as Other for manual review");
    }

    return {
      provider: this.id,
      summary: `Citizen reports a ${categoryLabels[finalCategory].toLowerCase()} issue. ${
        input.description.trim().slice(0, 120)
      }`,
      category: finalCategory,
      reasoning,
    };
  }
}

const categoryLabels: Record<string, string> = {
  POTHOLE: "Pothole",
  GARBAGE: "Garbage",
  WATERLOGGING: "Waterlogging",
  STREETLIGHT: "Damaged streetlight",
  ROAD_DAMAGE: "Road damage",
  WASTE_OVERFLOW: "Overflowing waste",
  OTHER: "Other civic issue",
};
