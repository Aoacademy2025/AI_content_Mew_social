import { computeDisplayPrice } from "@/lib/pricing-display";

export type FirstClipConvertDecision =
  | { show: false; reason: "internal" | "recurring_payer" | "no_completed_video" }
  | {
      show: true;
      monthlyPriceThb: number;
      annualListThb: number;
      founding: {
        active: true;
        remaining: number;
        percentOff: number;
        annualPriceThb: number;
      } | null;
    };

export function decideFirstClipConvertPrompt(input: {
  isInternal: boolean;
  isRecurringPayer: boolean;
  hasCompletedVideo: boolean;
  monthlyPriceThb: number;
  founding: { active: boolean; remaining: number; percentOff: number } | null;
}): FirstClipConvertDecision {
  if (input.isInternal) return { show: false, reason: "internal" };
  if (input.isRecurringPayer) return { show: false, reason: "recurring_payer" };
  if (!input.hasCompletedVideo) return { show: false, reason: "no_completed_video" };

  const annualListThb = computeDisplayPrice({
    monthlyPrice: input.monthlyPriceThb,
    period: "annual",
    coupon: null,
    founding: null,
  }).final;
  const foundingActive = Boolean(input.founding?.active && (input.founding.remaining ?? 0) > 0);
  const foundingPrice = foundingActive && input.founding
    ? computeDisplayPrice({
        monthlyPrice: input.monthlyPriceThb,
        period: "annual",
        coupon: null,
        founding: { active: true, percentOff: input.founding.percentOff },
      }).final
    : null;

  return {
    show: true,
    monthlyPriceThb: input.monthlyPriceThb,
    annualListThb,
    founding: foundingActive && input.founding && foundingPrice != null
      ? {
          active: true,
          remaining: input.founding.remaining,
          percentOff: input.founding.percentOff,
          annualPriceThb: foundingPrice,
        }
      : null,
  };
}
