// Proof of the credit-overflow refund primitives (Task 2: refundCredits + creditsSpent).
// Run with: npx tsx scripts/verify-credit-overflow.ts
//
// Self-contained: spins a throwaway SQLite DB, pushes the real schema.prisma,
// dynamically imports helpers, asserts, exits non-zero on failure.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "creditoverflow-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failures = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error("FAIL:", msg); } else { passed++; console.log("ok:", msg); }
}

async function main() {
  const { refundCredits, getBalance, grantCredits } = await import("../src/lib/credits");
  const { recordChargedClip } = await import("../src/lib/clip-charge");
  const { prisma } = await import("../src/lib/prisma");

  // ── Seed a user with CreditBalance { granted: 0, purchased: 10 } ──────────
  const userId = "user-overflow-test-1";
  await grantCredits(userId, 10, "purchase", "seed-purchased");

  const balBefore = await getBalance(userId);
  ok(balBefore.purchased === 10, "seed: purchased = 10");
  ok(balBefore.granted === 0, "seed: granted = 0");
  ok(balBefore.total === 10, "seed: total = 10");

  // ── refundCredits (4-arg): restores per-bucket; overflow → purchased ───────
  await refundCredits(userId, 0, 4, "render-overflow-refund:job1");
  const bal = await getBalance(userId);
  ok(bal.purchased === 14, "refund (0,4) adds to purchased: 10 + 4 = 14");
  ok(bal.granted === 0, "refund (0,4) leaves granted = 0");
  ok(bal.total === 14, "refund total = 14");

  // ── refundCredits: writes a ledger row with kind:"refund" ─────────────────
  const row = await prisma.creditLedger.findFirst({
    where: { userId, action: "render-overflow-refund:job1" },
  });
  ok(row?.kind === "refund", "refund ledger row: kind = 'refund'");
  ok(row?.delta === 4, "refund ledger row: delta = 4 (sum of buckets)");
  ok((row?.balanceAfter ?? -1) === 14, "refund ledger row: balanceAfter = 14");

  // ── refundCredits (4-arg): restores granted bucket too ────────────────────
  await refundCredits(userId, 3, 0, "render-grant-refund:jobG");
  const balG = await getBalance(userId);
  ok(balG.granted === 3, "refund (3,0) adds to granted: 0 + 3 = 3");
  ok(balG.purchased === 14, "refund (3,0) leaves purchased = 14");
  ok(balG.total === 17, "refund (3,0) total = 17");

  // ── refundCredits: rejects NEGATIVE bucket amounts ────────────────────────
  let threw = false;
  try { await refundCredits(userId, -1, 0, "x"); } catch { threw = true; }
  ok(threw, "refundCredits(-1, 0) rejects with thrown error");

  let threw2 = false;
  try { await refundCredits(userId, 0, -5, "x"); } catch { threw2 = true; }
  ok(threw2, "refundCredits(0, -5) rejects with thrown error");

  // ── refundCredits: zero total is a no-op (no throw, no ledger row) ─────────
  await refundCredits(userId, 0, 0, "render-noop-refund");
  const balNoop = await getBalance(userId);
  ok(balNoop.total === 17, "refund (0,0) is a no-op — total unchanged at 17");
  const noopRow = await prisma.creditLedger.findFirst({
    where: { userId, action: "render-noop-refund" },
  });
  ok(noopRow === null, "refund (0,0) writes no ledger row");

  // ── refundCredits: accumulated via multiple calls (purchased) ─────────────
  await refundCredits(userId, 0, 6, "render-overflow-refund:job2");
  const bal2 = await getBalance(userId);
  ok(bal2.purchased === 20, "two purchased refunds: 14 + 6 = 20 in purchased");
  ok(bal2.total === 23, "running total = 23 (granted 3 + purchased 20)");

  // ── recordChargedClip 4-arg: stores creditsSpent ──────────────────────────
  const userId2 = "user-overflow-test-2";
  const urlC = "/api/renders/render-overflow-c.mp4";
  await recordChargedClip(userId2, urlC, undefined, 4);
  const rowC = await prisma.chargedClip.findFirst({
    where: { userId: userId2, outputUrl: urlC },
    select: { chargedMinutes: true, creditsSpent: true },
  });
  ok(rowC !== null, "recordChargedClip(u, url, undefined, 4) stored a row");
  ok(rowC?.creditsSpent === 4, "creditsSpent === 4 (credit-funded row)");
  ok(rowC?.chargedMinutes === null, "chargedMinutes === null when not supplied");

  // ── recordChargedClip 2-arg: creditsSpent stays null (backward-compat) ────
  const urlD = "/api/renders/render-overflow-d.mp4";
  await recordChargedClip(userId2, urlD);
  const rowD = await prisma.chargedClip.findFirst({
    where: { userId: userId2, outputUrl: urlD },
    select: { chargedMinutes: true, creditsSpent: true },
  });
  ok(rowD !== null, "recordChargedClip(u, urlD) 2-arg stored a row");
  ok(rowD?.creditsSpent === null, "2-arg call → creditsSpent === null (backward-compat)");
  ok(rowD?.chargedMinutes === null, "2-arg call → chargedMinutes === null (backward-compat)");

  // ── recordChargedClip 3-arg: creditsSpent stays null (backward-compat) ────
  const urlE = "/api/renders/render-overflow-e.mp4";
  await recordChargedClip(userId2, urlE, 3);
  const rowE = await prisma.chargedClip.findFirst({
    where: { userId: userId2, outputUrl: urlE },
    select: { chargedMinutes: true, creditsSpent: true },
  });
  ok(rowE !== null, "recordChargedClip(u, urlE, 3) 3-arg stored a row");
  ok(rowE?.chargedMinutes === 3, "3-arg call → chargedMinutes === 3");
  ok(rowE?.creditsSpent === null, "3-arg call → creditsSpent === null (backward-compat)");

  // ════════════════════════════════════════════════════════════════════════
  // H3 regression: an overflow refund MUST restore the EXACT buckets it drained.
  // The bug: reserveMinutesOrCredits spent via spendCredits (drains granted first,
  // then purchased) but DISCARDED the {fromGranted,fromPurchased} split, keeping only
  // the total; refundReservation then refunded the whole amount to `purchased`. Since
  // `granted` is hard-reset every month but `purchased` persists, that permanently
  // INFLATED purchased → free credits every month. These tests pin the fix: the split
  // is threaded through reserve → refund, so bucket-spent === bucket-refunded.
  // ════════════════════════════════════════════════════════════════════════
  const { spendCredits, resetMonthlyGranted } = await import("../src/lib/credits");
  const { reserveMinutesOrCredits, refundReservation } = await import("../src/lib/minute-credits");

  // ── H3-A: spendCredits drains granted FIRST and reports the bucket split ───
  const hUser = "user-h3-granted-first";
  await grantCredits(hUser, 50, "grant", "seed-granted");
  await grantCredits(hUser, 10, "purchase", "seed-purchased-h");
  const spendA = await spendCredits(hUser, 8, "render-overflow:jobA");
  ok(spendA.ok === true, "H3-A: spend 8 of (granted 50 / purchased 10) succeeds");
  if (spendA.ok) {
    ok(spendA.fromGranted === 8, "H3-A: fromGranted = 8 (granted drained first)");
    ok(spendA.fromPurchased === 0, "H3-A: fromPurchased = 0 (purchased untouched)");
  }
  const balHA = await getBalance(hUser);
  ok(balHA.granted === 42, "H3-A: granted 50 - 8 = 42");
  ok(balHA.purchased === 10, "H3-A: purchased still 10");

  // ── H3-B: refundReservation with the split restores GRANTED, not purchased ─
  await refundReservation(
    hUser,
    { reservedMinutes: null, creditsSpent: 8, creditsFromGranted: 8 },
    "render-refund:jobA",
  );
  const balHB = await getBalance(hUser);
  ok(balHB.granted === 50, "H3-B: refund restores granted back to 50 (NOT purchased)");
  ok(balHB.purchased === 10, "H3-B: purchased UNCHANGED at 10 (no inflation)");

  // ── H3-C: monthly reset after the refund shows NO inflation ───────────────
  await resetMonthlyGranted(hUser, "PRO");
  const balHC = await getBalance(hUser);
  ok(balHC.granted === 50, "H3-C: monthly reset → granted = 50");
  ok(balHC.purchased === 10, "H3-C: monthly reset → purchased STILL 10 (bug would show 18)");
  ok(balHC.total === 60, "H3-C: total = 60 (no free credits leaked)");

  // ── H3-D: full overflow path via reserveMinutesOrCredits returns the split ─
  // Out-of-minutes FREE user with granted credits. reserveMinutes fails → overflow
  // spends minutes×2 credits, draining granted first; the returned split is what the
  // route now threads to refund so the GRANTED bucket (not purchased) is restored.
  const oUser = "user-h3-overflow";
  await prisma.user.create({
    data: { id: oUser, name: "Overflow", email: "h3-overflow@example.com", plan: "FREE" },
  });
  await grantCredits(oUser, 50, "grant", "seed-granted-o");
  await grantCredits(oUser, 10, "purchase", "seed-purchased-o");
  // Exhaust the minute window (used >> any plan limit; window not expired → no reset).
  await prisma.user.update({
    where: { id: oUser },
    data: { minutesUsed: 9999, usagePeriodStartedAt: new Date() },
  });
  const reserveO = await reserveMinutesOrCredits(oUser, 4, { creditsLive: true, ref: "jobO" });
  ok(reserveO.allowed === true, "H3-D: out-of-minutes reserve overflows to credits (allowed)");
  ok(reserveO.allowed && reserveO.via === "credits", "H3-D: via = 'credits'");
  if (reserveO.allowed && reserveO.via === "credits") {
    ok(reserveO.creditsSpent === 8, "H3-D: creditsSpent = 4 min × 2 = 8");
    ok(reserveO.fromGranted === 8, "H3-D: fromGranted = 8 (granted drained first)");
    ok(reserveO.fromPurchased === 0, "H3-D: fromPurchased = 0");
    await refundReservation(
      oUser,
      { reservedMinutes: null, creditsSpent: reserveO.creditsSpent, creditsFromGranted: reserveO.fromGranted },
      "render-refund:jobO",
    );
  }
  const balO = await getBalance(oUser);
  ok(balO.granted === 50, "H3-D: after refund granted restored to 50 (overflow drained+restored granted)");
  ok(balO.purchased === 10, "H3-D: purchased UNCHANGED at 10 (not inflated)");

  // ── H3-E: mixed-bucket overflow (granted < cost) splits across both ────────
  const mUser = "user-h3-mixed";
  await prisma.user.create({
    data: { id: mUser, name: "Mixed", email: "h3-mixed@example.com", plan: "FREE" },
  });
  await grantCredits(mUser, 5, "grant", "seed-granted-m");
  await grantCredits(mUser, 20, "purchase", "seed-purchased-m");
  await prisma.user.update({
    where: { id: mUser },
    data: { minutesUsed: 9999, usagePeriodStartedAt: new Date() },
  });
  const reserveM = await reserveMinutesOrCredits(mUser, 4, { creditsLive: true, ref: "jobM" });
  ok(reserveM.allowed && reserveM.via === "credits", "H3-E: mixed overflow via credits");
  if (reserveM.allowed && reserveM.via === "credits") {
    ok(reserveM.creditsSpent === 8, "H3-E: cost = 8");
    ok(reserveM.fromGranted === 5, "H3-E: fromGranted = 5 (all of granted)");
    ok(reserveM.fromPurchased === 3, "H3-E: fromPurchased = 3 (remainder from purchased)");
    await refundReservation(
      mUser,
      { reservedMinutes: null, creditsSpent: reserveM.creditsSpent, creditsFromGranted: reserveM.fromGranted },
      "render-refund:jobM",
    );
  }
  const balM = await getBalance(mUser);
  ok(balM.granted === 5, "H3-E: granted restored to 5 (exact)");
  ok(balM.purchased === 20, "H3-E: purchased restored to 20 (exact, no inflation)");

  // ── H3-F: backward-compat — creditsFromGranted omitted → all-purchased ─────
  // An in-flight job enqueued BEFORE this fix has no split persisted. refundReservation
  // must not crash; it falls back to the prior behavior (refund the lump to purchased).
  const lUser = "user-h3-legacy";
  await grantCredits(lUser, 1, "purchase", "seed-legacy");
  await refundReservation(
    lUser,
    { reservedMinutes: null, creditsSpent: 6, creditsFromGranted: null },
    "render-refund:legacy",
  );
  const balL = await getBalance(lUser);
  ok(balL.purchased === 7, "H3-F: legacy (no split) → all 6 refunded to purchased (1 + 6 = 7)");
  ok(balL.granted === 0, "H3-F: legacy refund leaves granted = 0");

  await prisma.$disconnect();

  if (failures) {
    console.error(`\n${failures} FAILED (${passed} passed)`);
    process.exit(1);
  }
  console.log(`\nALL ${passed} CREDIT-OVERFLOW CHECKS PASSED`);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
