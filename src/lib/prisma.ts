import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const isNewClient = !globalForPrisma.prisma;

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient();

if (isNewClient) {
  // SQLite returns SQLITE_BUSY ("database is locked") when a write can't get
  // the lock within busy_timeout. With WAL enabled (one-time
  // `PRAGMA journal_mode=WAL` per DB file — docs/ops/ops-guardrails-runbook.md §2)
  // a 5s busy_timeout makes writers wait instead of erroring. This is the
  // prerequisite for the Phase 2 render worker, a second process sharing this
  // DB file (the worker sets it natively via better-sqlite3, which has NO
  // default). Prisma's own SQLite connector defaults busy_timeout to 5000ms
  // per connection (verified on Prisma 6.19.2), but that default is
  // undocumented — set it explicitly so it can never silently regress.
  // busy_timeout is per-connection and NOT persistent, so it is set at client
  // init and applies to the pooled connection that executes it.
  // NOTE: $queryRawUnsafe, NOT $executeRawUnsafe — SQLite PRAGMA assignment
  // returns a row, and Prisma's executeRaw rejects row-returning statements
  // ("Execute returned results, which is not allowed in SQLite.").
  // Fire-and-forget so module load can never throw.
  prisma
    .$queryRawUnsafe("PRAGMA busy_timeout = 5000")
    .catch((e) => console.warn("[prisma] could not set busy_timeout:", e));
}

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
