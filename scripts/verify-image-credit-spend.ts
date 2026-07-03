// Proof of the managed-kie image money path (Task 3). Run against a throwaway SQLite:
//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-image-credit.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-image-credit.db?connection_limit=1" npx tsx scripts/verify-image-credit-spend.ts
//
// Covers: cost-key mapping · access/metering truth table (flag-off · FREE 403 ·
// admin bypass · paid metered) · spend-before-generate granted-first · insufficient
// → skip + no charge · kie-failure → exact-bucket refund · guardrails (per-job cap,
// hourly rate, prompt cap). Ledger actions match the admin/costs dashboard
// ("ai-image" / "ai-image-refund").
import { prisma } from "../src/lib/prisma";
import {
  creditCostFor,
  costKeyForKieModel,
  spendCredits,
  refundCredits,
  grantCredits,
  getBalance,
} from "../src/lib/credits";
import {
  resolveKieImageAccess,
  kieMaxImagesPerJob,
  kieImageRatePerHour,
  tryConsumeKieImageRate,
  capKiePrompt,
  __resetKieImageRateForTest,
  KIE_PROMPT_MAX_CHARS,
} from "../src/lib/kie-image-guards";

let passed = 0;
function assert(c: boolean, m: string) {
  if (!c) { console.error("❌ " + m); process.exit(1); }
  console.log("✓ " + m);
  passed++;
}

const SPEND_ACTION = "ai-image";          // must match admin/costs/route.ts spend query
const REFUND_ACTION = "ai-image-refund";  // must match admin/costs/route.ts refund query
const DEFAULT_MODEL = "gpt-image-2-text-to-image";

// ── Faithful replica of the route's attemptImageSpend + finally-refund flow ──
// Mirrors fetch-stock: admins / flag-off never spend; paid users spend the priced
// cost before generating, and refund the exact buckets if generation fails.
async function simulateGenerate(opts: {
  userId: string;
  plan: string;
  isAdmin: boolean;
  managedKieOn: boolean;
  creditsLive: boolean;
  model: string;
  kieSucceeds: boolean;
}): Promise<{ charged: boolean; cost: number; skipped: "credits" | null; refunded: boolean }> {
  const isPaidPlan = opts.plan === "PRO" || opts.plan === "BUSINESS";
  const { chargeImages } = resolveKieImageAccess({
    managedKieOn: opts.managedKieOn,
    creditsLive: opts.creditsLive,
    isAdmin: opts.isAdmin,
    isPaidPlan,
  });

  if (!chargeImages) return { charged: false, cost: 0, skipped: null, refunded: false };

  // Non-admin paid users are restricted to priced models (coerce unpriced → default).
  const model = costKeyForKieModel(opts.model) === null ? DEFAULT_MODEL : opts.model;
  const cost = creditCostFor(costKeyForKieModel(model)!);

  const spend = await spendCredits(opts.userId, cost, SPEND_ACTION);
  if (!spend.ok) return { charged: false, cost, skipped: "credits", refunded: false };

  if (opts.kieSucceeds) return { charged: true, cost, skipped: null, refunded: false };

  // Generation failed after charge → refund exact buckets.
  await refundCredits(opts.userId, spend.fromGranted, spend.fromPurchased, REFUND_ACTION);
  return { charged: true, cost, skipped: null, refunded: true };
}

async function main() {
  await prisma.creditLedger.deleteMany();
  await prisma.creditBalance.deleteMany();

  // ── 1. Cost-key mapping (LOCKED prices) ────────────────────────────────────
  assert(costKeyForKieModel("flux-2/pro-text-to-image") === "image-flux-1k", 'flux-2/pro → image-flux-1k');
  assert(costKeyForKieModel("gpt-image-2-text-to-image") === "image-gpt-1k", 'gpt-image-2 → image-gpt-1k');
  assert(costKeyForKieModel("nano-banana-2") === "image-nano-1k", 'nano-banana-2 → image-nano-1k');
  assert(costKeyForKieModel("nano-banana-pro") === null, 'nano-banana-pro → null (admin-only)');
  assert(costKeyForKieModel("seedream/4.5-text-to-image") === null, 'seedream → null');
  assert(costKeyForKieModel("qwen2/text-to-image") === null, 'qwen2 → null');
  assert(creditCostFor("image-flux-1k") === 2, 'image-flux-1k = 2 credits');
  assert(creditCostFor("image-gpt-1k") === 3, 'image-gpt-1k = 3 credits');
  assert(creditCostFor("image-nano-1k") === 4, 'image-nano-1k = 4 credits');

  // ── 2. Access / metering truth table ───────────────────────────────────────
  const flagOff = resolveKieImageAccess({ managedKieOn: false, creditsLive: true, isAdmin: false, isPaidPlan: true });
  assert(!flagOff.kiePaidUnlocked && !flagOff.chargeImages, 'flag-off → not unlocked, not charged (byte-identical)');

  const free = resolveKieImageAccess({ managedKieOn: true, creditsLive: true, isAdmin: false, isPaidPlan: false });
  assert(!free.kiePaidUnlocked && !free.chargeImages, 'FREE non-admin → locked (403), not charged');

  const creditsOff = resolveKieImageAccess({ managedKieOn: true, creditsLive: false, isAdmin: false, isPaidPlan: true });
  assert(!creditsOff.kiePaidUnlocked, 'paid but CREDITS_LIVE off → still locked');

  const paid = resolveKieImageAccess({ managedKieOn: true, creditsLive: true, isAdmin: false, isPaidPlan: true });
  assert(paid.kiePaidUnlocked && paid.chargeImages, 'PRO/BUSINESS non-admin managed → unlocked AND charged');

  const admin = resolveKieImageAccess({ managedKieOn: true, creditsLive: true, isAdmin: true, isPaidPlan: true });
  assert(admin.kiePaidUnlocked && !admin.chargeImages, 'admin managed → unlocked but NOT charged (free)');

  const adminFree = resolveKieImageAccess({ managedKieOn: true, creditsLive: true, isAdmin: true, isPaidPlan: false });
  assert(!adminFree.chargeImages, 'admin (any plan) never charged');

  // ── 3. Spend happy path — granted-first ────────────────────────────────────
  const u1 = "img-user-paid-1";
  await grantCredits(u1, 5, "grant");      // granted = 5
  await grantCredits(u1, 10, "purchase");  // purchased = 10
  const r1 = await simulateGenerate({ userId: u1, plan: "PRO", isAdmin: false, managedKieOn: true, creditsLive: true, model: "gpt-image-2-text-to-image", kieSucceeds: true });
  assert(r1.charged && r1.cost === 3, 'happy path: charged 3 (gpt-image-2)');
  const b1 = await getBalance(u1);
  assert(b1.granted === 2 && b1.purchased === 10, 'granted-first: granted 5→2, purchased untouched at 10');
  const spendRow1 = await prisma.creditLedger.findFirst({ where: { userId: u1, kind: "spend" }, orderBy: { createdAt: "desc" } });
  assert(spendRow1?.action === SPEND_ACTION && spendRow1?.delta === -3, 'ledger: spend action "ai-image", delta -3');

  // ── 4. Insufficient → skip + NO charge, balances unchanged, no ledger row ──
  const u2 = "img-user-poor";
  await grantCredits(u2, 1, "grant"); // 1 credit, needs 3
  const r2 = await simulateGenerate({ userId: u2, plan: "PRO", isAdmin: false, managedKieOn: true, creditsLive: true, model: "gpt-image-2-text-to-image", kieSucceeds: true });
  assert(!r2.charged && r2.skipped === "credits", 'insufficient → skipped="credits", not charged (stock fallback signal)');
  const b2 = await getBalance(u2);
  assert(b2.granted === 1 && b2.total === 1, 'insufficient: balance UNCHANGED at 1');
  const spendRows2 = await prisma.creditLedger.count({ where: { userId: u2, kind: "spend" } });
  assert(spendRows2 === 0, 'insufficient: NO spend ledger row written');

  // ── 5. kie-failure → exact-bucket refund (spans both buckets) ──────────────
  const u3 = "img-user-refund";
  await grantCredits(u3, 2, "grant");     // granted = 2
  await grantCredits(u3, 10, "purchase"); // purchased = 10
  const before3 = await getBalance(u3);
  // nano-banana-2 costs 4 → drains 2 granted + 2 purchased
  const r3 = await simulateGenerate({ userId: u3, plan: "BUSINESS", isAdmin: false, managedKieOn: true, creditsLive: true, model: "nano-banana-2", kieSucceeds: false });
  assert(r3.charged && r3.cost === 4 && r3.refunded, 'kie-fail: charged 4 then refunded');
  const after3 = await getBalance(u3);
  assert(after3.granted === before3.granted && after3.purchased === before3.purchased, 'refund restores EXACT buckets (granted 2, purchased 10)');
  const refundRow3 = await prisma.creditLedger.findFirst({ where: { userId: u3, kind: "refund" }, orderBy: { createdAt: "desc" } });
  assert(refundRow3?.action === REFUND_ACTION && refundRow3?.delta === 4, 'ledger: refund action "ai-image-refund", delta +4');
  const spendCount3 = await prisma.creditLedger.count({ where: { userId: u3, kind: "spend" } });
  const refundCount3 = await prisma.creditLedger.count({ where: { userId: u3, kind: "refund" } });
  assert(spendCount3 === 1 && refundCount3 === 1, 'kie-fail: exactly one spend + one refund row (net zero)');

  // ── 6. Admin bypass — no charge even with a balance ────────────────────────
  const u4 = "img-user-admin";
  await grantCredits(u4, 100, "grant");
  const before4 = await getBalance(u4);
  const r4 = await simulateGenerate({ userId: u4, plan: "PRO", isAdmin: true, managedKieOn: true, creditsLive: true, model: "nano-banana-pro", kieSucceeds: true });
  assert(!r4.charged, 'admin: generation NOT charged');
  const after4 = await getBalance(u4);
  assert(after4.total === before4.total, 'admin: balance unchanged (100)');
  const anyRow4 = await prisma.creditLedger.count({ where: { userId: u4, kind: "spend" } });
  assert(anyRow4 === 0, 'admin: no spend ledger row');

  // ── 7. FREE 403 — never reaches spend ──────────────────────────────────────
  const u5 = "img-user-free";
  await grantCredits(u5, 100, "grant"); // even with credits, FREE is gated
  const freeAccess = resolveKieImageAccess({ managedKieOn: true, creditsLive: true, isAdmin: false, isPaidPlan: false });
  assert(!freeAccess.kiePaidUnlocked, 'FREE: kiePaidUnlocked false → route returns 403 before any spend');
  const r5 = await simulateGenerate({ userId: u5, plan: "FREE", isAdmin: false, managedKieOn: true, creditsLive: true, model: "gpt-image-2-text-to-image", kieSucceeds: true });
  assert(!r5.charged, 'FREE: not charged (chargeImages false)');
  const after5 = await getBalance(u5);
  assert(after5.total === 100, 'FREE: balance unchanged');

  // ── 8. Flag-off — no spend, byte-identical to BYOK ─────────────────────────
  const u6 = "img-user-flagoff";
  await grantCredits(u6, 100, "grant");
  const r6 = await simulateGenerate({ userId: u6, plan: "PRO", isAdmin: false, managedKieOn: false, creditsLive: true, model: "gpt-image-2-text-to-image", kieSucceeds: true });
  assert(!r6.charged, 'flag-off: PRO user NOT charged (MANAGED_KIE unset)');
  const after6 = await getBalance(u6);
  assert(after6.total === 100, 'flag-off: balance unchanged');

  // ── 9. Unpriced model coercion for non-admin paid ──────────────────────────
  const u7 = "img-user-coerce";
  await grantCredits(u7, 100, "grant");
  // Request an admin-only model as a paid non-admin → coerced to default (gpt, 3cr)
  const r7 = await simulateGenerate({ userId: u7, plan: "PRO", isAdmin: false, managedKieOn: true, creditsLive: true, model: "nano-banana-pro", kieSucceeds: true });
  assert(r7.charged && r7.cost === 3, 'paid unpriced model → coerced to default priced (3 credits), never free');

  // ── 10. Guardrails ─────────────────────────────────────────────────────────
  assert(kieMaxImagesPerJob() === 20, 'per-job cap default = 20');
  assert(kieImageRatePerHour() === 60, 'hourly rate default = 60');

  __resetKieImageRateForTest();
  const rateUser = "img-rate-user";
  const t0 = Date.now();
  let allowed = 0;
  for (let i = 0; i < 65; i++) if (tryConsumeKieImageRate(rateUser, t0)) allowed++;
  assert(allowed === 60, `rate limiter: allows exactly 60/hour (got ${allowed})`);
  assert(!tryConsumeKieImageRate(rateUser, t0), 'rate limiter: 61st blocked within the window');
  assert(tryConsumeKieImageRate(rateUser, t0 + 61 * 60 * 1000), 'rate limiter: allowed again after the window slides');

  const longPrompt = "a".repeat(5000);
  assert(capKiePrompt(longPrompt).length === KIE_PROMPT_MAX_CHARS, `prompt cap: 5000 → ${KIE_PROMPT_MAX_CHARS}`);
  assert(capKiePrompt("short").length === 5, 'prompt cap: short prompt untouched');

  await prisma.creditLedger.deleteMany();
  await prisma.creditBalance.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} IMAGE-CREDIT-SPEND CHECKS PASSED`);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
