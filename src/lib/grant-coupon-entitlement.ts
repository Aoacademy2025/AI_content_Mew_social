import type { Plan } from "@prisma/client";
import { grantOnPaidActivation } from "@/lib/entitlements";
import { prisma } from "@/lib/prisma";
import { usageWindowForPlan } from "@/lib/usage-limits";

export type GrantCouponEntitlementInput = {
  userId: string;
  couponId: string;
  plan: Plan;
  planExpiresAt: Date | null;
  activatedAt: Date;
};

/**
 * Commit a GRANT coupon's durable plan entitlement, then apply the same paid-tier
 * monthly credit reset used by a subscription activation.
 *
 * The plan + redemption stay atomic. Credits live in their own audited transaction,
 * so a transient credit write must not turn an already-consumed coupon into a false
 * "redeem failed" response. Hero Image's lazy ensureMonthlyGrant remains the safety
 * net if this best-effort immediate reset ever fails.
 */
export async function activateGrantCouponEntitlement(
  input: GrantCouponEntitlementInput,
): Promise<void> {
  await prisma.$transaction([
    prisma.couponRedemption.create({
      data: { couponId: input.couponId, userId: input.userId },
    }),
    prisma.user.update({
      where: { id: input.userId },
      data: {
        plan: input.plan,
        planExpiresAt: input.planExpiresAt,
        trialEndsAt: null,
        ...usageWindowForPlan(input.plan, input.activatedAt),
      },
    }),
  ]);

  try {
    await grantOnPaidActivation(input.userId, input.plan);
  } catch (error) {
    console.error(
      "[coupon/redeem] plan activated but immediate monthly credit grant failed:",
      error,
    );
  }
}
