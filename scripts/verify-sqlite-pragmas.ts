// Verifies the SQLite settings PR-4 requires (spec §5 PR-4, §12 risk table):
//  - journal_mode=WAL  (persistent per DB file; set once via sqlite3 CLI —
//    see docs/ops/ops-guardrails-runbook.md §2)
//  - busy_timeout=5000 (per-connection; Prisma's SQLite connector already
//    defaults to 5000ms, and src/lib/prisma.ts now sets it explicitly on init
//    so the guarantee can't silently regress)
// tsx does NOT load .env — pass DATABASE_URL explicitly (repo verify-*
// convention, see scripts/verify-trial.ts). connection_limit=1 pins a single
// connection so the init pragma and the reads below share it. Run from root:
//   DATABASE_URL="file:$(pwd)/prisma/dev.db?connection_limit=1" npx tsx scripts/verify-sqlite-pragmas.ts
import { prisma } from "../src/lib/prisma";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}\n        got:  ${g}\n        want: ${w}`);
  }
}

async function main() {
  const journalRows = await prisma.$queryRawUnsafe<{ journal_mode: string }[]>(
    "PRAGMA journal_mode"
  );
  check("journal_mode is wal", journalRows[0]?.journal_mode, "wal");

  const busyRows = await prisma.$queryRawUnsafe<{ timeout: number | bigint }[]>(
    "PRAGMA busy_timeout"
  );
  check("busy_timeout is 5000", Number(busyRows[0]?.timeout), 5000);

  await prisma.$disconnect();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll sqlite pragma checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
