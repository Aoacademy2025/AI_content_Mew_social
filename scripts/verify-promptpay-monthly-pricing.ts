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
  seedMethodFromCancelReturn,
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

// ───────────────────────── seedMethodFromCancelReturn (BLOCKING-1 fix round 1) ─────────────────────────
// "today's annual default" stand-ins for NEXT_PUBLIC_PRICING_DEFAULT_RECURRING on/off,
// mirroring getDefaultPricingSelection's un-overridden annual/monthly defaults.
const annualDefaultCard = "card" as const;      // RECURRING on -> base method is "card"
const annualDefaultPromptpay = "promptpay" as const; // RECURRING off -> base method is "promptpay"

// annual + method=promptpay -> promptpay, regardless of the default (both RECURRING states)
check("annual, ?method=promptpay, flag on, offered, default=card (RECURRING on) -> promptpay",
  seedMethodFromCancelReturn("annual", { period: "annual", method: "promptpay" },
    { promptpayMonthlyEnabled: true, monthlyOffered: neither }, annualDefaultCard), "promptpay");
check("annual, ?method=promptpay, flag on, offered, default=promptpay (RECURRING off) -> promptpay",
  seedMethodFromCancelReturn("annual", { period: "annual", method: "promptpay" },
    { promptpayMonthlyEnabled: true, monthlyOffered: neither }, annualDefaultPromptpay), "promptpay");

// annual + method=card -> card, regardless of the default (both RECURRING states)
check("annual, ?method=card, flag on, default=card (RECURRING on) -> card",
  seedMethodFromCancelReturn("annual", { period: "annual", method: "card" },
    { promptpayMonthlyEnabled: true, monthlyOffered: neither }, annualDefaultCard), "card");
check("annual, ?method=card, flag on, default=promptpay (RECURRING off) -> card",
  seedMethodFromCancelReturn("annual", { period: "annual", method: "card" },
    { promptpayMonthlyEnabled: true, monthlyOffered: neither }, annualDefaultPromptpay), "card");

// no method param (or param targets the other period) -> today's annual default, untouched
check("annual, no cancelReturn param -> today's default (card)",
  seedMethodFromCancelReturn("annual", {}, { promptpayMonthlyEnabled: true, monthlyOffered: neither }, annualDefaultCard), "card");
check("annual, no cancelReturn param -> today's default (promptpay)",
  seedMethodFromCancelReturn("annual", {}, { promptpayMonthlyEnabled: true, monthlyOffered: neither }, annualDefaultPromptpay), "promptpay");
check("annual, cancelReturn targets monthly only -> annual default untouched",
  seedMethodFromCancelReturn("annual", { period: "monthly", method: "promptpay" },
    { promptpayMonthlyEnabled: true, monthlyOffered: both }, annualDefaultCard), "card");

// flag off -> method ignored on EVERY period, exactly as today (both promptpay and card params)
check("annual, ?method=promptpay, flag OFF -> ignored, default kept",
  seedMethodFromCancelReturn("annual", { period: "annual", method: "promptpay" },
    { promptpayMonthlyEnabled: false, monthlyOffered: neither }, annualDefaultCard), "card");
check("annual, ?method=card, flag OFF -> ignored, default kept",
  seedMethodFromCancelReturn("annual", { period: "annual", method: "card" },
    { promptpayMonthlyEnabled: false, monthlyOffered: neither }, annualDefaultPromptpay), "promptpay");
check("monthly, ?method=promptpay, flag OFF -> ignored, stays card",
  seedMethodFromCancelReturn("monthly", { period: "monthly", method: "promptpay" },
    { promptpayMonthlyEnabled: false, monthlyOffered: neither }, "card"), "card");
check("monthly, ?method=card, flag OFF -> ignored, stays card",
  seedMethodFromCancelReturn("monthly", { period: "monthly", method: "card" },
    { promptpayMonthlyEnabled: false, monthlyOffered: neither }, "card"), "card");

// monthly, flag on: promptpay only wins when actually offered for some tier (per-tier
// coercion still happens downstream via resolveMonthlyMethodForTier)
check("monthly, ?method=promptpay, flag on, PRO offered -> promptpay",
  seedMethodFromCancelReturn("monthly", { period: "monthly", method: "promptpay" },
    { promptpayMonthlyEnabled: true, monthlyOffered: proOnly }, "card"), "promptpay");
check("monthly, ?method=promptpay, flag on, NOT offered -> stays card (default)",
  seedMethodFromCancelReturn("monthly", { period: "monthly", method: "promptpay" },
    { promptpayMonthlyEnabled: true, monthlyOffered: neither }, "card"), "card");
check("monthly, ?method=card, flag on -> card",
  seedMethodFromCancelReturn("monthly", { period: "monthly", method: "card" },
    { promptpayMonthlyEnabled: true, monthlyOffered: both }, "card"), "card");

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
ok("pricing-client (BLOCKING-1 fix) seeds annual's method from seedMethodFromCancelReturn, not just monthly's",
  (pricingClient.match(/seedMethodFromCancelReturn\(\s*\n?\s*["']annual["']/g) ?? []).length >= 2);
ok("pricing-client (BLOCKING-1 fix) seeds monthly's method via seedMethodFromCancelReturn too",
  /seedMethodFromCancelReturn\(\s*\n?\s*["']monthly["']/.test(pricingClient));
ok("pricing-client no longer special-cases only `cancelReturn.period === \"monthly\"` for the preselect",
  !/cancelReturn\.period === ["']monthly["'] && shouldPreselectPromptpay/.test(pricingClient));

// ───────────────────────── A2 — cancel-banner monthly price formatting ─────────────────────────
// Review finding A2: the cancel-banner's monthly `{price}` must be formatted with
// `.toLocaleString()` exactly like the card's monthly price (`priceBlock`), so ฿1290 (an
// admin-set price ≥1000) reads as "1,290" on both surfaces, not "1290" on one of them.
{
  const monthlyBannerLine = pricingClient
    .split("\n")
    .find((l) => l.includes("ใช้ ${cancelBanner.plan} ได้ 30 วัน"));
  ok("A2: cancel-banner monthly price line exists",
    !!monthlyBannerLine);
  ok("A2: cancel-banner monthly price is formatted with .toLocaleString() (matches the card's priceBlock)",
    !!monthlyBannerLine && /\.price\)\s*\?\?\s*\([^)]*\)\)\.toLocaleString\(\)/.test(monthlyBannerLine));
}

// ───────────────────────── A3 — /api/user/me effect deps are primitives ─────────────────────────
// Review finding A3: the effect must depend on primitives (cancelReturn.period/.method,
// monthlyPromptpayOffered.PRO/.BUSINESS, the flag boolean, preferredPeriod) — or hoisted
// module-constant defaults — not on the whole `cancelReturn`/`monthlyPromptpayOffered` OBJECTS,
// whose identity changes on every re-render and would loop the fetch / reset the chosen period.
{
  const meEffectMatch = pricingClient.match(/fetch\("\/api\/user\/me"\)[\s\S]*?\}, \[([^\]]*)\]\);/);
  const deps = meEffectMatch?.[1] ?? "";
  ok("A3: the /api/user/me effect was found", !!meEffectMatch);
  ok("A3: effect deps do NOT include the whole `cancelReturn` object",
    !!meEffectMatch && !/\bcancelReturn\b(?!\.)/.test(deps));
  ok("A3: effect deps do NOT include the whole `monthlyPromptpayOffered` object",
    !!meEffectMatch && !/\bmonthlyPromptpayOffered\b(?!\.)/.test(deps));
  ok("A3: effect deps include cancelReturn.period", /\bcancelReturn\.period\b/.test(deps));
  ok("A3: effect deps include cancelReturn.method", /\bcancelReturn\.method\b/.test(deps));
  ok("A3: effect deps include monthlyPromptpayOffered.PRO", /\bmonthlyPromptpayOffered\.PRO\b/.test(deps));
  ok("A3: effect deps include monthlyPromptpayOffered.BUSINESS", /\bmonthlyPromptpayOffered\.BUSINESS\b/.test(deps));
  ok("A3: effect deps include promptpayMonthlyEnabledFlag", /\bpromptpayMonthlyEnabledFlag\b/.test(deps));
  ok("A3: effect deps include preferredPeriod", /\bpreferredPeriod\b/.test(deps));
}

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
