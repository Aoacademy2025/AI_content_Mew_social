export const FREE_LIMITS = {
  clips: 2,           // คลิป/เดือน
  durationSec: 120,   // สูงสุด 2 นาที/คลิป
  storageDays: 3,     // เก็บวิดีโอ 3 วัน
  styles: 2,
  contents: 5,
  images: Infinity,
  // ฟีเจอร์ที่ไม่รองรับ
  allowHeyGen: false,
  allowElevenLabs: false,
  allowBackgroundRemoval: false,
  allowMusic: false,
  allowAdvancedFonts: false,
  allowVideoEditor: false,
} as const;

export const PRO_LIMITS = {
  clips: 100,         // คลิป/เดือน
  durationSec: 360,   // สูงสุด 6 นาที/คลิป
  storageDays: 7,     // เก็บวิดีโอ 7 วัน
  styles: Infinity,
  contents: Infinity,
  images: Infinity,
  allowHeyGen: true,
  allowElevenLabs: true,
  allowBackgroundRemoval: true,
  allowMusic: true,
  allowAdvancedFonts: true,
  allowVideoEditor: true,
} as const;

export const BUSINESS_LIMITS = {
  clips: 300,         // คลิป/เดือน
  durationSec: 600,   // สูงสุด 10 นาที/คลิป
  storageDays: 14,    // เก็บวิดีโอ 14 วัน
  styles: Infinity,
  contents: Infinity,
  images: Infinity,
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

/** Video storage retention (days) per plan */
export function storageDaysForPlan(plan: string): number {
  return limitsForPlan(plan).storageDays;
}

/** Compute expiresAt date for a video based on user's plan */
export function videoExpiryFor(plan: string, from: Date = new Date()): Date {
  const days = storageDaysForPlan(plan);
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}
