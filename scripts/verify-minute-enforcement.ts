// Run with: npx tsx scripts/verify-minute-enforcement.ts
// TDD: Task 1 of Phase-2 minute-quota enforcement.
// Asserts:
//   1. minutesFromSeconds: correct ceiling + floor=1 + NaN/0 guard
//   2. recordChargedClip(userId, url, 3) stores chargedMinutes=3
//   3. recordChargedClip(userId, url) (2-arg) stores chargedMinutes=null (backward-compat)
//
// Self-contained: spins a throwaway SQLite DB, pushes the schema (so it reads the real
// schema.prisma which must have chargedMinutes + reservedMinutes), dynamically imports
// helpers, asserts, exits non-zero on failure.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "minquota-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failures = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error("FAIL:", msg); } else { passed++; console.log("ok:", msg); }
}

async function main() {
  const { minutesFromSeconds } = await import("../src/lib/minute-limits");
  const { recordChargedClip } = await import("../src/lib/clip-charge");
  const { prisma } = await import("../src/lib/prisma");

  // --- minutesFromSeconds ---
  ok(minutesFromSeconds(90) === 2,  "90s → 2 min");
  ok(minutesFromSeconds(60) === 1,  "60s → 1 min");
  ok(minutesFromSeconds(30) === 1,  "30s → 1 min (floor 1)");
  ok(minutesFromSeconds(0)  === 1,  "0s → 1 min (guard)");
  ok(minutesFromSeconds(150) === 3, "150s → 3 min");
  ok(minutesFromSeconds(360) === 6, "360s → 6 min");
  ok(minutesFromSeconds(NaN) === 1, "NaN → 1 min (guard)");

  // --- recordChargedClip 3-arg: stores chargedMinutes ---
  const userId = "test-me-user";
  const urlA = "/api/renders/render-test-minute-a.mp4";
  await recordChargedClip(userId, urlA, 3);
  const rowA = await prisma.chargedClip.findFirst({
    where: { userId, outputUrl: urlA },
    select: { chargedMinutes: true },
  });
  ok(rowA !== null, "recordChargedClip(u, urlA, 3) stored a row");
  ok(rowA?.chargedMinutes === 3, "row.chargedMinutes === 3");

  // --- recordChargedClip 2-arg: chargedMinutes stays null (backward-compat) ---
  const urlB = "/api/renders/render-test-minute-b.mp4";
  await recordChargedClip(userId, urlB);
  const rowB = await prisma.chargedClip.findFirst({
    where: { userId, outputUrl: urlB },
    select: { chargedMinutes: true },
  });
  ok(rowB !== null, "recordChargedClip(u, urlB) 2-arg stored a row");
  ok(rowB?.chargedMinutes === null, "2-arg call → chargedMinutes === null (backward-compat)");

  await prisma.$disconnect();
  if (failures) {
    console.error(`\n${failures} FAILED (${passed} passed)`);
    process.exit(1);
  }
  console.log(`\nALL ${passed} MINUTE-ENFORCEMENT CHECKS PASSED`);
}
main().catch(async (e) => { console.error(e); process.exit(1); });
