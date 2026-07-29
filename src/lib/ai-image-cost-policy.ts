import { creditCostFor } from "@/lib/credit-costs";
import type { AiImageModelDefinition } from "@/lib/ai-image-policy";

/** Retail quote policy. One credit is ฿1; provider routes must fit inside this
 * COGS envelope before the customer can reserve credits. */
export const AI_IMAGE_QUOTE_VERSION = "ai-image-2026-07-29-v2";
export const DEFAULT_AI_IMAGE_USD_THB_RATE = 36;
export const DEFAULT_AI_IMAGE_MIN_GROSS_MARGIN_BPS = 3_000;

export type AiImageCostPolicy = {
  usdThbRate: number;
  minGrossMarginBps: number;
};

export type AiImageQuote = {
  version: string;
  credits: number;
  costBudgetUsdMicros: number;
  estimatedProviderCostUsdMicros: number;
};

export function imageProviderCostBudgetUsdMicros(
  credits: number,
  policy: AiImageCostPolicy = {
    usdThbRate: DEFAULT_AI_IMAGE_USD_THB_RATE,
    minGrossMarginBps: DEFAULT_AI_IMAGE_MIN_GROSS_MARGIN_BPS,
  },
): number {
  if (!Number.isFinite(credits) || credits <= 0) return 0;
  if (!Number.isFinite(policy.usdThbRate) || policy.usdThbRate <= 0) return 0;
  if (!Number.isInteger(policy.minGrossMarginBps)
    || policy.minGrossMarginBps < 0
    || policy.minGrossMarginBps >= 10_000) return 0;
  const retailUsd = credits / policy.usdThbRate;
  const cogsShare = (10_000 - policy.minGrossMarginBps) / 10_000;
  return Math.floor(retailUsd * cogsShare * 1_000_000);
}

export function quoteAiImageModel(
  model: AiImageModelDefinition,
  estimatedProviderCostUsdMicros: number,
  policy?: AiImageCostPolicy,
): AiImageQuote {
  const credits = creditCostFor(model.creditCostKey);
  return {
    version: AI_IMAGE_QUOTE_VERSION,
    credits,
    costBudgetUsdMicros: imageProviderCostBudgetUsdMicros(credits, policy),
    estimatedProviderCostUsdMicros,
  };
}

export function isAiImageQuoteCostSafe(quote: AiImageQuote): boolean {
  return Number.isInteger(quote.credits)
    && quote.credits > 0
    && Number.isInteger(quote.estimatedProviderCostUsdMicros)
    && quote.estimatedProviderCostUsdMicros >= 0
    && quote.estimatedProviderCostUsdMicros <= quote.costBudgetUsdMicros;
}
