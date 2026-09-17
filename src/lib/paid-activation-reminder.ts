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
