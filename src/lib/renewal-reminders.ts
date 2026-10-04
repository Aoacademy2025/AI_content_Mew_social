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

export type RenewalKindDecision =
  | { send: true; kind: RenewalReminderKind }
  | { send: false; reason: "not_due" };

export function renewalReminderDecision(daysLeft: number): RenewalKindDecision {
  const kind = KIND_BY_DAYS[daysLeft];
  return kind ? { send: true, kind } : { send: false, reason: "not_due" };
}

/**
 * PromptPay monthly (ADR 0066): a 30-day cash term only ever gets the d3/d1
 * moments — d30/d14 this early would be false urgency for a term that short.
 * d3/d1 still fire for every cash-backed term, 30-day or annual.
 */
export function isThirtyDayRenewalTerm(periodDays: number): boolean {
  return periodDays < 300;
}

/**
 * Flag-on replacement for `renewalReminderDecision` once the caller knows the
 * matched payment's `periodDays`. Flag-off callers keep calling
 * `renewalReminderDecision` directly so behavior is untouched.
 */
export function selectRenewalKind(daysLeft: number, periodDays: number): RenewalKindDecision {
  const kind = KIND_BY_DAYS[daysLeft];
  if (!kind) return { send: false, reason: "not_due" };
  if ((kind === "d30" || kind === "d14") && isThirtyDayRenewalTerm(periodDays)) {
    return { send: false, reason: "not_due" };
  }
  return { send: true, kind };
}

export function renewalReminderLink(
  kind: RenewalReminderKind,
  plan: string,
  billingPeriod: string | null,
  /** ADR 0066: preselect PromptPay on the renewal link once the flag is on. */
  promptpayMonthly = false,
): string {
  const period = billingPeriod === "monthly" ? "monthly" : "annual";
  const planAnchor = plan === "BUSINESS" ? "business" : "pro";
  const methodParam = promptpayMonthly ? "&method=promptpay" : "";
  return `/pricing?source=renewal_${kind}&period=${period}${methodParam}#plan-${planAnchor}`;
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

function qualifyingCashPayments(candidate: RenewalTermCandidate): RenewalCashPayment[] {
  if (
    candidate.stripeSubscriptionId
    || !candidate.planExpiresAt
    || (candidate.plan !== "PRO" && candidate.plan !== "BUSINESS")
  ) return [];

  const expiresAt = candidate.planExpiresAt.getTime();
  return candidate.payments.filter((payment) => {
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

/**
 * Conservative current-term proof. A paid-looking plan label is insufficient: a
 * non-credit PAID payment must match the current plan and fall within the term it backs.
 */
export function isCashBackedRenewalTerm(candidate: RenewalTermCandidate): boolean {
  return qualifyingCashPayments(candidate).length > 0;
}

/**
 * The most recent qualifying cash payment backing the current term — used (ADR 0066)
 * to read the matched term's `periodDays` so a 30-day PromptPay term gets the right
 * reminder schedule and copy. Same predicate as `isCashBackedRenewalTerm`, so the two
 * never disagree on which candidates are cash-backed.
 */
export function matchedCashBackedPayment(candidate: RenewalTermCandidate): RenewalCashPayment | null {
  const qualifying = qualifyingCashPayments(candidate);
  if (qualifying.length === 0) return null;
  return qualifying.reduce((latest, payment) => {
    const latestAt = (latest.paidAt ?? latest.createdAt).getTime();
    const paidAt = (payment.paidAt ?? payment.createdAt).getTime();
    return paidAt > latestAt ? payment : latest;
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

/**
 * `periodDays` is passed only when the caller has resolved the matched cash payment
 * under the flag; omitting it (flag off, or no matched payment) keeps today's body.
 */
export function renewalReminderCopy(kind: RenewalReminderKind, plan: string, periodDays?: number) {
  const daysLeft = Number(kind.slice(1));
  const body = periodDays !== undefined && isThirtyDayRenewalTerm(periodDays)
    ? "ต่ออีก 30 วันด้วย PromptPay ก่อนหมด เพื่อสร้างและส่งออกงานต่อได้ไม่สะดุด"
    : "ต่ออายุก่อนหมดเพื่อสร้างและส่งออกงานต่อได้โดยไม่สะดุด";
  return {
    title: `แพ็ก ${plan} เหลือ ${daysLeft} วัน`,
    body,
  };
}
