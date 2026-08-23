import {
  TRIAL_MINUTES,
  durationCapSecFor,
  limitsForPlan,
  minutesPerMonthForPlan,
  storageDaysForPlan,
} from "@/lib/plan-limits";

export type MarketingTierKey = "free" | "pro" | "business";

const PLAN_KEY = {
  free: "FREE",
  pro: "PRO",
  business: "BUSINESS",
} as const;

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

  return [
    ...(tier === "business" ? ["ทุกอย่างใน Pro"] : []),
    usage,
    `คลิปละไม่เกิน ${durationMinutes} นาที · เก็บวิดีโอ ${retentionDays} วัน`,
  ];
}

const CORE_FACT_PATTERNS = [
  /^ทดลอง\s+PRO\b/iu,
  /^หลังทดลอง\s*:/u,
  /^ทุกอย่างใน\s+PRO\b/iu,
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
