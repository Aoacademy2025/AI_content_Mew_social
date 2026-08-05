export const FREE_LIMITS = {
  clips: 2,           // คลิป/เดือน
  durationSec: 120,   // สูงสุด 2 นาที/คลิป
  storageDays: 3,     // เก็บวิดีโอ 3 วัน
  minutesPerMonth: 5, // นาทีเรนเดอร์/เดือน
  styles: 2,
  contents: 5,
  images: Infinity,
  brandProfiles: 1,   // Hero Script — จำนวนโปรไฟล์แบรนด์/นิชที่เซฟได้
  scripts: 3,         // Hero Script — จำนวนสคริปต์ที่เขียนได้/30 วัน
  // ฟีเจอร์ที่ไม่รองรับ
  allowHeyGen: false,
  allowElevenLabs: false,
  allowBackgroundRemoval: false,
  allowMusic: false,
  allowAdvancedFonts: false,
  allowVideoEditor: false,
} as const;

/** Render-minute allowance while a user is in the time-limited PRO trial. */
export const TRIAL_MINUTES = 15;

export const PRO_LIMITS = {
  clips: 100,          // คลิป/เดือน
  durationSec: 360,    // สูงสุด 6 นาที/คลิป
  storageDays: 7,      // เก็บวิดีโอ 7 วัน
  minutesPerMonth: 80, // นาทีเรนเดอร์/เดือน
  styles: Infinity,
  contents: Infinity,
  images: Infinity,
  brandProfiles: 5,   // Hero Script — จำนวนโปรไฟล์แบรนด์/นิชที่เซฟได้
  scripts: Infinity,  // Hero Script — เขียนสคริปต์ได้ไม่จำกัด
  allowHeyGen: true,
  allowElevenLabs: true,
  allowBackgroundRemoval: true,
  allowMusic: true,
  allowAdvancedFonts: true,
  allowVideoEditor: true,
} as const;

export const BUSINESS_LIMITS = {
  clips: 300,           // คลิป/เดือน
  durationSec: 600,     // สูงสุด 10 นาที/คลิป
  storageDays: 14,      // เก็บวิดีโอ 14 วัน
  minutesPerMonth: 150, // นาทีเรนเดอร์/เดือน
  styles: Infinity,
  contents: Infinity,
  images: Infinity,
  brandProfiles: Infinity, // Hero Script — จำนวนโปรไฟล์แบรนด์/นิชที่เซฟได้
  scripts: Infinity,       // Hero Script — เขียนสคริปต์ได้ไม่จำกัด
  allowHeyGen: true,
  allowElevenLabs: true,
  allowBackgroundRemoval: true,
  allowMusic: true,
  allowAdvancedFonts: true,
  allowVideoEditor: true,
} as const;

export function isPaid(plan: string) {
  return plan === "PRO" || plan === "BUSINESS";
}

export function isFree(plan: string) {
  return plan === "FREE";
}

type PlanLimits = typeof FREE_LIMITS | typeof PRO_LIMITS | typeof BUSINESS_LIMITS;

/** Full limits object for the given plan */
export function limitsForPlan(plan: string): PlanLimits {
  if (plan === "BUSINESS") return BUSINESS_LIMITS;
  if (plan === "PRO") return PRO_LIMITS;
  return FREE_LIMITS;
}

/** Render-minutes allowance per 30-day window for the given plan */
export function minutesPerMonthForPlan(plan: string): number {
  return (limitsForPlan(plan) as { minutesPerMonth?: number }).minutesPerMonth ?? 5;
}

/** Video storage retention (days) per plan */
export function storageDaysForPlan(plan: string): number {
  return limitsForPlan(plan).storageDays;
}

/** Compute expiresAt date for a video based on user's plan */
export function videoExpiryFor(plan: string, from: Date = new Date()): Date {
  const days = storageDaysForPlan(plan);
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Human-readable plan label for UI/messages */
export const PLAN_LABEL: Record<string, string> = {
  FREE: "Free",
  PRO: "Pro",
  BUSINESS: "Business",
};

/** The next tier up from `plan`, or null if already at the top (BUSINESS). */
export function nextPlanFor(plan: string): "PRO" | "BUSINESS" | null {
  if (plan === "FREE") return "PRO";
  if (plan === "PRO") return "BUSINESS";
  return null;
}

/** Max clip length (seconds) for a plan — single source for duration gating. */
export function durationCapSecFor(plan: string): number {
  return limitsForPlan(plan).durationSec;
}

export interface AudioDurationLimitViolation {
  code: "duration_exceeded";
  message: string;
  userAction: string;
  plan: string;
  neededPlan: "PRO" | "BUSINESS" | null;
  durationSec: number;
  capSec: number;
}

/** Exact post-TTS duration gate shared by background pipelines and route backstops. */
export function audioDurationLimitViolation(
  audioDurationMs: number,
  plan: string,
): AudioDurationLimitViolation | null {
  if (!Number.isFinite(audioDurationMs) || audioDurationMs <= 0) return null;
  const durationSec = audioDurationMs / 1000;
  const capSec = durationCapSecFor(plan);
  if (durationSec <= capSec) return null;
  const neededPlan = nextPlanFor(plan);
  const planLabel = PLAN_LABEL[plan] ?? plan;
  return {
    code: "duration_exceeded",
    message: `คลิปยาว ${(durationSec / 60).toFixed(1)} นาที เกินเพดานแผน ${planLabel} (${capSec / 60} นาที/คลิป)`,
    userAction: neededPlan
      ? `อัปเกรดเป็น ${PLAN_LABEL[neededPlan]} (รองรับสูงสุด ${durationCapSecFor(neededPlan) / 60} นาที/คลิป) หรือตัดคลิปให้สั้นลง`
      : "ตัดคลิปให้สั้นลง",
    plan,
    neededPlan,
    durationSec,
    capSec,
  };
}
