// #300 — pure test of the /pricing default-selection helper (NEXT_PUBLIC_PRICING_DEFAULT_RECURRING).
// Covers flag on/off, and the three account states the in-app pricing page can render for:
// an active PRO trial, a FREE (never-paid) account, and a paid account (both a one-time
// PromptPay term and a live recurring card subscription). See src/lib/pricing-display.ts.

import { getDefaultPricingSelection } from "../src/lib/pricing-display";

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

// --- Flag OFF — must reproduce today's live default (annual + PromptPay) ---

check("flag off / trial (no Stripe sub)",
  getDefaultPricingSelection({ recurringDefaultEnabled: false, subStatus: null, billingPeriod: null }),
  { period: "annual", method: "promptpay" });

check("flag off / FREE (no Stripe sub)",
  getDefaultPricingSelection({ recurringDefaultEnabled: false, subStatus: null, billingPeriod: null }),
  { period: "annual", method: "promptpay" });

check("flag off / paid, one-time PromptPay term (not active sub)",
  getDefaultPricingSelection({ recurringDefaultEnabled: false, subStatus: "canceled", billingPeriod: "annual" }),
  { period: "annual", method: "promptpay" });

check("flag off / paid, active ANNUAL card sub",
  getDefaultPricingSelection({ recurringDefaultEnabled: false, subStatus: "active", billingPeriod: "annual" }),
  { period: "annual", method: "promptpay" });

check("flag off / paid, active MONTHLY card sub -> method forced to card regardless of flag",
  getDefaultPricingSelection({ recurringDefaultEnabled: false, subStatus: "active", billingPeriod: "monthly" }),
  { period: "annual", method: "card" });

// --- Flag ON — default flips to monthly + card (#300) ---

check("flag on / trial (no Stripe sub)",
  getDefaultPricingSelection({ recurringDefaultEnabled: true, subStatus: null, billingPeriod: null }),
  { period: "monthly", method: "card" });

check("flag on / FREE (no Stripe sub)",
  getDefaultPricingSelection({ recurringDefaultEnabled: true, subStatus: null, billingPeriod: null }),
  { period: "monthly", method: "card" });

check("flag on / paid, one-time PromptPay term (not active sub)",
  getDefaultPricingSelection({ recurringDefaultEnabled: true, subStatus: "canceled", billingPeriod: "annual" }),
  { period: "monthly", method: "card" });

check("flag on / paid, active ANNUAL card sub",
  getDefaultPricingSelection({ recurringDefaultEnabled: true, subStatus: "active", billingPeriod: "annual" }),
  { period: "monthly", method: "card" });

check("flag on / paid, active MONTHLY card sub -> still card (override is a no-op here)",
  getDefaultPricingSelection({ recurringDefaultEnabled: true, subStatus: "active", billingPeriod: "monthly" }),
  { period: "monthly", method: "card" });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll pricing-defaults checks passed");
