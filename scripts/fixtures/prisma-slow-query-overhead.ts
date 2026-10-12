import { prisma } from "../../src/lib/prisma";

// Runs N fast, already-resolved-schema queries back to back and prints the total wall time.
// Called twice by verify-prisma-slow-query.ts — once with the instrumentation on (default
// threshold) and once with PRISMA_SLOW_QUERY_MS=0 (wrapping skipped entirely) — so the
// difference is roughly the per-call overhead this feature adds to the hot path.
const COUNT = 300;

async function main() {
  await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
  const startedAt = Date.now();
  for (let i = 0; i < COUNT; i += 1) {
    await prisma.user.count();
  }
  console.log(`OVERHEAD_TOTAL_MS=${Date.now() - startedAt}`);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
