import { prisma } from "@/lib/prisma";
import { creditCostFor } from "@/lib/credits";

export type VideoJobBillingReceipt =
  | {
      status: "settled";
      funding: "minutes";
      renderMinutes: number;
      chargedMinutes: number;
      chargedCredits: 0;
    }
  | {
      status: "settled";
      funding: "credits";
      renderMinutes: number;
      chargedMinutes: 0;
      chargedCredits: number;
    }
  | {
      status: "settled";
      funding: "clips";
      renderMinutes: null;
      chargedMinutes: 0;
      chargedCredits: 0;
      chargedClips: 1;
    }
  | {
      status: "error";
      code: "missing_active_charge" | "multiple_active_charges";
      activeCharges: number;
    }
  | {
      status: "error";
      code: "active_charge_not_settled";
      activeCharges: 1;
    };

/**
 * Authoritative receipt for one VideoJob.
 *
 * A delivered video must retain exactly one reservation. Base/composite/burn are processing
 * stages, not separate products, so zero means under-billing and more than one means a double
 * charge. The persisted RenderJob reservation is the source of truth for both MCP status and
 * the release gate before a job may become done.
 */
export async function getVideoJobBillingReceipt(input: {
  videoJobId: string;
  userId: string;
}): Promise<VideoJobBillingReceipt> {
  const active = await prisma.renderJob.findMany({
    where: {
      parentJobId: input.videoJobId,
      userId: input.userId,
      reservedQuota: true,
    },
    select: {
      status: true,
      reservedMinutes: true,
      creditsSpent: true,
    },
    orderBy: { createdAt: "asc" },
  });

  if (active.length === 0) {
    return { status: "error", code: "missing_active_charge", activeCharges: 0 };
  }
  if (active.length > 1) {
    return { status: "error", code: "multiple_active_charges", activeCharges: active.length };
  }
  const charge = active[0];
  if (charge.status !== "DONE") {
    return { status: "error", code: "active_charge_not_settled", activeCharges: 1 };
  }

  if (charge.creditsSpent != null && charge.creditsSpent > 0) {
    return {
      status: "settled",
      funding: "credits",
      renderMinutes: Math.max(
        1,
        charge.reservedMinutes ?? Math.round(charge.creditsSpent / creditCostFor("minute")),
      ),
      chargedMinutes: 0,
      chargedCredits: charge.creditsSpent,
    };
  }
  if (charge.reservedMinutes != null) {
    return {
      status: "settled",
      funding: "minutes",
      renderMinutes: charge.reservedMinutes,
      chargedMinutes: charge.reservedMinutes,
      chargedCredits: 0,
    };
  }
  return {
    status: "settled",
    funding: "clips",
    renderMinutes: null,
    chargedMinutes: 0,
    chargedCredits: 0,
    chargedClips: 1,
  };
}
