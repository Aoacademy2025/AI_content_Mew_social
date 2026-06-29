import { prisma } from "@/lib/prisma";

// ── Cost-rate config ─────────────────────────────────────────────────────────
// Admin-editable via SiteConfig keys `cost_*` / `fx_baht_per_usd`.
// getCostRates() mirrors the getCfg() pattern in plan-config.ts:
//   prisma.siteConfig.findUnique → fallback on miss/throw.

export interface CostRates {
  /** ฿ per managed minute of TTS render */
  renderPerMinute: number;
  /** ฿ per GPT-Image-1 (standard) generation */
  imageGpt1k: number;
  /** ฿ per DALL-E-nano generation */
  imageNano1k: number;
  /** ฿ per GPT-Image-2 generation */
  imageGpt2k: number;
  /** ฿ per DALL-E-nano-2 generation */
  imageNano2k: number;
  /** ฿ per Seedance 5-second video clip */
  videoSeedance5s: number;
  /** ฿ fixed infra cost per calendar month */
  infraMonthly: number;
  /** ฿ per USD exchange rate (for cost-model USD→฿ conversions) */
  fxBahtPerUsd: number;
}

/** Default cost rates — used when the SiteConfig key is absent or unparseable. */
export const COST_DEFAULTS: CostRates = {
  renderPerMinute: 0.7,
  imageGpt1k: 1.05,
  imageNano1k: 1.4,
  imageGpt2k: 1.75,
  imageNano2k: 2.1,
  videoSeedance5s: 3.06,
  infraMonthly: 2600,
  fxBahtPerUsd: 35,
};

async function getCfg(key: string, fallback: number): Promise<number> {
  try {
    const row = await prisma.siteConfig.findUnique({ where: { key } });
    if (!row) return fallback;
    const parsed = parseFloat(row.value);
    return isNaN(parsed) ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** Reads cost rates from SiteConfig, falling back to COST_DEFAULTS on miss/error. */
export async function getCostRates(): Promise<CostRates> {
  const [
    renderPerMinute,
    imageGpt1k,
    imageNano1k,
    imageGpt2k,
    imageNano2k,
    videoSeedance5s,
    infraMonthly,
    fxBahtPerUsd,
  ] = await Promise.all([
    getCfg("cost_render_per_minute", COST_DEFAULTS.renderPerMinute),
    getCfg("cost_image_gpt_1k", COST_DEFAULTS.imageGpt1k),
    getCfg("cost_image_nano_1k", COST_DEFAULTS.imageNano1k),
    getCfg("cost_image_gpt_2k", COST_DEFAULTS.imageGpt2k),
    getCfg("cost_image_nano_2k", COST_DEFAULTS.imageNano2k),
    getCfg("cost_video_seedance_5s", COST_DEFAULTS.videoSeedance5s),
    getCfg("cost_infra_monthly", COST_DEFAULTS.infraMonthly),
    getCfg("fx_baht_per_usd", COST_DEFAULTS.fxBahtPerUsd),
  ]);

  return {
    renderPerMinute,
    imageGpt1k,
    imageNano1k,
    imageGpt2k,
    imageNano2k,
    videoSeedance5s,
    infraMonthly,
    fxBahtPerUsd,
  };
}

// ── Break-even constant ──────────────────────────────────────────────────────
/**
 * Number of active subscribers required to cover fixed infra costs.
 * Derivation: ≈ infraMonthly (฿2,600) ÷ blended contribution-margin-per-sub
 * (~฿190/sub after variable AI COGS), from the 2026-06-24 business-model spec.
 * Revisit if economics change (infra cost, pricing, or variable-cost rate).
 */
export const BREAK_EVEN_SUBS = 14;

// ── Pure calculation functions ───────────────────────────────────────────────

/**
 * Monthly Recurring Revenue.
 * @param active  Active subscriber counts per tier.
 * @param price   Monthly price (฿) per tier.
 */
export function computeMrr(
  active: { pro: number; business: number },
  price: { pro: number; business: number }
): number {
  return active.pro * price.pro + active.business * price.business;
}

export interface CogsInput {
  /** Total TTS-rendered minutes for the period. */
  managedMinutes: number;
  /** AI image generation counts by model tier. */
  imageCounts: {
    gpt1k: number;
    nano1k: number;
    gpt2k: number;
    nano2k: number;
  };
  /** Cost rates (from getCostRates or COST_DEFAULTS). */
  rates: CostRates;
}

export interface CogsResult {
  /** TTS render cost (฿) */
  tts: number;
  /** AI image generation cost (฿) */
  image: number;
  /** AI video generation cost (฿) — deferred, always 0 for now */
  video: number;
  /** tts + image + video */
  total: number;
}

/**
 * Variable Cost of Goods Sold for a reporting period.
 * All inputs are data — no DB access.
 */
export function computeCogs(input: CogsInput): CogsResult {
  const { managedMinutes, imageCounts, rates } = input;

  const tts = managedMinutes * rates.renderPerMinute;

  const image =
    imageCounts.gpt1k * rates.imageGpt1k +
    imageCounts.nano1k * rates.imageNano1k +
    imageCounts.gpt2k * rates.imageGpt2k +
    imageCounts.nano2k * rates.imageNano2k;

  const video = 0; // deferred

  return { tts, image, video, total: tts + image + video };
}

export interface MarginsInput {
  /** Total revenue (฿) for the period. */
  revenue: number;
  /** Variable COGS (฿) — from computeCogs().total. */
  variableCogs: number;
  /** Fixed infra cost (฿/month) — from getCostRates().infraMonthly. */
  infraMonthly: number;
  /** Length of reporting period in days (used to prorate infra). */
  periodDays: number;
}

export interface MarginsResult {
  /** revenue − variableCogs */
  grossProfit: number;
  /** grossProfit / revenue * 100  (0 when revenue = 0) */
  grossMarginPct: number;
  /** variableCogs / revenue * 100  (0 when revenue = 0) */
  aiCostPct: number;
  /** infraMonthly * (periodDays / 30) */
  infraProrated: number;
  /** grossProfit − infraProrated */
  netProfit: number;
}

/**
 * Gross and net margin calculations for a reporting period.
 * Guards divide-by-zero — never returns NaN.
 */
export function computeMargins(input: MarginsInput): MarginsResult {
  const { revenue, variableCogs, infraMonthly, periodDays } = input;

  const grossProfit = revenue - variableCogs;
  const grossMarginPct = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
  const aiCostPct = revenue > 0 ? (variableCogs / revenue) * 100 : 0;
  const infraProrated = infraMonthly * (periodDays / 30);
  const netProfit = grossProfit - infraProrated;

  return { grossProfit, grossMarginPct, aiCostPct, infraProrated, netProfit };
}
