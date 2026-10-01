import { NextResponse } from "next/server";
import { readImage } from "@/lib/storage";
import { requireUser } from "@/lib/auth";
import { handleRouteError, jsonError } from "@/lib/api";

export const runtime = "nodejs";

/** GET /api/files/:key — authenticated image serving (DB-backed with FS fallback). */
export async function GET(req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  try {
    await requireUser(req); // images require a session
    const { key } = await params;
    const joined = key.join("/");
    if (joined.includes("..") || !/^[a-z]+\/\d{4}-\d{2}-\d{2}\/[a-z0-9-]+\.(jpg|png|webp|heic)$/i.test(joined)) {
      return jsonError(400, "Invalid file key");
    }
    const img = await readImage(joined);
    if (!img) return jsonError(404, "Image not found");
    return new NextResponse(new Uint8Array(img.bytes), {
      // nosniff: user-supplied bytes are never reinterpreted by the browser.
      // (Storage design is unchanged — see Phase 1 report for the documented
      // future improvement: magic-byte validation at upload.)
      headers: {
        "Content-Type": img.mime,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
