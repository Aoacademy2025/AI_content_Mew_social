import assert from "node:assert/strict";
import { corePlanFacts, supplementalPlanFeatures } from "../src/lib/marketing-plan-facts";
import { PLAN_CONFIG_DEFAULTS } from "../src/lib/plan-config";
import { limitsForPlan, minutesPerMonthForPlan } from "../src/lib/plan-limits";
import { marketingPriceBlock } from "../src/lib/pricing-display";
import { PLANS } from "../src/lib/stripe";

assert.equal(Number(PLAN_CONFIG_DEFAULTS.pro_price), PLANS.PRO.thb, "public Pro fallback price matches checkout");
assert.equal(Number(PLAN_CONFIG_DEFAULTS.business_price), PLANS.BUSINESS.thb, "public Business fallback price matches checkout");

for (const [tier, plan] of [["free", "FREE"], ["pro", "PRO"], ["business", "BUSINESS"]] as const) {
  const facts = corePlanFacts(tier, true).join(" | ");
  assert.match(facts, new RegExp(String(limitsForPlan(plan).clips)), `${tier} exposes the enforced clip cap`);
  assert.match(facts, new RegExp(String(minutesPerMonthForPlan(plan))), `${tier} exposes the enforced minute cap`);
  assert.doesNotMatch(facts, /~/u, `${tier} uses exact limits, not approximate clip claims`);
}

const annual = marketingPriceBlock({ monthlyPrice: PLANS.PRO.thb, period: "annual", founding: null });
assert.equal(annual.amount, "฿499", "Pro annual monthly-equivalent is rounded to ฿499");
assert.match(annual.sub, /฿5,990\/ปี/u, "Pro annual card states the actual amount charged");
assert.match(annual.billingNote, /PromptPay จ่ายครั้งเดียว/u, "annual copy explains PromptPay semantics");
assert.match(annual.billingNote, /บัตรต่ออัตโนมัติ/u, "annual copy explains card renewal semantics");

const founding = marketingPriceBlock({
  monthlyPrice: PLANS.PRO.thb,
  period: "annual",
  founding: { active: true, percentOff: 50 },
});
assert.equal(founding.amount, "฿250", "active founding Pro is ฿250 monthly-equivalent");
assert.match(founding.sub, /฿2,995\/ปี/u, "active founding Pro states the exact annual charge");

const descriptive = supplementalPlanFeatures([
  "80 นาที/เดือน · ~80 คลิป · ยาวสุด 6 นาที",
  "เติมเครดิตเมื่อใช้เกินโควต้า · เก็บวิดีโอ 7 วัน",
]);
assert.deepEqual(descriptive, ["เติมเครดิตเมื่อใช้เกินโควต้า"], "free-form benefits cannot override canonical limits");

console.log("PASS marketing pricing matches checkout prices, entitlement limits, and billing semantics");
