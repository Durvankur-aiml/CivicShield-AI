import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { prisma } from "./db";

/**
 * File storage abstraction.
 *
 * PRIMARY: Postgres (`StoredFile` table) — works on any host including
 * serverless platforms with read-only filesystems (Vercel). Images are
 * validated, size-capped, and only served back through the authenticated
 * /api/files/[key] route.
 *
 * FALLBACK: local ./storage/uploads (handy for dev without a DB, and the
 * original driver). If the DB write fails AND the filesystem is writable
 * the file lands there instead.
 *
 * Swap-in point for S3: implement the same two functions against a bucket
 * and serve via presigned URLs — call sites do not change.
 */

const ALLOWED_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};

export const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? 8);

export function validateImage(file: File): { ok: true; ext: string } | { ok: false; error: string } {
  if (!file || typeof file.arrayBuffer !== "function") return { ok: false, error: "No file provided" };
  if (file.size === 0) return { ok: false, error: "Empty file" };
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024)
    return { ok: false, error: `File exceeds ${MAX_UPLOAD_MB}MB limit` };
  const ext = ALLOWED_MIME[file.type];
  if (!ext) return { ok: false, error: "Only JPEG, PNG, WebP or HEIC images are allowed" };
  return { ok: true, ext };
}

/**
 * Phase 4 (B5): client MIME alone is not trusted — the first bytes are
 * sniffed against known image signatures before any image reaches storage or
 * a verifier. A text/HTML/script payload renamed to .jpg is rejected here.
 * HEIC detection covers the ISOBMFF brands; EXIF-bearing JPEGs start with the
 * same FF D8 FF marker, so no special case is needed.
 */
export async function inspectUploadImage(file: File): Promise<{ ok: true; format: string } | { ok: false; error: string }> {
  const head = Buffer.from(await file.slice(0, 32).arrayBuffer());
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => head[offset + i] === b);
  if (starts([0xff, 0xd8, 0xff])) return { ok: true, format: "image/jpeg" };
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ok: true, format: "image/png" };
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return { ok: true, format: "image/webp" };
  if (starts([0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = head.subarray(8, 12).toString("latin1");
    if (brand.startsWith("heic") || brand.startsWith("heix") || brand.startsWith("mif1") || brand.startsWith("msf1")) {
      return { ok: true, format: "image/heic" };
    }
    return { ok: false, error: "Unsupported image format" };
  }
  return { ok: false, error: "File content is not a recognized image format" };
}

/** Stores an already-validated image; returns a stable storage key. */
export async function saveImage(file: File, kind: "report" | "resolution"): Promise<string> {
  const ext = ALLOWED_MIME[file.type];
  const key = `${kind}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${ext}`;
  const bytes = Buffer.from(await file.arrayBuffer());

  // Primary: database storage (works on read-only serverless filesystems).
  try {
    await prisma.storedFile.create({
      data: { key, mime: file.type, bytes, size: bytes.length },
    });
    return key;
  } catch (dbErr) {
    // Fallback: local filesystem (dev convenience only).
    try {
      const dest = path.join(process.cwd(), "storage", "uploads", key);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, bytes);
      return key;
    } catch {
      throw dbErr; // report the primary (DB) failure — it is the actionable one
    }
  }
}

/** Reads a stored image by key; checks the DB first, then the local FS. */
export async function readImage(key: string): Promise<{ bytes: Buffer; mime: string } | null> {
  try {
    const row = await prisma.storedFile.findUnique({ where: { key } });
    if (row) return { bytes: Buffer.from(row.bytes), mime: row.mime };
  } catch {
    // DB unavailable — fall through to filesystem.
  }
  try {
    const { readFile } = await import("fs/promises");
    const filePath = path.join(process.cwd(), "storage", "uploads", key);
    return { bytes: await readFile(filePath), mime: "image/jpeg" };
  } catch {
    return null;
  }
}

export function publicUrlForKey(key: string | null | undefined): string | null {
  if (!key) return null;
  return `/api/files/${key}`;
}
