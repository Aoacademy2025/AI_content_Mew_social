// Guards the customer-facing Founding claim against the billing reality.
// Run: npx tsx scripts/verify-founding-copy-truth.ts
//
// The dashboard banner promised "ลด 50% ตลอดชีพ" while the other two surfaces said
// "รายปีลด 50%". The lifetime wording was not true in either sense a customer could read it:
//   - the discount applies to the ANNUAL price only (pricing-display.ts gates foundingPct on
//     period === "annual"), so it is not a discount on everything; and
//   - on prod, 11 of 13 seat holders bought a one-time 365-day term with no renewing
//     subscription, so there is no recurring invoice for a "forever" coupon to apply to.
// This test keeps every founding surface saying the same, checkable thing.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { computeDisplayPrice } from "../src/lib/pricing-display";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

// ── A. No surface may claim a lifetime/forever benefit ──
const SURFACES = [
  "src/components/marketing/founder-banner.tsx",
  "src/components/marketing/pricing-toggle.tsx",
  "src/app/(dashboard)/pricing/pricing-client.tsx",
  "src/app/page.tsx",
];
const LIFETIME_CLAIMS = ["ตลอดชีพ", "ตลอดไป", "lifetime", "ไม่ต้องจ่ายอีก"];
for (const surface of SURFACES) {
  // Strip block comments so the explanatory note about the old wording is not read as copy.
  const body = read(surface).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const claim of LIFETIME_CLAIMS) {
    check(`A: ${surface} does not promise "${claim}"`, !body.includes(claim));
  }
}

// ── B. Every founding surface says the discount is the ANNUAL price ──
for (const surface of [
  "src/components/marketing/founder-banner.tsx",
  "src/components/marketing/pricing-toggle.tsx",
  "src/app/(dashboard)/pricing/pricing-client.tsx",
]) {
  const body = read(surface).replace(/\/\*[\s\S]*?\*\//g, "");
  check(`B: ${surface} scopes the founding discount to รายปี`, body.includes("รายปี"));
}

// ── C. The copy matches what the price engine actually does ──
const monthly = 599;
const annualFounding = computeDisplayPrice({
  monthlyPrice: monthly, period: "annual", coupon: null, founding: { active: true, percentOff: 50 },
});
const monthlyFounding = computeDisplayPrice({
  monthlyPrice: monthly, period: "monthly", coupon: null, founding: { active: true, percentOff: 50 },
});
check("C1: annual is discounted while the offer is open", annualFounding.isFounding);
check(
  "C2: monthly is NOT discounted — the copy must never imply otherwise",
  !monthlyFounding.isFounding,
);
check(
  "C3: annual base is ten months (two free), not twelve",
  annualFounding.base === monthly * 10,
  `base=${annualFounding.base}`,
);
check(
  "C4: the founding price is exactly half that base — PRO 599 → 2,995",
  annualFounding.final === 2_995,
  `final=${annualFounding.final}`,
);
check(
  "C5: monthly keeps its full price while the offer is open",
  monthlyFounding.final === monthly,
  `final=${monthlyFounding.final}`,
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
