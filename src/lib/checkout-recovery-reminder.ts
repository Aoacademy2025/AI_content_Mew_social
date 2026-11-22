import { isInternalGrantAccount } from "@/lib/grant-expiry-reminders";

/**
 * HERO-111 — bounded checkout recovery nudge for abandoned/failed paid checkouts
 * (Annual & Monthly). Pure decision + copy + link logic with zero DB imports so
 * both the cron worker and verification scripts share one source of truth.
 */
export const CHECKOUT_RECOVERY_MIN_AGE_HOURS = 2;
export const CHECKOUT_RECOVERY_MAX_AGE_DAYS = 7;
export const CHECKOUT_RECOVERY_USER_COOLDOWN_DAYS = 14;

export const CHECKOUT_RECOVERY_CLAIM_EVENT = "checkout_recovery_reminder_claim";
export const CHECKOUT_RECOVERY_DELIVERY_EVENT = "checkout_recovery_reminder_delivery";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export type CheckoutRecoveryPlan = "PRO" | "BUSINESS";
export type CheckoutRecoveryCycle = "annual" | "monthly";

export function isCheckoutRecoveryPlan(
  plan: string | null | undefined,
): plan is CheckoutRecoveryPlan {
  return plan === "PRO" || plan === "BUSINESS";
}

export function checkoutRecoveryCycle(periodDays: number): CheckoutRecoveryCycle {
  return periodDays >= 300 ? "annual" : "monthly";
}

export function checkoutRecoveryDedupeKey(paymentId: string): string {
  return `checkout_recovery:${paymentId}`;
}

export function checkoutRecoveryLink(
  plan: CheckoutRecoveryPlan,
  periodDays: number,
): string {
  const cycle = checkoutRecoveryCycle(periodDays);
  return `/pricing?source=checkout_recovery&plan=${plan}&cycle=${cycle}`;
}

export type CheckoutRecoverySkipReason =
  | "not_failed"
  | "invalid_amount"
  | "unsupported_plan"
  | "not_plan_checkout"
  | "too_recent"
  | "too_old"
  | "suspended"
  | "internal"
  | "active_subscription"
  | "later_paid"
  | "cooldown";

export type CheckoutRecoveryDecisionInput = {
  payment: {
    id: string;
    status: string;
    plan: string;
    amount: number;
    periodDays: number;
    note?: string | null;
    createdAt: Date;
  };
  user: {
    role: string;
    email: string | null;
    suspended: boolean;
    subStatus?: string | null;
    cancelAtPeriodEnd?: boolean;
  };
  hasSubsequentPaidPayment: boolean;
  lastRecoverySentAt: Date | null;
  now: Date;
};

export type CheckoutRecoveryDecision =
  | {
      send: true;
      plan: CheckoutRecoveryPlan;
      cycle: CheckoutRecoveryCycle;
      dedupeKey: string;
      link: string;
    }
  | {
      send: false;
      reason: CheckoutRecoverySkipReason;
    };

export function checkoutRecoveryDecision(
  input: CheckoutRecoveryDecisionInput,
): CheckoutRecoveryDecision {
  const { payment, user, now } = input;

  if (payment.status !== "FAILED") {
    return { send: false, reason: "not_failed" };
  }
  if (!Number.isFinite(payment.amount) || payment.amount <= 0) {
    return { send: false, reason: "invalid_amount" };
  }
  if (!isCheckoutRecoveryPlan(payment.plan)) {
    return { send: false, reason: "unsupported_plan" };
  }
  if (
    !Number.isFinite(payment.periodDays)
    || payment.periodDays <= 0
    || payment.note?.trim().toLowerCase() === "credits"
  ) {
    return { send: false, reason: "not_plan_checkout" };
  }

  const ageMs = now.getTime() - payment.createdAt.getTime();
  if (ageMs < CHECKOUT_RECOVERY_MIN_AGE_HOURS * HOUR_MS) {
    return { send: false, reason: "too_recent" };
  }
  if (ageMs > CHECKOUT_RECOVERY_MAX_AGE_DAYS * DAY_MS) {
    return { send: false, reason: "too_old" };
  }

  if (user.suspended) {
    return { send: false, reason: "suspended" };
  }
  if (isInternalGrantAccount({ role: user.role, email: user.email })) {
    return { send: false, reason: "internal" };
  }

  const hasActivePaidSub =
    (user.subStatus === "active" || user.subStatus === "trialing")
    && !user.cancelAtPeriodEnd;
  if (hasActivePaidSub) {
    return { send: false, reason: "active_subscription" };
  }

  if (input.hasSubsequentPaidPayment) {
    return { send: false, reason: "later_paid" };
  }

  if (
    input.lastRecoverySentAt
    && now.getTime() - input.lastRecoverySentAt.getTime()
      < CHECKOUT_RECOVERY_USER_COOLDOWN_DAYS * DAY_MS
  ) {
    return { send: false, reason: "cooldown" };
  }

  const cycle = checkoutRecoveryCycle(payment.periodDays);
  return {
    send: true,
    plan: payment.plan,
    cycle,
    dedupeKey: checkoutRecoveryDedupeKey(payment.id),
    link: checkoutRecoveryLink(payment.plan, payment.periodDays),
  };
}

export function checkoutRecoveryCopy(input: {
  plan: CheckoutRecoveryPlan;
  periodDays: number;
  amountSatang: number;
}): {
  cycle: CheckoutRecoveryCycle;
  cycleLabel: string;
  title: string;
  body: string;
  cta: string;
  emailSubject: string;
  link: string;
} {
  const cycle = checkoutRecoveryCycle(input.periodDays);
  const cycleLabel = cycle === "annual" ? "รายปี" : "รายเดือน";
  const tier: CheckoutRecoveryPlan = input.plan === "BUSINESS" ? "BUSINESS" : "PRO";
  const amountThb = Number.isFinite(input.amountSatang) && input.amountSatang > 0
    ? Math.round(input.amountSatang / 100)
    : 0;
  const priceText = amountThb > 0 ? ` (${amountThb.toLocaleString("en-US")} บาท)` : "";
  const link = checkoutRecoveryLink(tier, input.periodDays);

  return {
    cycle,
    cycleLabel,
    title: `รายการชำระเงินแพ็ก ${tier} ${cycleLabel} ยังไม่เสร็จสมบูรณ์`,
    body: `รายการสมัครแพ็ก ${tier} ${cycleLabel}${priceText} ของคุณยังไม่สมบูรณ์ หากต้องการเริ่มใช้งานสามารถกลับมาทำรายการใหม่ได้ใน 1 คลิก รองรับทั้ง PromptPay QR และบัตรเครดิต/เดบิต`,
    cta: "กลับไปชำระเงินต่อ",
    emailSubject: `รายการสมัครแพ็ก ${tier} ${cycleLabel} ยังไม่เสร็จสมบูรณ์ — กลับมาทำรายการต่อได้ใน 1 คลิก`,
    link,
  };
}

export type CheckoutRecoveryDeliveryStatus = "DELIVERED" | "PARTIAL" | "FAILED";

export function checkoutRecoveryDeliveryStatus(state: {
  notificationDelivered: boolean;
  emailAttempted: boolean;
  emailDelivered: boolean;
}): CheckoutRecoveryDeliveryStatus {
  const emailOk = !state.emailAttempted || state.emailDelivered;
  if (state.notificationDelivered && emailOk) return "DELIVERED";
  if (state.notificationDelivered || state.emailDelivered) return "PARTIAL";
  return "FAILED";
}
