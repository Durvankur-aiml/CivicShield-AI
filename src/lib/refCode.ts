import { prisma } from "./db";

/**
 * Human-readable, concurrency-safe complaint reference codes.
 *
 * Format: CS-<year>-<6 digits>, e.g. CS-2026-000123 (unchanged, so existing
 * seeded/demo codes and every UI/screenshot reference remain valid).
 *
 * Why not `count() + 1`: row counts shift on deletion and race under
 * concurrent submissions, producing unique-constraint violations (500s).
 *
 * Strategy: derive the next candidate from the current year's MAX existing
 * sequence (+1) — never from row counts — and rely on the database's UNIQUE
 * constraint on `Complaint.refCode` as the single source of truth. The
 * caller inserts the complaint with the candidate code; on the (rare)
 * concurrent race the insert fails with a unique violation and
 * `withUniqueRefCode` retries from the latest committed MAX. This is the
 * standard high-water-mark pattern: no locks, safe across serverless
 * instances, and unaffected by deleted rows.
 */

const CODE_PREFIX = "CS";
const SEQ_WIDTH = 6;
const MAX_ATTEMPTS = 5;

export function formatRefCode(year: number, seq: number): string {
  return `${CODE_PREFIX}-${year}-${String(seq).padStart(SEQ_WIDTH, "0")}`;
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  // Prisma unique-constraint error code (all supported providers), plus a
  // message match as belt-and-braces for raw driver errors via poolers.
  return e?.code === "P2002" || /unique constraint|duplicate key/i.test(e?.message ?? "");
}

/** Compute the next free reference code for `year` from committed data. */
export async function nextRefCodeCandidate(year: number = new Date().getFullYear()): Promise<string> {
  const agg = await prisma.complaint.aggregate({
    where: { refCode: { startsWith: `${CODE_PREFIX}-${year}-` } },
    _max: { refCode: true },
  });
  const maxCode = agg._max.refCode; // lexicographic order === numeric order (fixed width)
  const lastSeq = maxCode ? Number(maxCode.slice(-SEQ_WIDTH)) : 0;
  return formatRefCode(year, lastSeq + 1);
}

/**
 * Run `create(nextCode)` with an automatically-resolved reference code,
 * retrying on unique-violation races (MAX_ATTEMPTS times). The create
 * callback must insert the complaint using the provided code so the
 * database UNIQUE constraint arbitrates concurrent submissions.
 */
export async function withUniqueRefCode<T>(
  create: (refCode: string) => Promise<T>,
  year: number = new Date().getFullYear()
): Promise<{ result: T; refCode: string; attempts: number }> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const refCode = await nextRefCodeCandidate(year);
    try {
      const result = await create(refCode);
      return { result, refCode, attempts: attempt };
    } catch (err) {
      if (isUniqueViolation(err)) {
        lastError = err;
        continue; // lost a concurrent race — recompute from the latest MAX
      }
      throw err;
    }
  }
  throw new Error(
    `Could not allocate a unique complaint reference code after ${MAX_ATTEMPTS} attempts${
      lastError instanceof Error ? ` (last error: ${lastError.message})` : ""
    }`
  );
}
