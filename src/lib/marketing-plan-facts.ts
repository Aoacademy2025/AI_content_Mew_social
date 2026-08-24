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
      "ระบบเตรียม AI ให้พร้อมใช้ — ไม่ต้องสมัครหรือใส่รหัสเชื่อมต่อ AI เอง",
      "ใส่ซับไทยและเลือกภาพประกอบจากคลังให้อัตโนมัติ",
    ];
  }

  if (tier === "pro") {
    return [
      "ทุกอย่างใน Free — รวม AI พร้อมใช้ ซับไทย และภาพประกอบอัตโนมัติ",
      `ช่วยคิดและเขียนสคริปต์ได้ไม่จำกัด · บันทึกข้อมูลแบรนด์ได้สูงสุด ${limits.brandProfiles} แบรนด์`,
      "คุมภาพทุกฉากให้ตรงกับแบรนด์ของคุณ",
      `สร้างและเลือกภาพประกอบให้อัตโนมัติ · ใช้ภาพจากคลัง ภาพถ่าย หรือภาพที่สร้างด้วย AI (ภาพ AI ${HERO_AI_IMAGE_CREDITS} เครดิต/ภาพ)`,
    ];
  }

  return [
    "ทุกอย่างใน Pro — รวมการเขียนสคริปต์ คุมภาพตามแบรนด์ สร้างภาพ และเลือกภาพประกอบอัตโนมัติ",
    "บันทึกข้อมูลแบรนด์ได้ไม่จำกัด สำหรับหลายแบรนด์หรือหลายลูกค้า",
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
    ? `${minutesPerMonthForPlan(plan)} นาทีสร้างคลิป + สูงสุด ${clipLimit} คลิป/30 วัน`
    : `สูงสุด ${clipLimit} คลิป/30 วัน`;

  if (tier === "free") {
    return [
      minuteQuotaEnabled
        ? `ทดลอง Pro ฟรี 7 วัน · สร้างคลิปได้รวม ${TRIAL_MINUTES} นาทีช่วงทดลอง`
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
  /^ระบบเตรียม\s+AI\b/iu,
  /^ใส่ซับไทยและเลือกภาพประกอบ/u,
  /^ช่วยคิดและเขียนสคริปต์/u,
  /^คุมภาพทุกฉาก/u,
  /^สร้างและเลือกภาพประกอบ/u,
  /^บันทึกข้อมูลแบรนด์/u,
  /\d+\s*นาที\s*\/\s*เดือน/u,
  /~\s*\d+\s*คลิป/u,
  /(?:คลิป)?ยาวสุด\s*\d+\s*นาที/u,
];

const PLAIN_LANGUAGE_REWRITES: Array<[RegExp, string]> = [
  [/^AI Avatar พิธีกร \(HeyGen\) — หรือทำ Faceless$/iu, "ใช้พิธีกร AI หรือทำคลิปแบบไม่ต้องออกกล้อง"],
  [/^เสียง AI ไทย \+ โคลนเสียงจาก ElevenLabs$/iu, "ใช้เสียงพากย์ AI ภาษาไทย หรือสร้างเสียงพากย์จากตัวอย่างเสียงของคุณ"],
  [/^ซับไทยตรงเสียงเป๊ะ \(ยาว\/keyword ไวรัล\) \+ B-roll ทุก 3–5 วิ \+ เพลง \+ SFX$/iu, "ใส่ซับไทยตรงเสียง เน้นคำสำคัญ พร้อมภาพและเสียงประกอบตลอดคลิป"],
  [/^อัปโหลดคลิปที่ถ่ายเอง → ใส่ซับ \+ B-roll cutaway อัตโนมัติ$/iu, "อัปโหลดคลิปที่ถ่ายเอง แล้วให้ระบบใส่ซับและแทรกภาพประกอบให้อัตโนมัติ"],
  [/^ตัดต่อบนไทม์ไลน์ \+ แต่งซับ 17 สไตล์ \+ ลบพื้นหลัง$/iu, "ปรับจังหวะบนหน้าตัดต่อ เลือกซับ 17 รูปแบบ และลบพื้นหลัง"],
  [/^สั่งสร้างผ่านแชท AI \(MCP\).*$/iu, "สั่งสร้างงานผ่านผู้ช่วย AI ที่คุณใช้อยู่ เช่น Claude หรือ Codex"],
  [/^Priority Support ตอบไวกว่า$/iu, "บริการช่วยเหลือแบบเร่งด่วน"],
];

export function plainLanguagePlanFeature(feature: string): string {
  for (const [pattern, replacement] of PLAIN_LANGUAGE_REWRITES) {
    if (pattern.test(feature)) return replacement;
  }
  return feature;
}

/**
 * SiteConfig still owns descriptive benefits. Quotas/duration/retention are
 * stripped from that free-form copy and rendered from corePlanFacts instead.
 */
export function supplementalPlanFeatures(features: string[]): string[] {
  return features.flatMap((feature) => {
    if (CORE_FACT_PATTERNS.some((pattern) => pattern.test(feature))) return [];

    const withoutRetention = plainLanguagePlanFeature(feature)
      .replace(/(?:\s*[·+]\s*)?เก็บวิดีโอ\s*\d+\s*วัน/gu, "")
      .trim();
    return withoutRetention ? [withoutRetention] : [];
  });
}
