// Proof of the minute-meter contract (Task 2). Run against a throwaway SQLite DB:
//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-minute-meter.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-minute-meter.db?connection_limit=1" npx tsx scripts/verify-minute-meter.ts
import { prisma } from "../src/lib/prisma";
import {
  reserveMinutes,
  refundMinutes,
  checkMinuteQuota,
  minutesLimitForPlan,
} from "../src/lib/minute-limits";

let passed = 0;
function assert(c: boolean, m: string) {
  if (!c) { console.error("❌ " + m); process.exit(1); }
  console.log("✓ " + m);
  passed++;
}

async function main() {
  await prisma.user.deleteMany();

  // ── minutesLimitForPlan ──────────────────────────────────────────────────
  assert(minutesLimitForPlan("FREE") === 5, "FREE plan limit = 5");
  assert(minutesLimitForPlan("PRO") === 80, "PRO plan limit = 80");
  assert(minutesLimitForPlan("BUSINESS") === 150, "BUSINESS plan limit = 150");
  assert(minutesLimitForPlan("unknown") === 5, "unknown plan falls back to 5");

  // ── PRO user with minutesUsed = 78 (2 minutes remaining) ─────────────────
  const now = new Date();
  const u = await prisma.user.create({
    data: {
      name: "minute-user",
      email: "minutes@t.test",
      plan: "PRO",
      minutesUsed: 78,
      minutesLimit: 80,
      usagePeriodStartedAt: now, // fresh window, not expired
    },
  });

  // checkMinuteQuota: allowed, remaining = 2
  const peek1 = await checkMinuteQuota(u.id);
  assert(peek1.allowed === true, "checkMinuteQuota: PRO 78/80 → allowed");
  assert(peek1.remaining === 2, "checkMinuteQuota: PRO 78/80 → remaining 2");

  // Verify peek is read-only (minutesUsed unchanged)
  const row0 = await prisma.user.findUnique({ where: { id: u.id } });
  assert(row0!.minutesUsed === 78, "checkMinuteQuota did NOT increment minutesUsed");

  // reserve 1 minute → allowed, remaining 1
  const r1 = await reserveMinutes(u.id, 1);
  assert(r1.allowed === true, "reserve(1) within remaining 2 → allowed");
  assert(r1.remaining === 1, "reserve(1): remaining = 1");
  const row1 = await prisma.user.findUnique({ where: { id: u.id } });
  assert(row1!.minutesUsed === 79, "reserve(1) incremented minutesUsed to 79");

  // reserve 2 more would exceed 80: 79 + 2 = 81 > 80 → blocked
  const r2 = await reserveMinutes(u.id, 2);
  assert(r2.allowed === false, "reserve(2) when only 1 left → blocked (allowed:false)");
  assert(typeof r2.message === "string" && r2.message.includes("นาที"), "blocked reserve carries Thai over-quota message");
  const row2 = await prisma.user.findUnique({ where: { id: u.id } });
  assert(row2!.minutesUsed === 79, "blocked reserve did NOT increment minutesUsed");

  // refund 1 minute → restores to 78
  await refundMinutes(u.id, 1);
  const row3 = await prisma.user.findUnique({ where: { id: u.id } });
  assert(row3!.minutesUsed === 78, "refundMinutes(1) restored minutesUsed to 78");

  // checkMinuteQuota after refund: remaining = 2 again
  const peek2 = await checkMinuteQuota(u.id);
  assert(peek2.allowed === true, "after refund: checkMinuteQuota allowed");
  assert(peek2.remaining === 2, "after refund: remaining = 2");

  // ── FREE user: exactly at limit ──────────────────────────────────────────
  const uf = await prisma.user.create({
    data: {
      name: "free-user",
      email: "free-minutes@t.test",
      plan: "FREE",
      minutesUsed: 5,
      minutesLimit: 5,
      usagePeriodStartedAt: now,
    },
  });
  const rf = await reserveMinutes(uf.id, 1);
  assert(rf.allowed === false, "FREE user at limit (5/5): reserve blocked");
  assert(rf.remaining === 0, "FREE user at limit: remaining = 0");

  // ── Refund floor: minutesUsed cannot go below 0 ──────────────────────────
  const uf2 = await prisma.user.create({
    data: {
      name: "floor-user",
      email: "floor@t.test",
      plan: "PRO",
      minutesUsed: 0,
      minutesLimit: 80,
      usagePeriodStartedAt: now,
    },
  });
  await refundMinutes(uf2.id, 5); // no-op, should not go negative
  const rowFloor = await prisma.user.findUnique({ where: { id: uf2.id } });
  assert(rowFloor!.minutesUsed >= 0, "refund floor: minutesUsed never goes below 0");

  await prisma.user.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} MINUTE-METER CHECKS PASSED`);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
