import { vi } from "vitest";

/**
 * Shared mock Prisma client for Phase 1/2A regression tests.
 *
 * These tests exercise REAL application logic (refCode allocation, SLA sweep,
 * auth-secret resolution, worker domain, route guards) with the Prisma client
 * boundary mocked — no database is available in this environment (no local
 * Postgres). Full end-to-end coverage against a real database remains the job
 * of scripts/smoke.mjs (see the phase reports for how to run it).
 *
 * Usage inside a test file:
 *   const prisma = makePrismaMock();
 *   mockPrismaModule(prisma);          // vi.mock("@/lib/db", ...) is wired here
 *   ...configure prisma.workerApplication.* etc.
 */
export type MockFn = ReturnType<typeof vi.fn>;

export type PrismaMock = {
  complaint: {
    aggregate: MockFn;
    findUnique: MockFn;
    findMany: MockFn;
    create: MockFn;
    update: MockFn;
    deleteMany: MockFn; // citizen delete-before-assignment (B4)
    count: MockFn;
    groupBy: MockFn; // Phase 5 analytics (status/category/department groupings)
  };
  timelineEvent: { create: MockFn };
  escalation: { create: MockFn };
  department: { findUnique: MockFn; findMany: MockFn }; // findMany: Phase 5 analytics
  user: {
    findUnique: MockFn;
    findMany: MockFn;
    create: MockFn;
    update: MockFn;
    upsert: MockFn;
  };
  workerApplication: {
    findFirst: MockFn;
    findUnique: MockFn;
    findMany: MockFn;
    create: MockFn;
    update: MockFn;
  };
  workerProfile: {
    findUnique: MockFn;
    findMany: MockFn;
    create: MockFn;
    upsert: MockFn;
  };
  officialApplication: {
    findFirst: MockFn;
    findUnique: MockFn;
    findMany: MockFn;
    create: MockFn;
    update: MockFn;
  };
  officialProfile: {
    findUnique: MockFn;
    findMany: MockFn;
    create: MockFn;
    aggregate: MockFn;
  };
  agentActivity: {
    create: MockFn;
    findMany: MockFn;
    updateMany: MockFn;
    count: MockFn; // Phase 5: no-eligible-worker assignment metrics
  };
  assignment: {
    findUnique: MockFn;
    findFirst: MockFn;
    findMany: MockFn;
    create: MockFn;
    update: MockFn;
    count: MockFn;
    groupBy: MockFn;
  };
  notification: {
    create: MockFn;
    createMany: MockFn;
    findUnique: MockFn;
    findMany: MockFn;
    findFirst: MockFn;
    update: MockFn;
    updateMany: MockFn;
    count: MockFn;
  };
  storedFile: { findUnique: MockFn; create: MockFn; deleteMany: MockFn };
  $transaction: MockFn;
};

export function makePrismaMock(): PrismaMock {
  const mock = {
    complaint: {
      aggregate: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
    },
    timelineEvent: { create: vi.fn() },
    escalation: { create: vi.fn() },
    department: { findUnique: vi.fn(), findMany: vi.fn() },
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    workerApplication: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    workerProfile: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
    },
    officialApplication: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    officialProfile: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      aggregate: vi.fn(),
    },
    agentActivity: {
      create: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    assignment: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
    },
    notification: {
      create: vi.fn(),
      createMany: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    storedFile: { findUnique: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn(),
  } as PrismaMock;

  // Interactive-transaction model: the callback runs against the same mock
  // client. A real database would scope the callback to a single transaction;
  // ATOMICITY ITSELF is only provable against a live database (see the Phase
  // 2A report — unit tests verify orchestration, ordering, and failure
  // propagation, not physical rollback).
  mock.$transaction.mockImplementation(async (cb: (tx: PrismaMock) => unknown) => cb(mock));

  return mock;
}

/**
 * Hoisted holder: vi.mock factories are hoisted above test-file top-level
 * statements, so the factory must not close over per-file variables. It reads
 * this holder (also hoisted) lazily at first module load — by which time
 * mockPrismaModule() has installed the per-file mock instance.
 */
const holder = vi.hoisted(() => ({ current: undefined as unknown }));

/** Wire vi.mock for "@/lib/db" (and its relative twin) to the given mock. */
export function mockPrismaModule(prisma: PrismaMock): void {
  holder.current = prisma;
  vi.mock("@/lib/db", () => ({ prisma: holder.current }));
  vi.mock("./db", () => ({ prisma: holder.current }));
}

/** Prisma P2002 unique-violation-shaped error. */
export function uniqueViolationError(constraint = "Complaint_refCode_key"): Error & { code: string } {
  const err = new Error(`Unique constraint failed on the constraint: \`${constraint}\``) as Error & { code: string };
  err.code = "P2002";
  return err;
}
