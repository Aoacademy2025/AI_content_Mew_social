const DAY_MS = 24 * 60 * 60 * 1_000;
const TERM_START_TOLERANCE_MS = 7 * DAY_MS;

export const RENEWAL_REMINDER_KINDS = ["d30", "d14", "d3", "d1"] as const;
export type RenewalReminderKind = typeof RENEWAL_REMINDER_KINDS[number];

const KIND_BY_DAYS: Readonly<Record<number, RenewalReminderKind>> = {
  30: "d30",
  14: "d14",
  3: "d3",
  1: "d1",
};

export function renewalReminderDecision(daysLeft: number):
  | { send: true; kind: RenewalReminderKind }
  | { send: false; reason: "not_due" } {
  const kind = KIND_BY_DAYS[daysLeft];
  return kind ? { send: true, kind } : { send: false, reason: "not_due" };
}

export function renewalReminderLink(
  kind: RenewalReminderKind,
  plan: string,
  billingPeriod: string | null,
): string {
  const period = billingPeriod === "monthly" ? "monthly" : "annual";
  const planAnchor = plan === "BUSINESS" ? "business" : "pro";
  return `/pricing?source=renewal_${kind}&period=${period}#plan-${planAnchor}`;
}

export type RenewalCashPayment = {
  plan: string;
  amount: number;
  periodDays: number;
  note: string | null;
  paidAt: Date | null;
  createdAt: Date;
};

export type RenewalTermCandidate = {
  plan: string;
  planExpiresAt: Date | null;
  stripeSubscriptionId: string | null;
  payments: readonly RenewalCashPayment[];
};

/**
 * Conservative current-term proof. A paid-looking plan label is insufficient: a
 * non-credit PAID payment must match the current plan and fall within the term it backs.
 */
export function isCashBackedRenewalTerm(candidate: RenewalTermCandidate): boolean {
  if (
    candidate.stripeSubscriptionId
    || !candidate.planExpiresAt
    || (candidate.plan !== "PRO" && candidate.plan !== "BUSINESS")
  ) return false;

  const expiresAt = candidate.planExpiresAt.getTime();
  return candidate.payments.some((payment) => {
    if (
      payment.plan !== candidate.plan
      || payment.amount <= 0
      || payment.periodDays <= 0
      || payment.note?.trim().toLowerCase() === "credits"
    ) return false;
    const paidAt = (payment.paidAt ?? payment.createdAt).getTime();
    const expectedTermStart = expiresAt - payment.periodDays * DAY_MS;
    return paidAt >= expectedTermStart - TERM_START_TOLERANCE_MS && paidAt <= expiresAt;
  });
}

export type RenewalDeliveryState = {
  notificationDelivered: boolean;
  emailAttempted: boolean;
  emailDelivered: boolean;
};

export type RenewalDeliveryStatus = "DELIVERED" | "PARTIAL" | "FAILED";

export function renewalDeliveryStatus(state: RenewalDeliveryState): RenewalDeliveryStatus {
  if (state.notificationDelivered && (!state.emailAttempted || state.emailDelivered)) return "DELIVERED";
  if (state.notificationDelivered || state.emailDelivered) return "PARTIAL";
  return "FAILED";
}

export function renewalReminderCopy(kind: RenewalReminderKind, plan: string) {
  const daysLeft = Number(kind.slice(1));
  return {
    title: `แพ็ก ${plan} เหลือ ${daysLeft} วัน`,
    body: "ต่ออายุก่อนหมดเพื่อสร้างและส่งออกงานต่อได้โดยไม่สะดุด",
  };
}
