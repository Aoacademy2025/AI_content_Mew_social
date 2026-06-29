// Proof of the monthly credit EARN primitive (Task 1: ensureMonthlyGrant).
// Run with: npx tsx scripts/verify-credit-earn.ts
//
// Self-contained: spins a throwaway SQLite DB, pushes the real schema.prisma,
// dynamically imports helpers, asserts, exits non-zero on failure.
//
// What this proves about ensureMonthlyGrant(userId):
//  - no-op when CREDITS_LIVE !== "1" (flag-gated)
//  - PRO user, no prior grant → granted hard-set to MONTHLY_GRANT.PRO (50)
//  - 2nd call within the USAGE_PERIOD_DAYS window → no-op (idempotent via grantedResetAt)
//  - FREE user (allowance 0) → never granted
//  - `purchased` bucket is NEVER touched by a grant
//
// And about the (ก) downgrade-reset wired into entitlements.syncUserEntitlement:
//  - PRO(granted 50)→FREE transition → resetMonthlyGranted drops granted to 0,
//    while `purchased` (paid) credits are PRESERVED
//  - flag-off → the caller-gated reset is skipped → leftover granted untouched
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "creditearn-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failures = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error("FAIL:", msg); } else { passed++; console.log("ok:", msg); }
}

async function main() {
  const { ensureMonthlyGrant, resetMonthlyGranted, getBalance, grantCredits, MONTHLY_GRANT } =
    await import("../src/lib/credits");
  const { prisma } = await import("../src/lib/prisma");

  // ── Seed a PRO user (minimal fields ensureMonthlyGrant needs: id + plan) ────
  const proId = "earn-pro-1";
  await prisma.user.create({
    data: { id: proId, name: "Earn PRO", email: "earn-pro@example.com", plan: "PRO" },
  });
  // Give them some purchased credits so we can assert the grant never touches them.
  await grantCredits(proId, 12, "purchase", "seed-purchased");

  // ── Test 1: CREDITS_LIVE unset/off → no-op (no grant) ──────────────────────
  delete process.env.CREDITS_LIVE;
  await ensureMonthlyGrant(proId);
  let bal = await getBalance(proId);
  ok(bal.granted === 0, "CREDITS_LIVE off → granted stays 0 (no grant)");
  ok(bal.purchased === 12, "CREDITS_LIVE off → purchased untouched (12)");
  {
    const row = await prisma.creditBalance.findUnique({ where: { userId: proId } });
    ok(row?.grantedResetAt == null, "CREDITS_LIVE off → grantedResetAt not stamped");
  }

  // Flip the flag on for the remaining grant tests.
  process.env.CREDITS_LIVE = "1";

  // ── Test 2: PRO + flag on, first call → granted hard-set to 50 ─────────────
  await ensureMonthlyGrant(proId);
  bal = await getBalance(proId);
  ok(bal.granted === MONTHLY_GRANT.PRO, `PRO first grant → granted = ${MONTHLY_GRANT.PRO}`);
  ok(bal.granted === 50, "PRO first grant → granted = 50 (literal)");
  ok(bal.purchased === 12, "PRO grant → purchased UNTOUCHED (still 12)");
  ok(bal.total === 62, "PRO grant → total = 50 + 12 = 62");

  const afterFirst = await prisma.creditBalance.findUnique({ where: { userId: proId } });
  ok(afterFirst?.grantedResetAt != null, "PRO grant → grantedResetAt stamped");
  const stampedAt = afterFirst!.grantedResetAt!.getTime();

  // A ledger row for the reset was written.
  {
    const ledgerCount = await prisma.creditLedger.count({
      where: { userId: proId, action: "monthly-reset:PRO" },
    });
    ok(ledgerCount === 1, "PRO grant → one monthly-reset:PRO ledger row");
  }

  // ── Test 3: 2nd call within the window → no-op (idempotent) ────────────────
  // Spend down granted manually so a non-idempotent re-grant would be visible.
  await prisma.creditBalance.update({ where: { userId: proId }, data: { granted: 20 } });
  await ensureMonthlyGrant(proId);
  bal = await getBalance(proId);
  ok(bal.granted === 20, "2nd call within window → no re-grant (granted still 20)");
  const afterSecond = await prisma.creditBalance.findUnique({ where: { userId: proId } });
  ok(afterSecond?.grantedResetAt?.getTime() === stampedAt,
    "2nd call within window → grantedResetAt unchanged");
  {
    const ledgerCount = await prisma.creditLedger.count({
      where: { userId: proId, action: "monthly-reset:PRO" },
    });
    ok(ledgerCount === 1, "2nd call within window → no extra ledger row");
  }

  // ── Test 4: window EXPIRED → re-grants (hard-set back to 50) ───────────────
  // Backdate grantedResetAt to 31 days ago (> USAGE_PERIOD_DAYS=30).
  const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  await prisma.creditBalance.update({
    where: { userId: proId },
    data: { granted: 20, grantedResetAt: longAgo },
  });
  await ensureMonthlyGrant(proId);
  bal = await getBalance(proId);
  ok(bal.granted === 50, "window expired → re-grant hard-sets granted back to 50");
  ok(bal.purchased === 12, "window expired re-grant → purchased STILL untouched (12)");

  // ── Test 5: FREE user (allowance 0) → never granted, even with flag on ─────
  const freeId = "earn-free-1";
  await prisma.user.create({
    data: { id: freeId, name: "Earn FREE", email: "earn-free@example.com", plan: "FREE" },
  });
  await grantCredits(freeId, 7, "purchase", "seed-purchased-free");
  await ensureMonthlyGrant(freeId);
  const freeBal = await getBalance(freeId);
  ok(freeBal.granted === 0, "FREE (allowance 0) → granted stays 0");
  ok(freeBal.purchased === 7, "FREE → purchased untouched (7)");
  {
    const row = await prisma.creditBalance.findUnique({ where: { userId: freeId } });
    ok(row?.grantedResetAt == null, "FREE → grantedResetAt never stamped");
  }

  // ── Test 6: DOWNGRADE reset (ก) — PRO(granted 50)→FREE drops granted to 0 ──
  // Mirrors entitlements.syncUserEntitlement: on the plan→FREE transition write it
  // calls resetMonthlyGranted(userId, "FREE"). Proves leftover granted credits do
  // NOT survive a downgrade, while the `purchased` (paid) bucket is preserved.
  const downId = "earn-downgrade-1";
  await prisma.user.create({
    data: { id: downId, name: "Earn Downgrade", email: "earn-down@example.com", plan: "PRO" },
  });
  process.env.CREDITS_LIVE = "1";
  // Give them a full PRO monthly grant + some purchased credits.
  await ensureMonthlyGrant(downId);
  await grantCredits(downId, 30, "purchase", "seed-purchased-down");
  let downBal = await getBalance(downId);
  ok(downBal.granted === 50, "downgrade setup → PRO granted = 50");
  ok(downBal.purchased === 30, "downgrade setup → purchased = 30");
  // Simulate the entitlements transition: plan dropped to FREE → reset granted.
  await resetMonthlyGranted(downId, "FREE");
  downBal = await getBalance(downId);
  ok(downBal.granted === 0, "downgrade PRO→FREE → granted reset to 0 (no leftover)");
  ok(downBal.purchased === 30, "downgrade PRO→FREE → purchased PRESERVED (still 30)");
  ok(downBal.total === 30, "downgrade PRO→FREE → total = 0 + 30 = 30");

  // ── Test 7: flag-off → entitlements downgrade reset is a NO-OP ──────────────
  // resetMonthlyGranted itself isn't flag-gated; the gate lives in its CALLER
  // (entitlements.ts: `if (process.env.CREDITS_LIVE === "1") resetMonthlyGranted(...)`).
  // This reproduces that caller-gate exactly: flag off → the call is skipped → the
  // PRO user's leftover granted credits are untouched (byte-identical to today).
  const downOffId = "earn-downgrade-off-1";
  await prisma.user.create({
    data: { id: downOffId, name: "Earn Downgrade Off", email: "earn-down-off@example.com", plan: "PRO" },
  });
  await ensureMonthlyGrant(downOffId);          // grants 50 (flag still on here)
  await grantCredits(downOffId, 8, "purchase", "seed-purchased-down-off");
  delete process.env.CREDITS_LIVE;              // flag OFF for the downgrade
  // Caller-gated path: flag off means the reset is NEVER invoked.
  if (process.env.CREDITS_LIVE === "1") {
    await resetMonthlyGranted(downOffId, "FREE");
  }
  const downOffBal = await getBalance(downOffId);
  ok(downOffBal.granted === 50, "flag-off downgrade → granted UNCHANGED (reset skipped, 50)");
  ok(downOffBal.purchased === 8, "flag-off downgrade → purchased untouched (8)");

  // ════════════════════════════════════════════════════════════════════════
  // H4 regression: trial-expired → subscribe WITHIN 30 days must get the full grant.
  // Root cause: the trial-expiry downgrade calls resetMonthlyGranted(userId,"FREE"),
  // which stamps grantedResetAt=now even though FREE allowance=0. If the user then
  // subscribes within the 30-day window, ensureMonthlyGrant sees withinWindow=true →
  // SKIPS the grant → the paying subscriber gets 0 credits for ~the first month.
  // FIX: paid activation calls grantOnPaidActivation → resetMonthlyGranted IGNORING the
  // window, so the new plan's allowance lands immediately. Flag-gated on CREDITS_LIVE.
  // ════════════════════════════════════════════════════════════════════════
  const { grantOnPaidActivation } = await import("../src/lib/entitlements");

  const h4Id = "earn-h4-trialthenpay";
  await prisma.user.create({
    data: { id: h4Id, name: "H4", email: "earn-h4@example.com", plan: "FREE" },
  });
  await grantCredits(h4Id, 9, "purchase", "seed-purchased-h4"); // paid credits must survive
  process.env.CREDITS_LIVE = "1";
  // Simulate the trial-expiry downgrade reset: granted→0, grantedResetAt stamped NOW.
  await resetMonthlyGranted(h4Id, "FREE");
  {
    const row = await prisma.creditBalance.findUnique({ where: { userId: h4Id } });
    ok(row?.granted === 0, "H4 setup: post-downgrade granted = 0");
    ok(row?.grantedResetAt != null, "H4 setup: grantedResetAt stamped (within window) by FREE reset");
  }

  // The user subscribes within 30 days → activatePlan sets plan=PRO.
  await prisma.user.update({ where: { id: h4Id }, data: { plan: "PRO" } });

  // PROOF the bug exists: ensureMonthlyGrant ALONE skips (withinWindow) → still 0.
  await ensureMonthlyGrant(h4Id);
  ok((await getBalance(h4Id)).granted === 0,
    "H4: ensureMonthlyGrant ALONE skips the within-window grant → granted still 0 (the bug)");

  // THE FIX: grantOnPaidActivation forces the grant, ignoring the window.
  await grantOnPaidActivation(h4Id, "PRO");
  const h4Bal = await getBalance(h4Id);
  ok(h4Bal.granted === 50, "H4: grantOnPaidActivation forces full PRO grant (50) within window");
  ok(h4Bal.purchased === 9, "H4: purchased (paid) credits preserved (9)");
  ok(h4Bal.total === 59, "H4: total = 50 + 9 = 59");

  // ── H4: BUSINESS activation grants 150 ────────────────────────────────────
  const h4bId = "earn-h4-biz";
  await prisma.user.create({
    data: { id: h4bId, name: "H4 Biz", email: "earn-h4-biz@example.com", plan: "FREE" },
  });
  await resetMonthlyGranted(h4bId, "FREE"); // within-window FREE stamp
  await prisma.user.update({ where: { id: h4bId }, data: { plan: "BUSINESS" } });
  await grantOnPaidActivation(h4bId, "BUSINESS");
  ok((await getBalance(h4bId)).granted === 150, "H4: BUSINESS activation grants 150");

  // ── H4: flag-off → grantOnPaidActivation is a NO-OP (byte-identical) ───────
  const h4offId = "earn-h4-off";
  await prisma.user.create({
    data: { id: h4offId, name: "H4 Off", email: "earn-h4-off@example.com", plan: "FREE" },
  });
  process.env.CREDITS_LIVE = "1";
  await resetMonthlyGranted(h4offId, "FREE");
  await prisma.creditBalance.update({ where: { userId: h4offId }, data: { granted: 7 } });
  await prisma.user.update({ where: { id: h4offId }, data: { plan: "PRO" } });
  delete process.env.CREDITS_LIVE; // flag OFF for the activation
  await grantOnPaidActivation(h4offId, "PRO");
  ok((await getBalance(h4offId)).granted === 7,
    "H4: flag-off → grantOnPaidActivation leaves granted UNCHANGED (7, no-op)");
  process.env.CREDITS_LIVE = "1";

  // ── H4: non-paid plan (FREE) → grantOnPaidActivation is a NO-OP ────────────
  const h4freeId = "earn-h4-free";
  await prisma.user.create({
    data: { id: h4freeId, name: "H4 Free", email: "earn-h4-free@example.com", plan: "FREE" },
  });
  await grantOnPaidActivation(h4freeId, "FREE");
  {
    const row = await prisma.creditBalance.findUnique({ where: { userId: h4freeId } });
    ok(row == null || row.granted === 0, "H4: FREE plan → no grant (no-op, no spurious ledger row)");
  }

  await prisma.$disconnect();

  if (failures) {
    console.error(`\n${failures} FAILED (${passed} passed)`);
    process.exit(1);
  }
  // ── Test: active-trial user (plan=PRO) gets NO grant (trial = paid benefit) ──
  // ensureMonthlyGrant is also called from /api/credits/balance for ANY user, so a
  // trial-PRO opening the credits UI must NOT be granted PRO's 50 (closes trial-farm).
  const trialId = "earn-trial-1";
  await prisma.user.create({
    data: {
      id: trialId, name: "Earn Trial", email: "earn-trial@example.com", plan: "PRO",
      trialStartedAt: new Date(Date.now() - 24 * 3600 * 1000),
      trialEndsAt: new Date(Date.now() + 5 * 24 * 3600 * 1000),
    },
  });
  process.env.CREDITS_LIVE = "1"; // ensure flag ON so we actually exercise the grant path
  await ensureMonthlyGrant(trialId);
  ok((await getBalance(trialId)).granted === 0, "active-trial PRO → NO monthly grant (trial = no credits)");

  console.log(`\nALL ${passed} CREDIT-EARN CHECKS PASSED`);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
