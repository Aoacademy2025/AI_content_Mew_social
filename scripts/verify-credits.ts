// Proof of the credit-balance contract (Task P3-1). Run against a throwaway SQLite DB:
//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-credits.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-credits.db?connection_limit=1" npx tsx scripts/verify-credits.ts
import { prisma } from "../src/lib/prisma";
import {
  creditCostFor,
  getBalance,
  spendCredits,
  grantCredits,
  resetMonthlyGranted,
} from "../src/lib/credits";

let passed = 0;
function assert(c: boolean, m: string) {
  if (!c) { console.error("❌ " + m); process.exit(1); }
  console.log("✓ " + m);
  passed++;
}

async function main() {
  // Clean slate
  await prisma.creditLedger.deleteMany();
  await prisma.creditBalance.deleteMany();

  // ── creditCostFor ──────────────────────────────────────────────────────────
  assert(creditCostFor("minute") === 2, 'creditCostFor("minute") === 2');
  assert(creditCostFor("image-gpt-1k") === 3, 'creditCostFor("image-gpt-1k") === 3');
  assert(creditCostFor("image-nano-1k") === 4, 'creditCostFor("image-nano-1k") === 4');
  assert(creditCostFor("image-gpt-2k") === 5, 'creditCostFor("image-gpt-2k") === 5');
  assert(creditCostFor("image-nano-2k") === 6, 'creditCostFor("image-nano-2k") === 6');
  assert(creditCostFor("video-seedance-5s") === 10, 'creditCostFor("video-seedance-5s") === 10');
  assert(creditCostFor("unknown-action-xyz") === 0, 'creditCostFor("unknown-action-xyz") === 0 (unknown → 0)');

  // ── getBalance creates row on miss ─────────────────────────────────────────
  const userId = "user-credit-test-1";
  const bal0 = await getBalance(userId);
  assert(bal0.granted === 0, "getBalance: new user → granted = 0");
  assert(bal0.purchased === 0, "getBalance: new user → purchased = 0");
  assert(bal0.total === 0, "getBalance: new user → total = 0");

  // ── grantCredits "grant" → granted bucket ─────────────────────────────────
  await grantCredits(userId, 50, "grant", "monthly-reset");
  const bal1 = await getBalance(userId);
  assert(bal1.granted === 50, 'grantCredits("grant",50) → granted = 50');
  assert(bal1.purchased === 0, 'grantCredits("grant") does not touch purchased');
  assert(bal1.total === 50, 'total = 50 after grant');

  // ── grantCredits "purchase" → purchased bucket ────────────────────────────
  await grantCredits(userId, 100, "purchase", "stripe-pack");
  const bal2 = await getBalance(userId);
  assert(bal2.purchased === 100, 'grantCredits("purchase",100) → purchased = 100');
  assert(bal2.granted === 50, 'grantCredits("purchase") does not touch granted');

  // ── spendCredits: granted-first spend ─────────────────────────────────────
  // State: granted=50, purchased=100 → spend 30 → granted 20, purchased 100
  const r1 = await spendCredits(userId, 30, "image-nano-1k");
  assert(r1.ok === true, "spendCredits(30): ok=true");
  const bal3 = await getBalance(userId);
  assert(bal3.granted === 20, "granted-first: granted 50→20 after spend 30");
  assert(bal3.purchased === 100, "granted-first: purchased unchanged at 100");
  assert(r1.ok && r1.balanceAfter === 120, "spendCredits(30): balanceAfter = 120");

  // ── balanceAfter in ledger matches authoritative getBalance().total ────────
  const ledgerSpend1 = await prisma.creditLedger.findFirst({
    where: { userId, kind: "spend" },
    orderBy: { createdAt: "desc" },
  });
  const actualBal1 = await getBalance(userId);
  assert(
    ledgerSpend1 !== null && ledgerSpend1.balanceAfter === actualBal1.total,
    `ledger balanceAfter (${ledgerSpend1?.balanceAfter}) === actual getBalance total (${actualBal1.total})`
  );

  // ── spendCredits: spend spans both buckets ────────────────────────────────
  // Reset to: granted=10, purchased=100 → spend 30 → granted 0, purchased 80
  const userId2 = "user-credit-test-2";
  await grantCredits(userId2, 10, "grant");
  await grantCredits(userId2, 100, "purchase");
  const r2 = await spendCredits(userId2, 30, "video-seedance-5s");
  assert(r2.ok === true, "spend-spans-both: ok=true");
  const bal4 = await getBalance(userId2);
  assert(bal4.granted === 0, "spend-spans-both: granted → 0 (10 exhausted)");
  assert(bal4.purchased === 80, "spend-spans-both: purchased → 80 (20 from purchased)");

  // ── spendCredits: insufficient → balances UNCHANGED ───────────────────────
  // State: granted=5, purchased=5 → spend 20 → insufficient
  const userId3 = "user-credit-test-3";
  await grantCredits(userId3, 5, "grant");
  await grantCredits(userId3, 5, "purchase");
  const r3 = await spendCredits(userId3, 20, "image-nano-1k");
  assert(r3.ok === false, "insufficient: ok=false");
  assert(!r3.ok && r3.reason === "insufficient", 'insufficient: reason="insufficient"');
  const bal5 = await getBalance(userId3);
  assert(bal5.granted === 5, "insufficient: granted UNCHANGED at 5");
  assert(bal5.purchased === 5, "insufficient: purchased UNCHANGED at 5");
  assert(!r3.ok && r3.balanceAfter === 10, "insufficient: balanceAfter = 10 (current total)");

  // ── grantCredits "purchase" rollover adds to existing ────────────────────
  // userId already has granted=20, purchased=100 → grantCredits(200,"purchase") → purchased=300
  await grantCredits(userId, 200, "purchase");
  const bal6 = await getBalance(userId);
  assert(bal6.purchased === 300, 'purchase rollover: purchased 100 + 200 = 300');

  // ── resetMonthlyGranted ───────────────────────────────────────────────────
  // Sets granted := MONTHLY_GRANT[plan], regardless of prior value
  const userId4 = "user-credit-test-4";
  await grantCredits(userId4, 999, "grant"); // set a big prior value
  await resetMonthlyGranted(userId4, "PRO");
  const bal7 = await getBalance(userId4);
  assert(bal7.granted === 50, "resetMonthlyGranted PRO → granted = 50 (regardless of prior 999)");

  await resetMonthlyGranted(userId4, "FREE");
  const bal8 = await getBalance(userId4);
  assert(bal8.granted === 0, "resetMonthlyGranted FREE → granted = 0");

  await resetMonthlyGranted(userId4, "BUSINESS");
  const bal9 = await getBalance(userId4);
  assert(bal9.granted === 150, "resetMonthlyGranted BUSINESS → granted = 150");

  // ── CreditLedger: one row per successful spend/grant/reset ───────────────
  // userId has had: grantCredits(50 grant) + grantCredits(100 purchase)
  //                 + spendCredits(30) + grantCredits(200 purchase)
  // That is 4 operations → 4 ledger rows
  const ledgerRows = await prisma.creditLedger.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
  assert(ledgerRows.length >= 4, `ledger: userId has at least 4 rows (got ${ledgerRows.length})`);

  // Check one spend row has negative delta
  const spendRow = ledgerRows.find((r) => r.kind === "spend");
  assert(spendRow !== undefined, "ledger: a 'spend' row exists");
  assert(spendRow!.delta < 0, "ledger: spend row has negative delta");

  // Check grant rows have positive delta
  const grantRows = ledgerRows.filter((r) => r.kind === "grant" || r.kind === "purchase");
  assert(grantRows.length >= 3, `ledger: grant/purchase rows ≥ 3 (got ${grantRows.length})`);
  assert(grantRows.every((r) => r.delta > 0), "ledger: all grant/purchase rows have positive delta");

  // Verify userId3 (insufficient) has NO ledger rows (failed spend must not write ledger)
  const ledger3 = await prisma.creditLedger.findMany({ where: { userId: userId3 } });
  // userId3 has grant rows but NO spend row (the insufficient spend)
  const spendRows3 = ledger3.filter((r) => r.kind === "spend");
  assert(spendRows3.length === 0, "ledger: insufficient spend does NOT write a ledger row");

  // Reset rows for userId4
  const ledger4 = await prisma.creditLedger.findMany({
    where: { userId: userId4, kind: "grant" },
    orderBy: { createdAt: "asc" },
  });
  // Should have rows for the initial grantCredits(999) + 3 resets
  assert(ledger4.length >= 4, `ledger: userId4 reset rows ≥ 4 (got ${ledger4.length})`);

  // Cleanup
  await prisma.creditLedger.deleteMany();
  await prisma.creditBalance.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} CREDIT CHECKS PASSED`);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
