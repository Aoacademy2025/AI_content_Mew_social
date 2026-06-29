// Proof of the orchestration lib: reserveMinutesOrCredits + refundReservation (Task 3).
// Run with: npx tsx scripts/verify-minute-credits.ts
//
// Self-contained: spins a throwaway SQLite DB, pushes the real schema.prisma,
// dynamically imports helpers, asserts, exits non-zero on failure.
//
// User setup notes (important):
// - reserveMinutes calls syncMinuteWindow which calls syncUserEntitlement. If the
//   user's plan is PRO but subStatus=null/non-active and no planExpiresAt, classifyEntitlement
//   returns action:"REVIEW" (not DOWNGRADE), so the plan stays PRO. Safe.
// - syncMinuteWindow resets minutesUsed to 0 if usagePeriodStartedAt is null or >30d ago.
//   So we MUST seed with a recent usagePeriodStartedAt (e.g. new Date()).
// - isActiveTrial check: trialEndsAt must be null so minutesLimit stays at PRO (80),
//   not capped at TRIAL_MINUTES (15).
// - We seed minutesLimit=80 directly and set usagePeriodStartedAt=now so syncMinuteWindow
//   won't reset our minutesUsed field.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mincredits-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failures = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error("FAIL:", msg); } else { passed++; console.log("ok:", msg); }
}

async function main() {
  const { reserveMinutesOrCredits, refundReservation } = await import("../src/lib/minute-credits");
  const { grantCredits, getBalance } = await import("../src/lib/credits");
  const { prisma } = await import("../src/lib/prisma");

  // ── Seed user: PRO, minutesLimit 80, minutesUsed 0 ──────────────────────────
  // usagePeriodStartedAt = now so the window is NOT reset by syncMinuteWindow.
  // trialEndsAt = null so the trial cap (TRIAL_MINUTES=15) is NOT applied.
  // subStatus = null + no planExpiresAt → classifyEntitlement → PERMANENT_OR_MANUAL
  // → action:"REVIEW" (not DOWNGRADE) → plan stays PRO.
  const now = new Date();
  const u = await prisma.user.create({
    data: {
      id: "test-mc-user-1",
      name: "MC Test User",
      email: "mc-test@example.com",
      plan: "PRO",
      minutesLimit: 80,
      minutesUsed: 0,
      usagePeriodStartedAt: now,
      trialEndsAt: null,
      // usageLimit / usageCount needed by syncUserEntitlement select
      usageLimit: 100,
      usageCount: 0,
    },
  });

  // Seed CreditBalance { granted: 0, purchased: 10 }
  await grantCredits(u.id, 10, "purchase", "seed-purchased");

  // ── Test 1: within quota → minutes ─────────────────────────────────────────
  let r = await reserveMinutesOrCredits(u.id, 2, { creditsLive: true, ref: "j1" });
  ok(r.allowed && r.via === "minutes" && "reservedMinutes" in r && r.reservedMinutes === 2,
    "within quota → minutes");

  // ── Test 2: over quota + creditsLive → credits (minute meter unchanged) ────
  // Drive minutesUsed to the cap
  await prisma.user.update({ where: { id: u.id }, data: { minutesUsed: 80 } });
  r = await reserveMinutesOrCredits(u.id, 2, { creditsLive: true, ref: "j2" });
  ok(r.allowed && r.via === "credits" && "creditsSpent" in r && r.creditsSpent === 4,
    "over quota + creditsLive → credits (2min*2)");

  const after = await prisma.user.findUnique({ where: { id: u.id } });
  ok(after?.minutesUsed === 80, "minute meter NOT incremented on credit overflow");

  const bal = await getBalance(u.id);
  ok(bal.total === 6, "credits drained by 4 (10→6)");

  // ── Test 3: over quota + creditsLive OFF → none (wall) ────────────────────
  r = await reserveMinutesOrCredits(u.id, 2, { creditsLive: false, ref: "j3" });
  ok(!r.allowed && r.via === "none" && !!(r as { message?: string }).message,
    "over quota + creditsLive off → none with message");

  // ── Test 4: over quota + creditsLive + insufficient credits → none ─────────
  await prisma.creditBalance.update({ where: { userId: u.id }, data: { granted: 0, purchased: 1 } });
  r = await reserveMinutesOrCredits(u.id, 2, { creditsLive: true, ref: "j4" });
  ok(!r.allowed && r.via === "none", "insufficient credits → none (no partial spend)");

  const bal2 = await getBalance(u.id);
  ok(bal2.total === 1, "no credits spent when insufficient");

  // ── Test 5: refundReservation routing: creditsSpent → refundCredits ────────
  await refundReservation(u.id, { reservedMinutes: null, creditsSpent: 4 }, "refund:j2");
  ok((await getBalance(u.id)).total === 5, "refundReservation(creditsSpent) → refundCredits");

  // ── Test 6: refundReservation routing: reservedMinutes → refundMinutes ─────
  await prisma.user.update({ where: { id: u.id }, data: { minutesUsed: 80 } });
  await refundReservation(u.id, { reservedMinutes: 3, creditsSpent: null }, "refund:min");
  ok((await prisma.user.findUnique({ where: { id: u.id } }))?.minutesUsed === 77,
    "refundReservation(reservedMinutes) → refundMinutes");

  await prisma.$disconnect();

  if (failures) {
    console.error(`\n${failures} FAILED (${passed} passed)`);
    process.exit(1);
  }
  console.log(`\nALL ${passed} MINUTE-CREDITS CHECKS PASSED`);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
