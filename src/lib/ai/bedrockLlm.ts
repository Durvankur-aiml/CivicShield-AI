import type { LLMProvider, LLMResult } from "./types";
import { CATEGORIES, categoryLabels } from "../constants";

/**
 * Bedrock LLM provider — production path.
 * Uses Anthropic Claude via Amazon Bedrock to turn a raw citizen complaint
 * into a structured classification with concise, judge-friendly reasoning.
 * Output is constrained to our category taxonomy via the prompt.
 */
export class BedrockLLMProvider implements LLMProvider {
  readonly id: string;

  constructor(private modelId = process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-3-haiku-20240307-v1:0") {
    this.id = `bedrock:${this.modelId}`;
  }

  async reason(input: {
    description: string;
    visionCategory: string | null;
    visionConfidence: number | null;
    language: string;
  }): Promise<LLMResult> {
    const { BedrockRuntimeClient, InvokeModelCommand } = await import("@aws-sdk/client-bedrock-runtime");
    const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "ap-south-1" });

    const categoriesList = CATEGORIES.map((c) => `${c} (${categoryLabels[c]})`).join(", ");
    const prompt = `You are the triage module of a municipal complaint system. Classify the citizen complaint.

Citizen description: "${input.description}"
Reported language: ${input.language}
Computer vision detected: ${input.visionCategory ?? "nothing conclusive"}${
      input.visionConfidence != null ? ` (confidence ${(input.visionConfidence * 100).toFixed(0)}%)` : ""
    }

Allowed categories: ${categoriesList}
Respond with ONLY this JSON:
{"summary":"<one-sentence situation summary in English>","category":"<one of the allowed categories>","reasoning":["<short reason 1>","<short reason 2>","<short reason 3>"]}`;

    const res = await client.send(
      new InvokeModelCommand({
        modelId: this.modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 400,
          messages: [{ role: "user", content: prompt }],
        }),
      })
    );
    const parsed = JSON.parse(new TextDecoder().decode(res.body)) as {
      content?: Array<{ text?: string }>;
    };
    const text = parsed.content?.[0]?.text ?? "{}";
    const jsonText = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const out = JSON.parse(jsonText) as { summary: string; category: string; reasoning: string[] };

    const category = CATEGORIES.includes(out.category as (typeof CATEGORIES)[number]) ? out.category : "OTHER";
    return {
      provider: this.id,
      summary: String(out.summary ?? "").slice(0, 300),
      category,
      reasoning: (out.reasoning ?? []).slice(0, 5).map(String),
    };
  }
}
