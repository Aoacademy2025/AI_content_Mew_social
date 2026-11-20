import { bangkokCalendarDaysBetween } from "@/lib/day21-convert-reminder";

/**
 * HERO-34 — the first-clip nudge for a paying customer who has never started a job.
 *
 * 13 of the 23 customers who paid since Aug 2026 paid before completing a video, and
 * 3 of the 6 Dormant Payers on 2026-09-17 had never pressed "สร้าง" at all. A paying
 * customer with zero jobs is the next cancellation (monthly) or the renewal that will
 * not happen (annual), so one nudge goes out once the payment is three Bangkok days
 * old — and never again for that customer. The rule is deliberately "≥ 3 days" rather
 * than "exactly day 3" so the customers already sitting in this state on launch get it
 * on the first cron run; the copy therefore never says how long ago they paid.
 */
export const PAID_ACTIVATION_MIN_DAYS = 3;
export const PAID_ACTIVATION_LINK = "/video-editor?source=paid_activation_d3";

export type PaidActivationDecision =
  | { send: true }
  | { send: false; reason: "internal" | "suspended" | "has_job" | "too_early" | "no_cash_payment" };

export function paidActivationDecision(input: {
  isInternal: boolean;
  suspended: boolean;
  firstPaidAt: Date | null;
  hasAnyJob: boolean;
  now: Date;
}): PaidActivationDecision {
  if (input.isInternal) return { send: false, reason: "internal" };
  if (input.suspended) return { send: false, reason: "suspended" };
  if (!input.firstPaidAt) return { send: false, reason: "no_cash_payment" };
  if (input.hasAnyJob) return { send: false, reason: "has_job" };
  if (bangkokCalendarDaysBetween(input.firstPaidAt, input.now) < PAID_ACTIVATION_MIN_DAYS) return { send: false, reason: "too_early" };
  return { send: true };
}

export function paidActivationCopy(plan: string): { title: string; body: string; cta: string; emailSubject: string } {
  const tier = plan === "BUSINESS" ? "BUSINESS" : "PRO";
  return {
    title: "คลิปแรกของคุณยังรออยู่",
    body: `แผน ${tier} ของคุณพร้อมแล้ว แต่ยังไม่มีคลิปแรก — วางสคริปต์ 1 ชุด ระบบใส่เสียง ซับไทย และ B-roll ให้เอง ได้คลิปพร้อมโพสต์ใน 5 นาที`,
    cta: "เริ่มคลิปแรก",
    emailSubject: "คลิปแรกของคุณยังรออยู่ — เริ่มได้ใน 5 นาที",
  };
}

// ─── HERO-81 / HERO-102: Dormant payer classification & multi-stage re-activation ──

export const LAPSED_PAYER_MIN_IDLE_DAYS = 21;
export const LAPSED_PAYER_FOLLOWUP_IDLE_DAYS = 35;
export const PREVIEW_STALLED_MIN_DAYS = 3;

export const LAPSED_PAYER_LINK = "/video-editor?templateId=news-fast&source=lapsed_payer_d21";
export const LAPSED_PAYER_D35_LINK = "/video-editor?templateId=finance-clear&source=lapsed_payer_d35";
export const PREVIEW_STALLED_LINK = "/video-editor?source=preview_stalled_d3";

export type LapsedPayerStage = "d21" | "d35";

export type DormancyReason =
  | "never_created"
  | "preview_or_draft_30d"
  | "lapsed_creator";

export function classifyDormantPayer(input: {
  jobsEver: number;
  videosEver: number;
  previewsDone30d: number;
  projectsTouched30d: number;
}): DormancyReason {
  if (input.previewsDone30d > 0 || input.projectsTouched30d > 0) {
    return "preview_or_draft_30d";
  }
  if (input.jobsEver <= 0 && input.videosEver <= 0) {
    return "never_created";
  }
  return "lapsed_creator";
}

export type LapsedPayerDecision =
  | { send: true; stage: LapsedPayerStage; anchorDateKey: string; dedupeKeySuffix: string }
  | {
      send: false;
      reason:
        | "internal"
        | "suspended"
        | "not_active_payer"
        | "never_created"
        | "active_in_editor_30d"
        | "active_recently";
    };

export function lapsedPayerReminderDecision(input: {
  isInternal: boolean;
  suspended: boolean;
  isActivePayer: boolean;
  hasPriorActivity: boolean;
  lastActivityAt: Date | null;
  previewsDone30d: number;
  projectsTouched30d: number;
  now: Date;
  stage?: LapsedPayerStage;
}): LapsedPayerDecision {
  if (input.isInternal) return { send: false, reason: "internal" };
  if (input.suspended) return { send: false, reason: "suspended" };
  if (!input.isActivePayer) return { send: false, reason: "not_active_payer" };
  if (!input.hasPriorActivity || !input.lastActivityAt) {
    return { send: false, reason: "never_created" };
  }
  if (input.previewsDone30d > 0 || input.projectsTouched30d > 0) {
    return { send: false, reason: "active_in_editor_30d" };
  }
  const stage: LapsedPayerStage = input.stage ?? "d21";
  const minDays = stage === "d35" ? LAPSED_PAYER_FOLLOWUP_IDLE_DAYS : LAPSED_PAYER_MIN_IDLE_DAYS;
  if (bangkokCalendarDaysBetween(input.lastActivityAt, input.now) < minDays) {
    return { send: false, reason: "active_recently" };
  }
  const anchorDateKey = input.lastActivityAt.toISOString().slice(0, 10);
  return {
    send: true,
    stage,
    anchorDateKey,
    // Keep d21 key identical to HERO-81 so already-sent claims stay deduplicated.
    dedupeKeySuffix: stage === "d21" ? anchorDateKey : `${anchorDateKey}:d35`,
  };
}

export function lapsedPayerLink(stage: LapsedPayerStage = "d21"): string {
  return stage === "d35" ? LAPSED_PAYER_D35_LINK : LAPSED_PAYER_LINK;
}

export function lapsedPayerCopy(
  plan: string,
  stage: LapsedPayerStage = "d21",
): {
  title: string;
  body: string;
  cta: string;
  emailSubject: string;
} {
  const tier = plan === "BUSINESS" ? "BUSINESS" : "PRO";
  if (stage === "d35") {
    return {
      title: "ลองเทมเพลตคลิป 1 คลิก — โควตาแผนของคุณยังรอใช้งาน",
      body: `สิทธิ์แผน ${tier} ของคุณพร้อมใช้งานอยู่ตอนนี้ เลือกเทมเพลตสำเร็จรูป 1 คลิก แล้ววางสคริปต์สั้นๆ ระบบจัดเสียง ซับไทย และ B-roll ให้ครบจบใน 5 นาที`,
      cta: "ลองสร้างด้วยเทมเพลต 1 คลิก",
      emailSubject: `โควตาแผน ${tier} ของคุณยังรออยู่ — ลองเทมเพลต 1 คลิกใหม่`,
    };
  }
  return {
    title: "โควตาสร้างคลิปของคุณพร้อมสำหรับคลิปถัดไปแล้ว",
    body: `สิทธิ์แผน ${tier} ของคุณยังพร้อมใช้งานเต็มที่ — เปิดเทมเพลตสำเร็จรูป 1 คลิกแล้ววางสคริปต์ ระบบจัดเสียง ซับไทย และ B-roll ให้อัตโนมัติใน 5 นาที`,
    cta: "สร้างคลิปด้วยเทมเพลต 1 คลิก",
    emailSubject: `สิทธิ์แผน ${tier} ของคุณพร้อมอยู่ — มาสร้างคลิปถัดไปใน 5 นาที`,
  };
}

export type PreviewStalledDecision =
  | { send: true; anchorDateKey: string }
  | {
      send: false;
      reason:
        | "internal"
        | "suspended"
        | "not_active_payer"
        | "already_active_creator"
        | "no_pending_preview_or_draft"
        | "too_recent";
    };

/**
 * HERO-102: Dedicated finish-export nudge for paying customers who rendered a preview
 * or worked on a draft in the last 30 days, waited ≥3 Bangkok days, and still haven't
 * completed a Core Creation Outcome.
 */
export function previewStalledPayerDecision(input: {
  isInternal: boolean;
  suspended: boolean;
  isActivePayer: boolean;
  isActiveCreator30d: boolean;
  lastDraftOrPreviewAt: Date | null;
  now: Date;
}): PreviewStalledDecision {
  if (input.isInternal) return { send: false, reason: "internal" };
  if (input.suspended) return { send: false, reason: "suspended" };
  if (!input.isActivePayer) return { send: false, reason: "not_active_payer" };
  if (input.isActiveCreator30d) return { send: false, reason: "already_active_creator" };
  if (!input.lastDraftOrPreviewAt) return { send: false, reason: "no_pending_preview_or_draft" };
  if (bangkokCalendarDaysBetween(input.lastDraftOrPreviewAt, input.now) < PREVIEW_STALLED_MIN_DAYS) {
    return { send: false, reason: "too_recent" };
  }
  return {
    send: true,
    anchorDateKey: input.lastDraftOrPreviewAt.toISOString().slice(0, 10),
  };
}

export function previewStalledPayerCopy(plan: string): {
  title: string;
  body: string;
  cta: string;
  emailSubject: string;
} {
  const tier = plan === "BUSINESS" ? "BUSINESS" : "PRO";
  return {
    title: "โปรเจกต์คลิปของคุณยังรอส่งออกอยู่",
    body: `คุณเริ่มทำโปรเจกต์ในแผน ${tier} ค้างไว้แล้ว — กดกลับไปตรวจซับแล้วกด "ส่งออก" เพื่อรับไฟล์ MP4 พร้อมโพสต์ได้เลยใน 1 คลิก`,
    cta: "กลับไปส่งออกคลิป",
    emailSubject: "โปรเจกต์คลิปของคุณพร้อมส่งออกแล้ว — เสร็จใน 1 คลิก",
  };
}
