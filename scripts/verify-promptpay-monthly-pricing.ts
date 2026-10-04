// Task 2 — Pricing UI (ADR 0066, docs/plans/2026-10-04-promptpay-monthly.md).
// Pure-function + source-text proof for the pricing-page PromptPay monthly surfaces.
// Appended to `verify:promptpay-monthly` (package.json). No Stripe, no DB.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cancelBannerOffered,
  monthlyPromptpayAvailable,
  periodPromptpayOffered,
  resolveMonthlyMethodForTier,
  shouldPreselectPromptpay,
  type MonthlyOffered,
} from "../src/lib/pricing-period-method";
import { marketingPriceBlock } from "../src/lib/pricing-display";
import { paidPlanCardMode } from "../src/lib/plan-change";

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
function ok(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

const neither: MonthlyOffered = { PRO: false, BUSINESS: false };
const proOnly: MonthlyOffered = { PRO: true, BUSINESS: false };
const both: MonthlyOffered = { PRO: true, BUSINESS: true };

// ───────────────────────── monthlyPromptpayAvailable ─────────────────────────
check("neither tier offered -> not available", monthlyPromptpayAvailable(neither), false);
check("one tier offered -> available (toggle shown)", monthlyPromptpayAvailable(proOnly), true);
check("both tiers offered -> available", monthlyPromptpayAvailable(both), true);

// ───────────────────────── periodPromptpayOffered ─────────────────────────
check("monthly, flag on, no price -> not offered",
  periodPromptpayOffered("monthly", { promptpayMonthlyEnabled: true, monthlyOffered: neither }), false);
check("monthly, flag on, PRO priced -> offered",
  periodPromptpayOffered("monthly", { promptpayMonthlyEnabled: true, monthlyOffered: proOnly }), true);
check("annual, flag off -> not offered (new behavior gated)",
  periodPromptpayOffered("annual", { promptpayMonthlyEnabled: false, monthlyOffered: both }), false);
check("annual, flag on -> offered (today's annual PromptPay, un-gated price)",
  periodPromptpayOffered("annual", { promptpayMonthlyEnabled: true, monthlyOffered: neither }), true);

// ───────────────────────── resolveMonthlyMethodForTier ─────────────────────────
check("PRO selected promptpay, PRO offered -> promptpay",
  resolveMonthlyMethodForTier("promptpay", "PRO", proOnly), "promptpay");
check("BUSINESS selected promptpay, only PRO offered -> coerced to card (mirrors server)",
  resolveMonthlyMethodForTier("promptpay", "BUSINESS", proOnly), "card");
check("card selected -> always card regardless of offered",
  resolveMonthlyMethodForTier("card", "PRO", both), "card");
check("promptpay selected, neither offered -> card",
  resolveMonthlyMethodForTier("promptpay", "PRO", neither), "card");

// ───────────────────────── cancelBannerOffered ─────────────────────────
check("no plan -> no banner", cancelBannerOffered({ period: "monthly", method: "card" }, { promptpayMonthlyEnabled: true, monthlyOffered: both }), false);
check("session was promptpay (not card) -> no banner (nothing to offer)",
  cancelBannerOffered({ plan: "PRO", period: "monthly", method: "promptpay" }, { promptpayMonthlyEnabled: true, monthlyOffered: both }), false);
check("monthly card cancel, PRO offered -> banner",
  cancelBannerOffered({ plan: "PRO", period: "monthly", method: "card" }, { promptpayMonthlyEnabled: true, monthlyOffered: proOnly }), true);
check("monthly card cancel, BUSINESS NOT offered -> no banner (per-tier, not per-any)",
  cancelBannerOffered({ plan: "BUSINESS", period: "monthly", method: "card" }, { promptpayMonthlyEnabled: true, monthlyOffered: proOnly }), false);
check("annual card cancel, flag on -> banner (today's annual PromptPay availability)",
  cancelBannerOffered({ plan: "BUSINESS", period: "annual", method: "card" }, { promptpayMonthlyEnabled: true, monthlyOffered: neither }), true);
check("annual card cancel, flag off -> no banner",
  cancelBannerOffered({ plan: "BUSINESS", period: "annual", method: "card" }, { promptpayMonthlyEnabled: false, monthlyOffered: neither }), false);
check("flag off entirely, monthly card cancel -> no banner",
  cancelBannerOffered({ plan: "PRO", period: "monthly", method: "card" }, { promptpayMonthlyEnabled: false, monthlyOffered: neither }), false);

// ───────────────────────── shouldPreselectPromptpay ─────────────────────────
check("method=promptpay, monthly offered -> preselect",
  shouldPreselectPromptpay({ period: "monthly", method: "promptpay" }, { promptpayMonthlyEnabled: true, monthlyOffered: proOnly }), true);
check("method=promptpay, monthly NOT offered -> ignored",
  shouldPreselectPromptpay({ period: "monthly", method: "promptpay" }, { promptpayMonthlyEnabled: true, monthlyOffered: neither }), false);
check("method=card -> never preselects promptpay",
  shouldPreselectPromptpay({ period: "monthly", method: "card" }, { promptpayMonthlyEnabled: true, monthlyOffered: both }), false);
check("no period -> ignored",
  shouldPreselectPromptpay({ method: "promptpay" }, { promptpayMonthlyEnabled: true, monthlyOffered: both }), false);

// ───────────────────────── marketingPriceBlock(offered) ─────────────────────────
const monthlyNotOffered = marketingPriceBlock({ monthlyPrice: 599, period: "monthly", founding: null });
assert.equal(monthlyNotOffered.billingNote, "ชำระด้วยบัตร · ต่ออัตโนมัติและยกเลิกได้");
ok("marketingPriceBlock default (no `offered` arg) keeps unchanged monthly billingNote", true);

const monthlyOfferedFalse = marketingPriceBlock({ monthlyPrice: 599, period: "monthly", founding: null, offered: false });
check("marketingPriceBlock monthly, offered:false -> unchanged billingNote",
  monthlyOfferedFalse.billingNote, "ชำระด้วยบัตร · ต่ออัตโนมัติและยกเลิกได้");

const monthlyOfferedTrue = marketingPriceBlock({ monthlyPrice: 599, period: "monthly", founding: null, offered: true });
check("marketingPriceBlock monthly, offered:true -> new billingNote",
  monthlyOfferedTrue.billingNote, "บัตร (ต่ออัตโนมัติ) หรือ PromptPay (ครั้งละ 30 วัน)");

const annualOfferedTrue = marketingPriceBlock({ monthlyPrice: 599, period: "annual", founding: null, offered: true });
check("marketingPriceBlock annual ignores `offered` (unchanged copy)",
  annualOfferedTrue.billingNote, "PromptPay จ่ายครั้งเดียว · บัตรต่ออัตโนมัติ");

// ───────────────────────── paidPlanCardMode: monthly PromptPay never "wait" ─────────────────────────
const now = new Date("2026-06-26T00:00:00Z");
const future = new Date("2026-07-10T00:00:00Z");

check("monthly card + running timed plan -> wait (unchanged)",
  paidPlanCardMode(
    { currentPlan: "PRO", subStatus: null, isTrialPlan: false, planExpiresAt: future, paymentMethod: "card" },
    "PRO", "monthly", now,
  ), "wait");
check("monthly PromptPay + running timed plan -> renew, never wait (ADR 0066 fix a)",
  paidPlanCardMode(
    { currentPlan: "PRO", subStatus: null, isTrialPlan: false, planExpiresAt: future, paymentMethod: "promptpay" },
    "PRO", "monthly", now,
  ), "renew");
check("annual card + running timed plan -> renew (period alone never implied recurring)",
  paidPlanCardMode(
    { currentPlan: "PRO", subStatus: null, isTrialPlan: false, planExpiresAt: future, paymentMethod: "promptpay" },
    "PRO", "annual", now,
  ), "renew");

// ───────────────────────── paidPlanCardMode: BUSINESS renew fix (ungated) ─────────────────────────
check("BUSINESS cash user, no live sub -> renew (previously only PRO)",
  paidPlanCardMode({ currentPlan: "BUSINESS", subStatus: null, isTrialPlan: false }, "BUSINESS"), "renew");
check("PRO cash user, no live sub -> renew (unchanged)",
  paidPlanCardMode({ currentPlan: "PRO", subStatus: null, isTrialPlan: false }, "PRO"), "renew");

// ───────────────────────── Source-text wiring ─────────────────────────
const pricingClient = readFileSync("src/app/(dashboard)/pricing/pricing-client.tsx", "utf8");
const pricingPage = readFileSync("src/app/(dashboard)/pricing/page.tsx", "utf8");
const marketingPage = readFileSync("src/app/page.tsx", "utf8");
const pricingToggle = readFileSync("src/components/marketing/pricing-toggle.tsx", "utf8");
const planChange = readFileSync("src/lib/plan-change.ts", "utf8");

ok("pricing-client imports the pure period/method helpers (no server I/O in the client bundle)",
  /from ["']@\/lib\/pricing-period-method["']/.test(pricingClient));
ok("pricing-client renders the monthly PromptPay toggle copy",
  pricingClient.includes("PromptPay · 30 วัน") && pricingClient.includes("บัตร · ต่ออัตโนมัติ"));
ok("pricing-client renders the monthly+PromptPay card note copy exactly",
  pricingClient.includes("ใช้ได้ 30 วัน · ไม่ตัดเงินอัตโนมัติ"));
ok("pricing-client renders the cancel-return PromptPay banner title",
  pricingClient.includes("บัตรใช้ไม่ได้? จ่ายด้วย PromptPay แทนได้"));
ok("pricing-client renders the monthly cancel-banner body copy",
  pricingClient.includes("ได้ 30 วัน ไม่ต้องใช้บัตร"));
ok("pricing-client renders the annual cancel-banner body copy (no amount)",
  pricingClient.includes("ได้ 1 ปี ไม่ต้องใช้บัตร"));
ok("pricing-client renders the cancel-banner button copy",
  pricingClient.includes("จ่ายด้วย PromptPay"));
ok("pricing-client still renders the unchanged plain cancel copy for the fallback case",
  pricingClient.includes("ยกเลิกการชำระเงินแล้ว — กลับมาเลือกแพ็กได้ทุกเมื่อ"));
ok("pricing-client fires cancel_return_promptpay telemetry",
  pricingClient.includes("cancel_return_promptpay"));
ok("pricing-client keeps card as the static monthly toggle default (no flag-based reordering)",
  /\(\["card", "promptpay"\] as const\)/.test(pricingClient));

ok("pricing page parses the whitelisted cancel-return params via parseCancelReturnParams",
  /parseCancelReturnParams\(/.test(pricingPage));
ok("pricing page resolves promptpayMonthlyOffered per paid tier",
  /promptpayMonthlyOffered\(["']PRO["']\)/.test(pricingPage) && /promptpayMonthlyOffered\(["']BUSINESS["']\)/.test(pricingPage));
ok("pricing page resolves promptpayMonthlyEnabled for the annual banner/preselect gate",
  /promptpayMonthlyEnabled\(/.test(pricingPage));

ok("marketing homepage resolves promptpayMonthlyOffered per paid tier (server-side, no NEXT_PUBLIC_ twin)",
  /promptpayMonthlyOffered\(["']PRO["']\)/.test(marketingPage) && /promptpayMonthlyOffered\(["']BUSINESS["']\)/.test(marketingPage));
ok("PricingToggle forwards `offered` into marketingPriceBlock",
  /marketingPriceBlock\(\{[^}]*offered/s.test(pricingToggle));

ok("plan-change: recurring is method-derived, not period-derived",
  /paymentMethod\s*===\s*["']card["']/.test(planChange) && !/cardPeriod\s*===\s*["']monthly["']\s*\|\|\s*state\.paymentMethod/.test(planChange));
ok("plan-change: BUSINESS renew fix is ungated (no PRO-only guard left on the renew branch)",
  !/cardPlan === ["']PRO["'] && !liveSubscription/.test(planChange));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll promptpay-monthly pricing-UI checks passed");
