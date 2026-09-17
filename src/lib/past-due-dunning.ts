import { bangkokCalendarDaysBetween } from "@/lib/day21-convert-reminder";

/**
 * HERO-33 — dunning for a subscription whose Stripe charge failed (`subStatus = past_due`).
 *
 * Two moments: `failed` right after `invoice.payment_failed`, and `d3` three Bangkok
 * calendar days later if the account is still past_due. Both channels (in-app
 * notification + email) say the same words so nothing drifts.
 *
 * Copy depends on whether the customer still holds the plan: a renewal failure
 * mid-cycle keeps PRO until `planExpiresAt`, but a Committed Trial whose first charge
 * failed has already dropped to FREE (its `planExpiresAt` was the trial end).
 */
export const PAST_DUE_REMINDER_KINDS = ["failed", "d3"] as const;
export type PastDueReminderKind = typeof PAST_DUE_REMINDER_KINDS[number];

export const PAST_DUE_FOLLOW_UP_DAYS = 3;

/** Where the customer fixes the card: Settings → Billing hosts the Stripe portal button. */
export const PAST_DUE_LINK = "/settings?tab=billing&source=past_due";

export function pastDueReminderCopy(input: {
  kind: PastDueReminderKind;
  plan: string;
  stillEntitled: boolean;
}): { title: string; body: string; cta: string } {
  const tier = input.plan === "BUSINESS" ? "BUSINESS" : "PRO";
  if (input.stillEntitled) {
    return {
      title: input.kind === "failed" ? "ชำระเงินไม่สำเร็จ" : "ยังเก็บเงินไม่ได้ — บัตรยังไม่ถูกอัปเดต",
      body: `บัตรของคุณถูกปฏิเสธตอนต่ออายุ ${tier} — อัปเดตวิธีชำระเงินเพื่อใช้งานต่อไม่สะดุด ระบบจะลองเก็บอีกครั้งอัตโนมัติ`,
      cta: "อัปเดตบัตร",
    };
  }
  return {
    title: input.kind === "failed" ? `เก็บเงินไม่สำเร็จ — สิทธิ์ ${tier} หยุดชั่วคราว` : `สิทธิ์ ${tier} ยังหยุดอยู่ — อัปเดตบัตรเพื่อกลับมาใช้`,
    body: `บัตรที่ผูกไว้ถูกปฏิเสธ บัญชีจึงกลับเป็น FREE ชั่วคราว — อัปเดตบัตรแล้วสิทธิ์ ${tier} จะกลับมาทันทีที่เก็บเงินสำเร็จ`,
    cta: `กลับมาใช้ ${tier}`,
  };
}

/** A past_due account still holds its tier while `planExpiresAt` is in the future. */
export function isStillEntitled(user: { plan: string; planExpiresAt: Date | null }, now: Date): boolean {
  return (user.plan === "PRO" || user.plan === "BUSINESS")
    && !!user.planExpiresAt
    && user.planExpiresAt.getTime() > now.getTime();
}

export type PastDueFollowUpDecision =
  | { send: true }
  | { send: false; reason: "not_past_due" | "too_early" };

/** The +3-day nudge fires once the failed claim is ≥ 3 Bangkok calendar days old and the account is still past_due. */
export function pastDueFollowUpDecision(input: {
  subStatus: string | null;
  failedAt: Date;
  now: Date;
}): PastDueFollowUpDecision {
  if (input.subStatus !== "past_due") return { send: false, reason: "not_past_due" };
  if (bangkokCalendarDaysBetween(input.failedAt, input.now) < PAST_DUE_FOLLOW_UP_DAYS) return { send: false, reason: "too_early" };
  return { send: true };
}

export function pastDueDeliveryStatus(input: {
  notificationDelivered: boolean;
  emailAttempted: boolean;
  emailDelivered: boolean;
}): "DELIVERED" | "PARTIAL" | "FAILED" {
  const emailOk = !input.emailAttempted || input.emailDelivered;
  if (input.notificationDelivered && emailOk) return "DELIVERED";
  if (input.notificationDelivered || input.emailDelivered) return "PARTIAL";
  return "FAILED";
}

export function pastDueFailureCode(input: {
  notificationDelivered: boolean;
  emailAttempted: boolean;
  emailDelivered: boolean;
}): string | null {
  if (!input.notificationDelivered && input.emailAttempted && !input.emailDelivered) return "notification_and_email_failed";
  if (!input.notificationDelivered) return "notification_failed";
  if (input.emailAttempted && !input.emailDelivered) return "email_failed";
  return null;
}
