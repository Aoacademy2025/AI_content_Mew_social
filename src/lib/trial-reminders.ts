import { bangkokCalendarDaysBetween } from "@/lib/day21-convert-reminder";
import { FREE_LIMITS, storageDaysForPlan } from "@/lib/plan-limits";

/**
 * Trial lifecycle nudges (issue #299). Three moments, each sent at most once per
 * user. Pure module: every selection/copy rule lives here so the whole matrix is
 * verifiable without a database (scripts/verify-trial-reminders.ts).
 */
export const TRIAL_REMINDER_KINDS = ["d5", "expiry", "d3after"] as const;
export type TrialReminderKind = (typeof TRIAL_REMINDER_KINDS)[number];

/**
 * Calendar days from "today" to the trial's end date, in Asia/Bangkok (the cron
 * fires 10:00 ICT). Positive = the trial is still running.
 *   d5      →  2  two days left (day 5 of the public 7-day trial)
 *   expiry  →  0  the expiry day itself
 *   d3after → -3  three days after expiry
 */
export const TRIAL_REMINDER_OFFSET_DAYS: Record<TrialReminderKind, number> = {
  d5: 2,
  expiry: 0,
  d3after: -3,
};

/** `?source=` value carried into /pricing so conversion can be attributed per moment. */
export const TRIAL_REMINDER_SOURCE: Record<TrialReminderKind, string> = {
  d5: "trial_d5",
  expiry: "trial_expired",
  d3after: "trial_d3after",
};

/** Every acquisition source this feature emits — the /pricing client keys off this prefix. */
export const TRIAL_SOURCE_PREFIX = "trial_";

export function trialReminderLink(kind: TrialReminderKind): string {
  return `/pricing?source=${TRIAL_REMINDER_SOURCE[kind]}`;
}

export type TrialReminderSkipReason =
  | "internal"
  | "suspended"
  | "paid_equivalent"
  | "no_trial"
  | "outside_window"
  | "already_sent"
  | "no_completed_video";

export type TrialReminderDecision =
  | { send: true; kind: TrialReminderKind }
  | { send: false; reason: TrialReminderSkipReason };

export type TrialReminderInput = {
  isInternal: boolean;
  suspended: boolean;
  /** resolvePaidEquivalentEntitlement().canUsePaidFeatures — a paid/coupon/grant user is never nudged. */
  paidEquivalent: boolean;
  trialStartedAt: Date | null;
  /** Set while the trial is live; nulled by the revert. */
  trialEndsAt: Date | null;
  /** Preserved copy of trialEndsAt, written by the revert (see User.trialEndedAt). */
  trialEndedAt: Date | null;
  hasCompletedVideo: boolean;
  alreadySentKinds: readonly string[];
  now: Date;
};

/**
 * The trial's end instant, whether or not the expiry cron has already reverted the
 * user. trial-expiry runs 08:00 and clears trialEndsAt; trial-reminders runs 10:00,
 * so on the expiry day the date is only still readable through trialEndedAt.
 */
export function effectiveTrialEnd(user: {
  trialEndsAt: Date | null;
  trialEndedAt: Date | null;
}): Date | null {
  return user.trialEndsAt ?? user.trialEndedAt ?? null;
}

export function trialReminderKindFor(daysUntilEnd: number): TrialReminderKind | null {
  for (const kind of TRIAL_REMINDER_KINDS) {
    if (TRIAL_REMINDER_OFFSET_DAYS[kind] === daysUntilEnd) return kind;
  }
  return null;
}

export function decideTrialReminder(input: TrialReminderInput): TrialReminderDecision {
  if (input.isInternal) return { send: false, reason: "internal" };
  if (input.suspended) return { send: false, reason: "suspended" };
  // A converted trial is a customer, not a lead: never send it a lifecycle nudge.
  if (input.paidEquivalent) return { send: false, reason: "paid_equivalent" };
  if (!input.trialStartedAt) return { send: false, reason: "no_trial" };

  const endAt = effectiveTrialEnd(input);
  if (!endAt) return { send: false, reason: "no_trial" };

  const kind = trialReminderKindFor(bangkokCalendarDaysBetween(input.now, endAt));
  if (!kind) return { send: false, reason: "outside_window" };
  if (input.alreadySentKinds.includes(kind)) return { send: false, reason: "already_sent" };
  // "Your clips are gone" is only meaningful to someone who actually exported one.
  if (kind === "d3after" && !input.hasCompletedVideo) {
    return { send: false, reason: "no_completed_video" };
  }
  return { send: true, kind };
}

/**
 * Does this user's paid-looking plan come from the free trial? renewal-reminders
 * asks before sending "your PRO plan expires in N days — renew" (the trial writes
 * planExpiresAt = trialEndsAt, which used to drag trials into that cohort).
 */
export function isTrialSourcedPlan(input: {
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  paidEquivalent: boolean;
}): boolean {
  if (input.paidEquivalent) return false;
  return Boolean(input.trialStartedAt && input.trialEndsAt);
}

const FREE_STORAGE_DAYS = storageDaysForPlan("FREE");
const FREE_DURATION_MIN = Math.round(FREE_LIMITS.durationSec / 60);

/**
 * What Free actually allows, read straight from plan-limits so the copy cannot
 * drift from the enforced limits. The render allowance is a minute meter only when
 * MINUTE_QUOTA is on; otherwise clips/month is the live gate (same rule the
 * trial-expiry notification in entitlements.ts already follows).
 */
export function freeAllowanceLabel(minuteQuotaEnabled: boolean): string {
  return minuteQuotaEnabled
    ? `${FREE_LIMITS.minutesPerMonth} นาที/เดือน`
    : `${FREE_LIMITS.clips} คลิป/เดือน`;
}

export type TrialReminderCopy = {
  title: string;
  body: string;
  type: "LIMIT_WARNING" | "LIMIT_REACHED";
  link: string;
  emailSubject: string;
};

/**
 * Thai copy, no emoji. Every retention claim is the Free rule from plan-limits
 * ("เก็บคลิปให้ 3 วันต่อคลิป"), NOT "everything is deleted N days after the trial":
 * Video.expiresAt is stamped per clip at creation time and a downgrade never
 * shortens it, so a blanket deletion date would be untrue.
 */
export function trialReminderCopy(
  kind: TrialReminderKind,
  ctx: { clipCount: number; minuteQuotaEnabled: boolean },
): TrialReminderCopy {
  const link = trialReminderLink(kind);
  const retention = `บัญชี Free เก็บคลิปให้ ${FREE_STORAGE_DAYS} วันต่อคลิป คลิปที่หมดอายุจะดาวน์โหลดไม่ได้อีก`;

  if (kind === "d5") {
    return {
      title: "ทดลอง PRO เหลืออีก 2 วัน",
      body: ctx.clipCount > 0
        ? `ตอนนี้คุณมีคลิปในคลัง ${ctx.clipCount} ชิ้น · หลังหมดทดลองบัญชีจะกลับเป็น Free — ${retention} · สมัคร PRO ต่อได้ที่หน้าราคา`
        : `เหลืออีก 2 วันก่อนบัญชีจะกลับเป็น Free — ${retention} · ใช้เวลาที่เหลือทำคลิปให้เสร็จ หรือสมัคร PRO ต่อได้ที่หน้าราคา`,
      type: "LIMIT_WARNING",
      link,
      emailSubject: "ทดลอง PRO เหลืออีก 2 วัน",
    };
  }

  if (kind === "expiry") {
    return {
      title: "ทดลอง PRO หมดแล้ว",
      body: `บัญชีกลับเป็น Free แล้ว · ยังทำคลิปได้ ${freeAllowanceLabel(ctx.minuteQuotaEnabled)} คลิปละไม่เกิน ${FREE_DURATION_MIN} นาที และ${retention} · ปิดไว้: พิธีกร AI, เสียง ElevenLabs, เพลงประกอบ, ห้องตัดต่อวิดีโอ · สมัคร PRO เพื่อเปิดใช้อีกครั้ง`,
      type: "LIMIT_REACHED",
      link,
      emailSubject: "ทดลอง PRO หมดแล้ว — ยังทำคลิปต่อได้บนแผน Free",
    };
  }

  return {
    title: "หมดทดลองมา 3 วันแล้ว",
    body: `${retention} · สมัคร PRO เพื่อกลับมาทำคลิปต่อไม่สะดุด และเก็บคลิปได้นานขึ้น`,
    type: "LIMIT_WARNING",
    link,
    emailSubject: "คลิปในคลังกำลังหมดอายุ — กลับมาทำต่อได้ที่แผน PRO",
  };
}
