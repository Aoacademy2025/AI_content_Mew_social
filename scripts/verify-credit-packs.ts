// Proof of the CREDIT_PACKS contract (Task P3-2). Run against a throwaway SQLite DB:
//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-credit-packs.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-credit-packs.db?connection_limit=1" npx tsx scripts/verify-credit-packs.ts
import { prisma } from "../src/lib/prisma";
import { CREDIT_PACKS, creditPack, grantCredits, grantCreditsOnce, getBalance } from "../src/lib/credits";

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

  // ── CREDIT_PACKS values ───────────────────────────────────────────────────
  assert(CREDIT_PACKS.starter.baht === 199,    "CREDIT_PACKS.starter.baht === 199");
  assert(CREDIT_PACKS.starter.credits === 200, "CREDIT_PACKS.starter.credits === 200");
  assert(CREDIT_PACKS.popular.baht === 499,    "CREDIT_PACKS.popular.baht === 499");
  assert(CREDIT_PACKS.popular.credits === 540, "CREDIT_PACKS.popular.credits === 540");
  assert(CREDIT_PACKS.pro.baht === 999,        "CREDIT_PACKS.pro.baht === 999");
  assert(CREDIT_PACKS.pro.credits === 1150,    "CREDIT_PACKS.pro.credits === 1150");

  // ── creditPack lookup ─────────────────────────────────────────────────────
  const starter = creditPack("starter");
  assert(starter !== null,               'creditPack("starter") is not null');
  assert(starter?.baht === 199,          'creditPack("starter").baht === 199');
  assert(starter?.credits === 200,       'creditPack("starter").credits === 200');

  const popular = creditPack("popular");
  assert(popular !== null,               'creditPack("popular") is not null');
  assert(popular?.baht === 499,          'creditPack("popular").baht === 499');
  assert(popular?.credits === 540,       'creditPack("popular").credits === 540');

  const pro = creditPack("pro");
  assert(pro !== null,                   'creditPack("pro") is not null');
  assert(pro?.baht === 999,              'creditPack("pro").baht === 999');
  assert(pro?.credits === 1150,          'creditPack("pro").credits === 1150');

  // ── creditPack("nope") === null ───────────────────────────────────────────
  assert(creditPack("nope") === null,    'creditPack("nope") === null');
  assert(creditPack("") === null,        'creditPack("") === null');
  assert(creditPack("POPULAR") === null, 'creditPack("POPULAR") === null (case-sensitive)');

  // ── grantCredits "purchase" puts credits in purchased bucket ──────────────
  const userId = "user-pack-test-1";
  await grantCredits(userId, CREDIT_PACKS.popular.credits, "purchase", "pack");
  const bal = await getBalance(userId);
  assert(bal.purchased === 540, `grantCredits(popular.credits,"purchase") → purchased === 540 (got ${bal.purchased})`);
  assert(bal.granted === 0,     'grantCredits("purchase") does not touch granted bucket');
  assert(bal.total === 540,     "total === 540 after popular pack purchase");

  // ── grantCreditsOnce idempotency ─────────────────────────────────────────
  const userId2 = "user-pack-test-2";
  // First call: should grant
  const r1 = await grantCreditsOnce(userId2, 540, "purchase", "pack:cs_test_1");
  assert(r1.granted === true, "grantCreditsOnce first call → granted:true");
  const bal2a = await getBalance(userId2);
  assert(bal2a.purchased === 540, `grantCreditsOnce first call → purchased === 540 (got ${bal2a.purchased})`);

  // Second call with same ref: should NOT double-grant
  const r2 = await grantCreditsOnce(userId2, 540, "purchase", "pack:cs_test_1");
  assert(r2.granted === false, "grantCreditsOnce duplicate ref → granted:false");
  const bal2b = await getBalance(userId2);
  assert(bal2b.purchased === 540, `grantCreditsOnce duplicate ref does NOT double-grant (got ${bal2b.purchased})`);

  // Third call with different ref: should grant again
  const r3 = await grantCreditsOnce(userId2, 540, "purchase", "pack:cs_test_2");
  assert(r3.granted === true, "grantCreditsOnce different ref → granted:true");
  const bal2c = await getBalance(userId2);
  assert(bal2c.purchased === 1080, `grantCreditsOnce different ref grants again → purchased === 1080 (got ${bal2c.purchased})`);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await prisma.creditLedger.deleteMany();
  await prisma.creditBalance.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} CREDIT PACK CHECKS PASSED`);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
