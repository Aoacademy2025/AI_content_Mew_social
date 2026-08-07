import type { Plan, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { usageWindowForPlan } from "@/lib/usage-limits";

const DAY_MS = 24 * 60 * 60 * 1000;

export type PaidCheckoutActivationInput = {
  sessionId: string;
  userId: string;
  plan: string;
  billingPeriod: string | null | undefined;
  periodDays: number;
  mode: string | null | undefined;
  subscriptionId?: string | null;
  paymentIntentId?: string | null;
  amountTotal?: number | null;
  currency?: string | null;
};

export type PaidCheckoutActivationResult =
  | { activated: true; newExpiry: Date }
  | { activated: false; reason: "already_paid" };

function paidPlan(value: string): value is "PRO" | "BUSINESS" {
  return value === "PRO" || value === "BUSINESS";
}

function checkoutPeriod(value: string | null | undefined, periodDays: number): "monthly" | "annual" {
  if (value === "monthly" || value === "annual") return value;
  return periodDays >= 365 ? "annual" : "monthly";
}

/**
 * Commit the money-backed entitlement and its PAID Payment marker together.
 * The Payment upsert is intentional: a verified Stripe payment must never
 * leave the user with an active plan but no durable plan-payment row, because
 * paid feature gates and revenue reconciliation depend on that evidence.
 */
export async function activatePaidCheckout(
  input: PaidCheckoutActivationInput,
  now: Date = new Date(),
): Promise<PaidCheckoutActivationResult> {
  if (!input.sessionId || !input.userId) throw new Error("Paid checkout is missing its identity");
  if (!paidPlan(input.plan)) throw new Error(`Unsupported paid plan: ${input.plan}`);
  if (!Number.isInteger(input.periodDays) || input.periodDays <= 0 || input.periodDays > 3660) {
    throw new Error(`Invalid paid period: ${input.periodDays}`);
  }

  const billingPeriod = checkoutPeriod(input.billingPeriod, input.periodDays);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.payment.findUnique({
      where: { stripeSessionId: input.sessionId },
      select: { status: true },
    });
    if (existing?.status === "PAID") return { activated: false as const, reason: "already_paid" as const };

    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: { planExpiresAt: true, trialEndsAt: true, subStatus: true },
    });
    if (!user) throw new Error(`Paid checkout user not found: ${input.userId}`);

    // A converted trial starts its purchased term now. Renewals and one-time
    // extensions start from the later of now or the current paid expiry.
    const onUnconvertedTrial = !!user.trialEndsAt
      && user.trialEndsAt > now
      && user.subStatus !== "active";
    const base = !onUnconvertedTrial && user.planExpiresAt && user.planExpiresAt > now
      ? user.planExpiresAt
      : now;
    const newExpiry = new Date(base.getTime() + input.periodDays * DAY_MS);

    await tx.user.update({
      where: { id: input.userId },
      data: {
        plan: input.plan as Plan,
        planExpiresAt: newExpiry,
        ...usageWindowForPlan(input.plan, now),
        trialEndsAt: null,
        billingPeriod,
        ...(input.mode === "subscription" && input.subscriptionId
          ? { stripeSubscriptionId: input.subscriptionId, subStatus: "active" }
          : {}),
      },
    });

    const paymentData = {
      userId: input.userId,
      plan: input.plan as Plan,
      amount: Number.isInteger(input.amountTotal) && (input.amountTotal ?? 0) >= 0
        ? input.amountTotal ?? 0
        : 0,
      currency: input.currency?.toLowerCase() || "thb",
      status: "PAID" as const,
      periodDays: input.periodDays,
      stripePaymentIntent: input.paymentIntentId || null,
      paidAt: now,
    } satisfies Omit<Prisma.PaymentUncheckedCreateInput, "id" | "stripeSessionId">;

    await tx.payment.upsert({
      where: { stripeSessionId: input.sessionId },
      create: { stripeSessionId: input.sessionId, ...paymentData },
      update: {
        status: "PAID",
        stripePaymentIntent: input.paymentIntentId || undefined,
        paidAt: now,
      },
    });

    return { activated: true as const, newExpiry };
  });
}
