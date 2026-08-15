import { Prisma, type Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { MONTHLY_GRANT } from "@/lib/credits";
import { minutesPerMonthForPlan } from "@/lib/plan-limits";
import { usageWindowForPlan } from "@/lib/usage-limits";

const DAY_MS = 24 * 60 * 60 * 1_000;

export type GrantCouponFailureCode =
  | "NOT_FOUND"
  | "NOT_GRANT"
  | "DISABLED"
  | "EXPIRED"
  | "FULL"
  | "ALREADY_REDEEMED"
  | "NO_BENEFIT";

export type GrantCouponRedemptionResult =
  | {
      ok: true;
      outcome: "ACTIVATED" | "SCHEDULED" | "PROMO_ONLY";
      effectivePlan: Plan;
      entitlementStartsAt: Date;
      entitlementExpiresAt: Date | null;
      minutesLimit: number;
      monthlyCredits: number;
      promoCredits: number;
      message: string;
    }
  | { ok: false; code: GrantCouponFailureCode; message: string };

export type RedeemGrantCouponInput = {
  userId: string;
  code: string;
  now?: Date;
};

class RedemptionAbort extends Error {
  constructor(
    readonly code: GrantCouponFailureCode,
    message: string,
  ) {
    super(message);
  }
}

function failureMessage(code: GrantCouponFailureCode): string {
  switch (code) {
    case "NOT_FOUND": return "รหัสคูปองไม่ถูกต้อง";
    case "NOT_GRANT": return "โค้ดส่วนลดนี้ใช้ที่หน้าราคาตอนชำระเงิน ไม่ใช่ช่องกรอกคูปองนี้";
    case "DISABLED": return "คูปองนี้ถูกปิดใช้งานแล้ว";
    case "EXPIRED": return "คูปองหมดอายุแล้ว";
    case "FULL": return "คูปองถูกใช้ครบจำนวนแล้ว";
    case "ALREADY_REDEEMED": return "คุณเคยใช้คูปองนี้แล้ว";
    case "NO_BENEFIT": return "บัญชีนี้ไม่มีสิทธิประโยชน์เพิ่มเติมจากคูปองนี้";
  }
}

function isPaidPlan(plan: Plan | string): plan is "PRO" | "BUSINESS" {
  return plan === "PRO" || plan === "BUSINESS";
}

async function grantPromotionalCredits(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    couponRedemptionId: string;
    amount: number;
    expiresAt: Date;
    now: Date;
  },
) {
  if (input.amount <= 0) return;
  await tx.promotionalCreditGrant.create({
    data: {
      userId: input.userId,
      couponRedemptionId: input.couponRedemptionId,
      initialAmount: input.amount,
      remainingAmount: input.amount,
      expiresAt: input.expiresAt,
      createdAt: input.now,
    },
  });
  const [balance, promo] = await Promise.all([
    tx.creditBalance.upsert({
      where: { userId: input.userId },
      create: { userId: input.userId },
      update: {},
    }),
    tx.promotionalCreditGrant.aggregate({
      where: { userId: input.userId, expiresAt: { gt: input.now } },
      _sum: { remainingAmount: true },
    }),
  ]);
  await tx.creditLedger.create({
    data: {
      userId: input.userId,
      delta: input.amount,
      kind: "promo-grant",
      action: `coupon-promo:${input.couponRedemptionId}`,
      balanceAfter: balance.granted + balance.purchased + (promo._sum.remainingAmount ?? 0),
      createdAt: input.now,
    },
  });
}

async function activateFreshPlan(
  tx: Prisma.TransactionClient,
  input: { userId: string; plan: Plan; expiresAt: Date | null; now: Date },
) {
  await tx.user.update({
    where: { id: input.userId },
    data: {
      plan: input.plan,
      planExpiresAt: input.expiresAt,
      trialEndsAt: null,
      ...usageWindowForPlan(input.plan, input.now),
    },
  });

  if (process.env.CREDITS_LIVE !== "1") return;
  const granted = MONTHLY_GRANT[input.plan] ?? 0;
  const prior = await tx.creditBalance.upsert({
    where: { userId: input.userId },
    create: { userId: input.userId },
    update: {},
  });
  const updated = await tx.creditBalance.update({
    where: { userId: input.userId },
    data: { granted, grantedResetAt: input.now },
  });
  const promotional = await tx.promotionalCreditGrant.aggregate({
    where: {
      userId: input.userId,
      expiresAt: { gt: input.now },
      remainingAmount: { gt: 0 },
    },
    _sum: { remainingAmount: true },
  });
  await tx.creditLedger.create({
    data: {
      userId: input.userId,
      delta: granted - prior.granted,
      kind: "monthly-reset",
      action: `coupon-activation:${input.now.toISOString()}`,
      balanceAfter: updated.granted + (promotional._sum.remainingAmount ?? 0) + updated.purchased,
    },
  });
}

/**
 * Redeem one GRANT coupon through the single commercial boundary. The seat,
 * redemption evidence, plan materialization, meters, and credit ledger commit
 * in one transaction; any failure rolls the whole operation back.
 */
export async function redeemGrantCoupon(
  input: RedeemGrantCouponInput,
  options: { preview?: boolean } = {},
): Promise<GrantCouponRedemptionResult> {
  const now = input.now ?? new Date();
  const code = input.code.trim().toUpperCase();
  try {
    return await prisma.$transaction(async (tx) => {
      const coupon = await tx.coupon.findUnique({ where: { code } });
      if (!coupon) throw new RedemptionAbort("NOT_FOUND", failureMessage("NOT_FOUND"));
      if (coupon.type !== "GRANT") throw new RedemptionAbort("NOT_GRANT", failureMessage("NOT_GRANT"));
      if (!coupon.isActive) throw new RedemptionAbort("DISABLED", failureMessage("DISABLED"));
      if (!isPaidPlan(coupon.plan)) throw new RedemptionAbort("NO_BENEFIT", failureMessage("NO_BENEFIT"));
      if (coupon.expiresAt && coupon.expiresAt < now) {
        throw new RedemptionAbort("EXPIRED", failureMessage("EXPIRED"));
      }
      const user = await tx.user.findUnique({
        where: { id: input.userId },
        include: {
          administratorGrants: {
            where: { revokedAt: null, startsAt: { lte: now } },
          },
          couponRedemptions: {
            include: { coupon: true },
          },
        },
      });
      if (!user) throw new RedemptionAbort("NOT_FOUND", "ไม่พบผู้ใช้");
      const existing = await tx.couponRedemption.findUnique({
        where: { couponId_userId: { couponId: coupon.id, userId: input.userId } },
      });
      if (existing) throw new RedemptionAbort("ALREADY_REDEEMED", failureMessage("ALREADY_REDEEMED"));

      const hasStripeSubscription = Boolean(user.stripeSubscriptionId);
      const activeTrial = Boolean(user.trialEndsAt && user.trialEndsAt > now);
      const legacyPermanentCoupon = user.couponRedemptions.some((redemption) =>
        redemption.outcome === "LEGACY"
        && redemption.coupon.type === "GRANT"
        && redemption.coupon.durationDays === 0
        && isPaidPlan(redemption.coupon.plan),
      );
      const activePermanentAdmin = user.administratorGrants.some((grant) =>
        grant.permanent && grant.expiresAt === null && isPaidPlan(grant.plan),
      );
      const activeTimedAdmin = user.administratorGrants.some((grant) =>
        !grant.permanent && Boolean(grant.expiresAt && grant.expiresAt > now) && isPaidPlan(grant.plan),
      );
      const labelBackedPermanent = isPaidPlan(user.plan)
        && !user.planExpiresAt
        && !user.trialEndsAt
        && user.bundleStatus !== "ACTIVE"
        && !activeTimedAdmin;
      const permanent = legacyPermanentCoupon || activePermanentAdmin || labelBackedPermanent;

      const futureEnds = [
        user.planExpiresAt,
        user.bundleStatus === "ACTIVE" ? user.bundleAccessExpiresAt : null,
        ...user.administratorGrants.map((grant) => grant.expiresAt),
        ...user.couponRedemptions.map((redemption) => {
          if (redemption.outcome !== "LEGACY") {
            return redemption.entitlementPlan ? redemption.entitlementExpiresAt : null;
          }
          if (redemption.coupon.type !== "GRANT" || redemption.coupon.durationDays <= 0) return null;
          return new Date(redemption.redeemedAt.getTime() + redemption.coupon.durationDays * DAY_MS);
        }),
      ].filter((value): value is Date => Boolean(value && value > now));
      const appendAfter = futureEnds.sort((left, right) => right.getTime() - left.getTime())[0] ?? null;

      const hasExistingEntitlement = hasStripeSubscription || activeTrial || permanent || Boolean(appendAfter);
      if (coupon.stackingPolicy === "REJECT_EXISTING" && hasExistingEntitlement) {
        throw new RedemptionAbort("NO_BENEFIT", failureMessage("NO_BENEFIT"));
      }

      let outcome: "ACTIVATED" | "SCHEDULED" | "PROMO_ONLY";
      let entitlementStartsAt = now;
      let entitlementExpiresAt: Date | null = null;
      let effectivePlan: Plan = coupon.plan;
      let promoCredits = 0;

      if (hasStripeSubscription || permanent) {
        if (coupon.promoCredits <= 0) {
          throw new RedemptionAbort("NO_BENEFIT", failureMessage("NO_BENEFIT"));
        }
        outcome = "PROMO_ONLY";
        effectivePlan = hasStripeSubscription
          ? user.plan
          : isPaidPlan(user.plan) ? user.plan : coupon.plan;
        promoCredits = coupon.promoCredits;
      } else if (!activeTrial && appendAfter) {
        outcome = "SCHEDULED";
        entitlementStartsAt = appendAfter;
        entitlementExpiresAt = coupon.durationDays > 0
          ? new Date(appendAfter.getTime() + coupon.durationDays * DAY_MS)
          : null;
        effectivePlan = isPaidPlan(user.plan) ? user.plan : coupon.plan;
        promoCredits = coupon.promoCredits;
      } else {
        outcome = "ACTIVATED";
        entitlementExpiresAt = coupon.durationDays > 0
          ? new Date(now.getTime() + coupon.durationDays * DAY_MS)
          : null;
      }

      const minutesLimit = minutesPerMonthForPlan(coupon.plan);
      const monthlyCredits = MONTHLY_GRANT[coupon.plan] ?? 0;
      const success: Extract<GrantCouponRedemptionResult, { ok: true }> = {
        ok: true,
        outcome,
        effectivePlan,
        entitlementStartsAt,
        entitlementExpiresAt,
        minutesLimit,
        monthlyCredits,
        promoCredits,
        message: outcome === "PROMO_ONLY"
          ? `รับ ${promoCredits} เครดิตโปรโมชันสำเร็จ โดยแพ็กเกจและการเรียกเก็บเงินไม่เปลี่ยนแปลง`
          : outcome === "SCHEDULED"
            ? `เพิ่ม ${coupon.plan} ${coupon.durationDays} วันต่อท้ายสิทธิ์เดิม และรับ ${promoCredits} เครดิตโปรโมชันแล้ว`
            : coupon.durationDays > 0
              ? `อัปเกรดเป็น ${coupon.plan} สำเร็จ! (${coupon.durationDays} วัน)`
              : `อัปเกรดเป็น ${coupon.plan} สำเร็จ! (ถาวร)`,
      };
      if (coupon.maxUses > 0 && coupon.usedCount >= coupon.maxUses) {
        throw new RedemptionAbort("FULL", failureMessage("FULL"));
      }
      if (options.preview) return success;

      const seat = await tx.coupon.updateMany({
        where: {
          id: coupon.id,
          ...(coupon.maxUses > 0 ? { usedCount: { lt: coupon.maxUses } } : {}),
        },
        data: { usedCount: { increment: 1 } },
      });
      if (seat.count !== 1) throw new RedemptionAbort("FULL", failureMessage("FULL"));

      const redemption = await tx.couponRedemption.create({
        data: {
          couponId: coupon.id,
          userId: input.userId,
          redeemedAt: now,
          outcome,
          entitlementPlan: outcome === "PROMO_ONLY" ? null : coupon.plan,
          entitlementStartsAt: outcome === "PROMO_ONLY" ? null : entitlementStartsAt,
          entitlementExpiresAt: outcome === "PROMO_ONLY" ? null : entitlementExpiresAt,
        },
      });
      if (outcome === "ACTIVATED") {
        await activateFreshPlan(tx, {
          userId: input.userId,
          plan: coupon.plan,
          expiresAt: entitlementExpiresAt,
          now,
        });
      }
      if (promoCredits > 0) {
        await grantPromotionalCredits(tx, {
          userId: input.userId,
          couponRedemptionId: redemption.id,
          amount: promoCredits,
          expiresAt: new Date(now.getTime() + coupon.promoCreditTtlDays * DAY_MS),
          now,
        });
      }

      return success;
    });
  } catch (error) {
    if (error instanceof RedemptionAbort) {
      return { ok: false, code: error.code, message: error.message };
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return {
        ok: false,
        code: "ALREADY_REDEEMED",
        message: failureMessage("ALREADY_REDEEMED"),
      };
    }
    throw error;
  }
}

export async function previewGrantCoupon(
  input: RedeemGrantCouponInput,
): Promise<GrantCouponRedemptionResult> {
  return redeemGrantCoupon(input, { preview: true });
}
