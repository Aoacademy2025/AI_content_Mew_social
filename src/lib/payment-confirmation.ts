import type { PaymentStatus, Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type PlanPaymentConfirmation = {
  confirmed: boolean;
  status: PaymentStatus;
  plan: Plan;
  paidAt: Date | null;
};

export function isStripeCheckoutSessionId(value: string): boolean {
  return value.startsWith("cs_") && value.length <= 255;
}

/**
 * Resolve a checkout result only from a plan-payment row owned by the caller.
 * Credit-pack purchases use periodDays=0 and must never confirm a plan upgrade.
 */
export async function findPlanPaymentConfirmation(
  userId: string,
  stripeSessionId: string,
): Promise<PlanPaymentConfirmation | null> {
  if (!userId || !isStripeCheckoutSessionId(stripeSessionId)) return null;

  const payment = await prisma.payment.findFirst({
    where: {
      userId,
      stripeSessionId,
      periodDays: { gt: 0 },
    },
    select: {
      status: true,
      plan: true,
      paidAt: true,
    },
  });

  if (!payment) return null;
  return {
    ...payment,
    confirmed: payment.status === "PAID",
  };
}
