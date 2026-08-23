import {
  TRIAL_MINUTES,
  durationCapSecFor,
  limitsForPlan,
  minutesPerMonthForPlan,
  storageDaysForPlan,
} from "@/lib/plan-limits";
import { HERO_AI_IMAGE_CREDITS } from "@/lib/credit-costs";

export type MarketingTierKey = "free" | "pro" | "business";

const PLAN_KEY = {
  free: "FREE",
  pro: "PRO",
  business: "BUSINESS",
} as const;

/**
 * Product capabilities that define what each plan unlocks. Keep this list in
 * code beside the enforced limits so the public sale page and signed-in
 * pricing page cannot silently lose newly-launched modules when SiteConfig
 * marketing copy is stale.
 */
export function canonicalPlanCapabilities(tier: MarketingTierKey): string[] {
  const limits = limitsForPlan(PLAN_KEY[tier]);

  if (tier === "free") {
    return [
      "ระบบจัดการ AI ให้ — ไม่ต้องใส่ Gemini key เอง",
      "ซับไทย + Stock B-roll อัตโนมัติ",
    ];
  }

  if (tier === "pro") {
    return [
      "ทุกอย่างใน Free — รวมระบบจัดการ AI, ซับไทย และ Stock B-roll",
      `Hero Script AI ไม่จำกัด · Brand Profiles สูงสุด ${limits.brandProfiles} แบรนด์`,
      "Brand Visual System · คุมแนวภาพให้เป็นภาษาของแบรนด์เดียวกัน",
      `Hero AI Image + AutoMix B-roll · ผสม Stock, ภาพถ่าย และภาพ AI อัตโนมัติ (ภาพ AI ${HERO_AI_IMAGE_CREDITS} เครดิต/ภาพ)`,
    ];
  }

  return [
    "ทุกอย่างใน Pro — รวม Hero Script, Brand Visual, Hero AI Image และ AutoMix",
    "Brand Profiles ไม่จำกัด สำหรับหลายแบรนด์/หลายลูกค้า",
  ];
}

/**
 * Facts in this block come from the same limits used by render admission and
 * media retention. Marketing copy may be edited in SiteConfig, but these
 * entitlement facts must never drift with free-form admin text.
 */
export function corePlanFacts(
  tier: MarketingTierKey,
  minuteQuotaEnabled: boolean,
): string[] {
  const plan = PLAN_KEY[tier];
  const limits = limitsForPlan(plan);
  const durationMinutes = durationCapSecFor(plan) / 60;
  const retentionDays = storageDaysForPlan(plan);
  const clipLimit = Number(limits.clips);
  const usage = minuteQuotaEnabled
    ? `${minutesPerMonthForPlan(plan)} นาทีเรนเดอร์ + สูงสุด ${clipLimit} คลิป/30 วัน`
    : `สูงสุด ${clipLimit} คลิป/30 วัน`;

  if (tier === "free") {
    return [
      minuteQuotaEnabled
        ? `ทดลอง Pro ฟรี 7 วัน · ${TRIAL_MINUTES} นาทีเรนเดอร์ช่วงทดลอง`
        : "ทดลอง Pro ฟรี 7 วัน",
      usage,
      `คลิปละไม่เกิน ${durationMinutes} นาที · เก็บวิดีโอ ${retentionDays} วัน`,
    ];
  }

  return [usage, `คลิปละไม่เกิน ${durationMinutes} นาที · เก็บวิดีโอ ${retentionDays} วัน`];
}

export function marketingPlanFeatures(
  tier: MarketingTierKey,
  minuteQuotaEnabled: boolean,
): string[] {
  return [
    ...canonicalPlanCapabilities(tier),
    ...corePlanFacts(tier, minuteQuotaEnabled),
  ];
}

const CORE_FACT_PATTERNS = [
  /^ทดลอง\s+PRO\b/iu,
  /^หลังทดลอง\s*:/u,
  /^ทุกอย่างใน\s+FREE\b/iu,
  /^ทุกอย่างใน\s+PRO\b/iu,
  /^ระบบจัดการ\s+AI\b/iu,
  /^Hero Script\b/iu,
  /^Brand Visual\b/iu,
  /^Brand Profiles\b/iu,
  /^Hero AI Image\b/iu,
  /^ซับไทย\s*\+\s*(?:Stock\s+)?B-roll\b/iu,
  /\d+\s*นาที\s*\/\s*เดือน/u,
  /~\s*\d+\s*คลิป/u,
  /(?:คลิป)?ยาวสุด\s*\d+\s*นาที/u,
];

/**
 * SiteConfig still owns descriptive benefits. Quotas/duration/retention are
 * stripped from that free-form copy and rendered from corePlanFacts instead.
 */
export function supplementalPlanFeatures(features: string[]): string[] {
  return features.flatMap((feature) => {
    if (CORE_FACT_PATTERNS.some((pattern) => pattern.test(feature))) return [];

    const withoutRetention = feature
      .replace(/(?:\s*[·+]\s*)?เก็บวิดีโอ\s*\d+\s*วัน/gu, "")
      .trim();
    return withoutRetention ? [withoutRetention] : [];
  });
}
