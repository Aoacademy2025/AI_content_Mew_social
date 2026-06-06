// Pure pricing-display calculator shared by the /pricing page.
// Precedence rule (mirrors origin/main pricing page):
//   a manual coupon always wins; the Founding-100 price applies on ANNUAL only.

export interface DisplayPriceInput {
  /** Monthly list price for the plan (THB). */
  monthlyPrice: number;
  period: "monthly" | "annual";
  /** Applied manual coupon, or null. percentOff may be null for non-percent coupons. */
  coupon: { percentOff: number | null } | null;
  /** Founding-100 status, or null when unknown/unavailable. */
  founding: { active: boolean; percentOff: number } | null;
}

export interface DisplayPrice {
  /** Pre-discount price for the selected period (THB). */
  base: number;
  /** Final price after any discount (THB, rounded). */
  final: number;
  /** Percent off applied (0 when none). */
  pct: number;
  /** True when the founding price (not a manual coupon) is what's applied. */
  isFounding: boolean;
}

export function computeDisplayPrice(input: DisplayPriceInput): DisplayPrice {
  const { monthlyPrice, period, coupon, founding } = input;
  const base = period === "annual" ? monthlyPrice * 10 : monthlyPrice;
  const foundingPct =
    !coupon && founding?.active && period === "annual" ? founding.percentOff : 0;
  const pct = coupon?.percentOff ?? foundingPct;
  const isFounding = !coupon && foundingPct > 0;
  const final = pct > 0 ? Math.round(base * (1 - pct / 100)) : base;
  return { base, final, pct, isFounding };
}
