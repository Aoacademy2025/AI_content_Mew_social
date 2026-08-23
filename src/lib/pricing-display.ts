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
  /** Percent off applied (0 when none, or when the coupon is a fixed-amount type — pct: 0 does NOT imply that no coupon is present). */
  pct: number;
  /** True when the founding price (not a manual coupon) is what's applied. */
  isFounding: boolean;
}

export interface MarketingPriceBlock {
  amount: string;
  unit: string;
  sub: string;
  billingNote: string;
  was?: string;
}

export function computeDisplayPrice(input: DisplayPriceInput): DisplayPrice {
  const { monthlyPrice, period, coupon, founding } = input;
  // annual = 10 months billed (2 months free)
  const base = period === "annual" ? monthlyPrice * 10 : monthlyPrice;
  const foundingPct =
    !coupon && founding?.active && period === "annual" ? founding.percentOff : 0;
  const pct = coupon?.percentOff ?? foundingPct;
  const isFounding = !coupon && foundingPct > 0;
  const final = pct > 0 ? Math.round(base * (1 - pct / 100)) : base;
  return { base, final, pct, isFounding };
}

/** Human-readable pricing used on the public sales page. */
export function marketingPriceBlock({
  monthlyPrice,
  period,
  founding,
}: {
  monthlyPrice: number;
  period: "monthly" | "annual";
  founding: DisplayPriceInput["founding"];
}): MarketingPriceBlock {
  const display = computeDisplayPrice({ monthlyPrice, period, coupon: null, founding });
  if (period === "monthly") {
    return {
      amount: `฿${monthlyPrice.toLocaleString("th-TH")}`,
      unit: "/เดือน",
      sub: `ชำระ ฿${monthlyPrice.toLocaleString("th-TH")}/เดือน`,
      billingNote: "ชำระด้วยบัตร · ต่ออัตโนมัติและยกเลิกได้",
    };
  }

  const monthlyEquivalent = Math.round(display.final / 12);
  return {
    amount: `฿${monthlyEquivalent.toLocaleString("th-TH")}`,
    unit: "/เดือน",
    sub: display.isFounding
      ? `ชำระ ฿${display.final.toLocaleString("th-TH")}/ปี · Founding ลด ${display.pct}%`
      : `ชำระ ฿${display.final.toLocaleString("th-TH")}/ปี · ประหยัด 2 เดือน`,
    billingNote: "PromptPay จ่ายครั้งเดียว · บัตรต่ออัตโนมัติ",
    was: `฿${monthlyPrice.toLocaleString("th-TH")}`,
  };
}
