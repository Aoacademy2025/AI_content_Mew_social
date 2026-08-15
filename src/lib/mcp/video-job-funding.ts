import { prisma } from "@/lib/prisma";
import {
  creditCostFor,
  parseCreditFunding,
  serializeCreditFunding,
  type CreditDebit,
  type CreditFunding,
} from "@/lib/credits";
import { refundReservationInTransaction } from "@/lib/minute-credits";
import { resolveServiceVideoJobId } from "@/lib/mcp/service-actor";

export type WalletFundingAccess =
  | {
      allowed: true;
      videoJobId: string;
      meteredMinutes: number;
      creditsSpent: number;
    }
  | { allowed: false };

/**
 * A paid wallet balance is not an entitlement. Only a live reservation owned by
 * this user may let the internal pipeline cross the invisible FREE managed-AI
 * ceiling for work necessary to produce that one render.
 */
export async function walletFundingForVideoJob(
  videoJobId: string,
  userId: string,
): Promise<WalletFundingAccess> {
  const job = await prisma.videoJob.findFirst({
    where: { id: videoJobId, userId },
    select: {
      fundingState: true,
      fundedMeteredMinutes: true,
      fundedCreditsSpent: true,
      walletFundingAuthorized: true,
    },
  });
  if (
    !job
    || job.fundingState !== "reserved"
    || !(job.fundedMeteredMinutes && job.fundedMeteredMinutes > 0)
    || !job.walletFundingAuthorized
  ) {
    return { allowed: false };
  }
  return {
    allowed: true,
    videoJobId,
    meteredMinutes: job.fundedMeteredMinutes,
    creditsSpent: job.fundedCreditsSpent ?? 0,
  };
}

export async function walletFundingForCurrentRequest(
  userId: string,
): Promise<WalletFundingAccess> {
  const videoJobId = await resolveServiceVideoJobId(userId);
  if (!videoJobId) return { allowed: false };
  return walletFundingForVideoJob(videoJobId, userId);
}

export class VideoJobFundingConfirmationRequiredError extends Error {
  readonly code = "render_confirmation_required";

  constructor(
    public readonly confirmedMinutes: number,
    public readonly actualMinutes: number,
  ) {
    super(
      `ความยาวจริง ${actualMinutes} นาที มากกว่าที่ผู้ใช้ยืนยัน ${confirmedMinutes} นาที — กรุณายืนยันค่าใช้จ่ายใหม่`,
    );
    this.name = "VideoJobFundingConfirmationRequiredError";
  }
}

type FundingRow = {
  fundingState: string;
  fundedMeteredMinutes: number | null;
  fundedCreditsSpent: number | null;
  fundedCreditsFromGranted: number | null;
  fundedCreditsFromPromotional: number | null;
  fundedCreditFundingJson: string | null;
};

function fundingFromDebits(debits: CreditDebit[]): CreditFunding {
  const fromGranted = debits
    .filter((debit) => debit.bucket === "granted")
    .reduce((sum, debit) => sum + debit.amount, 0);
  const promotionalDebits = debits
    .filter((debit): debit is CreditDebit & { bucket: "promotional"; grantId: string } =>
      debit.bucket === "promotional" && Boolean(debit.grantId),
    )
    .map((debit) => ({ grantId: debit.grantId, amount: debit.amount }));
  const fromPromotional = promotionalDebits.reduce((sum, debit) => sum + debit.amount, 0);
  const fromPurchased = debits
    .filter((debit) => debit.bucket === "purchased")
    .reduce((sum, debit) => sum + debit.amount, 0);
  return { fromGranted, fromPromotional, promotionalDebits, fromPurchased, debits };
}

function splitFundingTail(funding: CreditFunding, refundAmount: number) {
  const retained = funding.debits.map((debit) => ({ ...debit }));
  const refunded: CreditDebit[] = [];
  let remaining = refundAmount;
  for (let index = retained.length - 1; index >= 0 && remaining > 0; index--) {
    const debit = retained[index];
    const amount = Math.min(debit.amount, remaining);
    remaining -= amount;
    debit.amount -= amount;
    refunded.unshift({ ...debit, amount });
    if (debit.amount === 0) retained.splice(index, 1);
  }
  if (remaining !== 0) throw new Error("video job funding snapshot is smaller than its credit total");
  return { retained: fundingFromDebits(retained), refunded: fundingFromDebits(refunded) };
}

function trimRefund(old: FundingRow, actualMinutes: number) {
  const rate = creditCostFor("minute");
  const oldTotal = Math.max(0, old.fundedMeteredMinutes ?? 0);
  const oldCredits = Math.max(0, old.fundedCreditsSpent ?? 0);
  if (rate <= 0 || oldCredits % rate !== 0) {
    throw new Error("video job has invalid render-credit reservation");
  }
  const oldCreditMinutes = oldCredits / rate;
  const oldIncludedMinutes = Math.max(0, oldTotal - oldCreditMinutes);
  const newIncludedMinutes = Math.min(actualMinutes, oldIncludedMinutes);
  const newCreditMinutes = Math.max(0, actualMinutes - newIncludedMinutes);
  const newCredits = newCreditMinutes * rate;

  const refundCredits = oldCredits - newCredits;
  const oldGranted = Math.max(0, Math.min(old.fundedCreditsFromGranted ?? 0, oldCredits));
  const funding = parseCreditFunding(old.fundedCreditFundingJson, {
    fromGranted: oldGranted,
    fromPromotional: old.fundedCreditsFromPromotional ?? 0,
    fromPurchased: oldCredits - oldGranted - (old.fundedCreditsFromPromotional ?? 0),
  }, oldCredits);
  const split = splitFundingTail(funding, refundCredits);
  const refundIncludedMinutes = oldIncludedMinutes - newIncludedMinutes;

  return {
    newCredits,
    retainedFunding: split.retained,
    refundFunding: split.refunded,
    refundCredits,
    refundMinutes: refundIncludedMinutes + (rate > 0 ? refundCredits / rate : 0),
  };
}

/** Reconcile the confirmed estimate to exact media duration before expensive
 * downstream work. A shorter output returns the unused tail. A longer output is
 * never silently charged: the whole reservation is restored and a fresh user
 * confirmation is required. */
export async function reconcileVideoJobFunding(
  videoJobId: string,
  userId: string,
  actualMeteredMinutes: number,
): Promise<void> {
  if (!Number.isInteger(actualMeteredMinutes) || actualMeteredMinutes <= 0) {
    throw new Error("actual metered minutes must be a positive integer");
  }

  const result = await prisma.$transaction(async (tx) => {
    const job = await tx.videoJob.findFirst({
      where: { id: videoJobId, userId },
      select: {
        fundingState: true,
        fundedMeteredMinutes: true,
        fundedCreditsSpent: true,
        fundedCreditsFromGranted: true,
        fundedCreditsFromPromotional: true,
        fundedCreditFundingJson: true,
      },
    });
    if (!job || job.fundingState !== "reserved" || !job.fundedMeteredMinutes) {
      return { kind: "noop" as const };
    }
    if (actualMeteredMinutes > job.fundedMeteredMinutes) {
      const claimed = await tx.videoJob.updateMany({
        where: { id: videoJobId, userId, fundingState: "reserved" },
        data: { fundingState: "refunded" },
      });
      if (claimed.count !== 1) return { kind: "noop" as const };
      await refundReservationInTransaction(
        tx,
        userId,
        {
          reservedMinutes: job.fundedMeteredMinutes,
          creditsSpent: job.fundedCreditsSpent,
          creditsFromGranted: job.fundedCreditsFromGranted,
          creditsFromPromotional: job.fundedCreditsFromPromotional,
          creditFundingJson: job.fundedCreditFundingJson,
        },
        `video-job-refund:${videoJobId}:duration-increase`,
      );
      return {
        kind: "confirmation" as const,
        confirmed: job.fundedMeteredMinutes,
      };
    }
    if (actualMeteredMinutes === job.fundedMeteredMinutes) return { kind: "same" as const };

    const refund = trimRefund(job, actualMeteredMinutes);
    if (refund.refundMinutes > 0 || refund.refundCredits > 0) {
      await refundReservationInTransaction(
        tx,
        userId,
        {
          reservedMinutes: refund.refundMinutes,
          creditsSpent: refund.refundCredits,
          creditsFromGranted: refund.refundFunding.fromGranted,
          creditsFromPromotional: refund.refundFunding.fromPromotional,
          creditFundingJson: serializeCreditFunding(refund.refundFunding),
        },
        `video-job-trim:${videoJobId}`,
      );
    }
    const [balance, promotional] = await Promise.all([
      tx.creditBalance.findUnique({ where: { userId } }),
      tx.promotionalCreditGrant.aggregate({
        where: {
          userId,
          expiresAt: { gt: new Date() },
          remainingAmount: { gt: 0 },
        },
        _sum: { remainingAmount: true },
      }),
    ]);
    await tx.videoJob.update({
      where: { id: videoJobId },
      data: {
        fundedMeteredMinutes: actualMeteredMinutes,
        fundedCreditsSpent: refund.newCredits,
        fundedCreditsFromGranted: refund.retainedFunding.fromGranted,
        fundedCreditsFromPromotional: refund.retainedFunding.fromPromotional,
        fundedCreditFundingJson: refund.newCredits > 0
          ? serializeCreditFunding(refund.retainedFunding)
          : null,
        fundedCreditBalanceAfter: balance
          ? balance.granted + (promotional._sum.remainingAmount ?? 0) + balance.purchased
          : null,
      },
    });
    return { kind: "trimmed" as const };
  });

  if (result.kind === "confirmation") {
    throw new VideoJobFundingConfirmationRequiredError(
      result.confirmed,
      actualMeteredMinutes,
    );
  }
}

export type TransferredVideoJobFunding =
  | {
      transferred: true;
      reservedMinutes: number;
      creditsSpent: number;
      creditsFromGranted: number;
      creditsFromPromotional: number;
      creditFundingJson: string | null;
      creditBalanceAfter: number | null;
    }
  | { transferred: false };

/** Move reservation ownership from VideoJob to the render route. From this point
 * the RenderJob/in-process render owns success/refund, preventing double-charge. */
export async function transferVideoJobFundingToRender(
  videoJobId: string,
  userId: string,
  actualMeteredMinutes: number,
): Promise<TransferredVideoJobFunding> {
  await reconcileVideoJobFunding(videoJobId, userId, actualMeteredMinutes);
  return prisma.$transaction(async (tx) => {
    const job = await tx.videoJob.findFirst({
      where: { id: videoJobId, userId, fundingState: "reserved" },
      select: {
        fundedMeteredMinutes: true,
        fundedCreditsSpent: true,
        fundedCreditsFromGranted: true,
        fundedCreditsFromPromotional: true,
        fundedCreditFundingJson: true,
        fundedCreditBalanceAfter: true,
      },
    });
    if (!job || job.fundedMeteredMinutes !== actualMeteredMinutes) {
      return { transferred: false };
    }
    const moved = await tx.videoJob.updateMany({
      where: { id: videoJobId, userId, fundingState: "reserved" },
      data: { fundingState: "transferred" },
    });
    if (moved.count !== 1) return { transferred: false };
    return {
      transferred: true,
      reservedMinutes: job.fundedMeteredMinutes,
      creditsSpent: job.fundedCreditsSpent ?? 0,
      creditsFromGranted: job.fundedCreditsFromGranted ?? 0,
      creditsFromPromotional: job.fundedCreditsFromPromotional ?? 0,
      creditFundingJson: job.fundedCreditFundingJson,
      creditBalanceAfter: job.fundedCreditBalanceAfter,
    };
  });
}

/** Restore a pre-render reservation exactly once. The state transition, minute
 * rollback, credit bucket restore, and refund ledger entry are one transaction. */
export async function refundVideoJobFunding(
  videoJobId: string,
  userId: string,
  reason: string,
): Promise<{ refunded: boolean }> {
  return prisma.$transaction(async (tx) => {
    const job = await tx.videoJob.findFirst({
      where: { id: videoJobId, userId },
      select: {
        fundingState: true,
        fundedMeteredMinutes: true,
        fundedCreditsSpent: true,
        fundedCreditsFromGranted: true,
        fundedCreditsFromPromotional: true,
        fundedCreditFundingJson: true,
      },
    });
    if (!job || job.fundingState !== "reserved") return { refunded: false };

    const claimed = await tx.videoJob.updateMany({
      where: { id: videoJobId, userId, fundingState: "reserved" },
      data: { fundingState: "refunded" },
    });
    if (claimed.count !== 1) return { refunded: false };

    await refundReservationInTransaction(
      tx,
      userId,
      {
        reservedMinutes: job.fundedMeteredMinutes,
        creditsSpent: job.fundedCreditsSpent,
        creditsFromGranted: job.fundedCreditsFromGranted,
        creditsFromPromotional: job.fundedCreditsFromPromotional,
        creditFundingJson: job.fundedCreditFundingJson,
      },
      `video-job-refund:${videoJobId}:${reason}`.slice(0, 240),
    );
    return { refunded: true };
  });
}

/** The render owner already restored the meters; mirror that terminal outcome on
 * the parent VideoJob without refunding twice. */
export async function markTransferredVideoJobFundingRefunded(
  videoJobId: string,
  userId: string,
): Promise<void> {
  await prisma.videoJob.updateMany({
    where: { id: videoJobId, userId, fundingState: "transferred" },
    data: { fundingState: "refunded" },
  });
}
