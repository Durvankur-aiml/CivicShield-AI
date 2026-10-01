import { NextResponse } from "next/server";
import { aiProviderStatus } from "@/lib/ai";

export const runtime = "nodejs";

/**
 * GET /api/health/ai — transparency: which AI providers are active right now?
 * The UI displays this so judges always know whether results come from real
 * models (YOLO service / Bedrock) or the clearly-labeled dev providers.
 */
export async function GET() {
  const demoEnabled = process.env.DEMO_MODE !== "false" && (process.env.NODE_ENV !== "production" || process.env.DEMO_MODE === "true");
  return NextResponse.json({ providers: aiProviderStatus(), demoMode: demoEnabled, at: new Date().toISOString() });
}
