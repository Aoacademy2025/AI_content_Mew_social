import type { Prisma, RenderJob } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { canonicalRenderUrl } from "@/lib/clip-charge";
import { refundSettledVideoImageBatch } from "@/lib/video-image-batch-settlement";
import { refundReservationInTransaction } from "@/lib/minute-credits";

export type RenderReservationRefundResult =
  | {
      kind: "refunded";
      renderJobId: string;
      funding: "minutes" | "credits" | "clips";
      amount: number;
    }
  | { kind: "already_settled"; renderJobId: string }
  | { kind: "in_flight"; renderJobId: string }
  | { kind: "not_found" }
  | { kind: "ambiguous" };

export type VideoRenderReservationsRefundResult =
  | {
      kind: "settled";
      candidateJobs: number;
      refundedJobs: number;
    }
  | {
      kind: "in_flight";
      candidateJobs: number;
      refundedJobs: number;
      inFlightJobs: number;
    };

export function summarizeRenderReservationFunding(job: {
  reservedMinutes: number | null;
  creditsSpent: number | null;
}): { funding: "minutes" | "credits" | "clips"; amount: number } {
  if (job.creditsSpent != null && job.creditsSpent > 0) {
    return { funding: "credits", amount: job.creditsSpent };
  }
  if (job.reservedMinutes != null) {
    return { funding: "minutes", amount: Math.max(0, job.reservedMinutes) };
  }
  return { funding: "clips", amount: 1 };
}

function fundingLink(inputJson: string): { mcpRootJobId?: unknown; sourceJobId?: unknown } {
  try { return JSON.parse(inputJson) ?? {}; } catch { return {}; }
}

/** The successful refund and its mirror commit together. Cleared historical flags
 * alone never prove a refund: call this only after returning this exact reservation. */
async function settleFundingMirror(tx: Prisma.TransactionClient, render: RenderJob) {
  if (!render.parentJobId) return;
  const parent = await tx.videoJob.findFirst({ where: { id: render.parentJobId, userId: render.userId } });
  if (!parent) return;
  const quote = parent.budgetQuoteId
    ? await tx.mcpVideoQuote.findFirst({ where: { id: parent.budgetQuoteId, userId: render.userId, status: "consumed" } }) : null;
  const link = fundingLink(parent.inputJson);
  const rootId = quote?.rootJobId ?? link.mcpRootJobId ??
    (parent.idempotencyKey === `mcp-chain:${link.sourceJobId}` ? link.sourceJobId : null);
  const linked = typeof rootId === "string"
    ? await tx.videoJob.findFirst({ where: { id: rootId, userId: render.userId } }) : null;
  const root = linked && (quote || parent.idempotencyKey === `mcp-chain:${linked.id}` ||
    (parent.projectId && parent.projectId === linked.projectId)) ? linked : parent;
  if (!["transferred", "settled"].includes(root.fundingState)) return;
  // A partial or mismatched reservation cannot certify that the entire mirror was
  // returned. Keep that case exposed for reconciliation rather than guess.
  if (root.fundedMeteredMinutes !== render.reservedMinutes ||
    (root.fundedCreditsSpent ?? 0) !== (render.creditsSpent ?? 0)) return;
  const candidates = await tx.videoJob.findMany({ where: { userId: render.userId, OR: [
    { id: root.id },
    ...(root.budgetQuoteId ? [{ budgetQuoteId: root.budgetQuoteId }] : []),
    ...(root.projectId ? [{ projectId: root.projectId }] : []),
    { idempotencyKey: `mcp-chain:${root.id}` },
  ] }, select: { id: true, inputJson: true, projectId: true, budgetQuoteId: true, idempotencyKey: true, type: true } });
  const chainIds = candidates.filter(job => {
    const data = fundingLink(job.inputJson);
    return job.id === root.id || (root.budgetQuoteId && job.budgetQuoteId === root.budgetQuoteId) ||
      (root.projectId && job.projectId === root.projectId && data.mcpRootJobId === root.id) ||
      (job.type === "export" && job.idempotencyKey === `mcp-chain:${root.id}` && data.sourceJobId === root.id);
  }).map(job => job.id);
  if (await tx.renderJob.count({ where: { userId: render.userId, parentJobId: { in: chainIds }, reservedQuota: true } })) return;
  await tx.videoJob.updateMany({ where: { id: root.id, userId: render.userId, fundingState: { in: ["transferred", "settled"] } }, data: { fundingState: "refunded" } });
}

async function settleRenderReservation(
  tx: Prisma.TransactionClient,
  job: RenderJob,
  input: { userId: string; reason: string },
): Promise<RenderReservationRefundResult> {
  if (!job.reservedQuota) {
    return { kind: "already_settled", renderJobId: job.id };
  }

  const claimed = await tx.renderJob.updateMany({
    where: { id: job.id, userId: input.userId, reservedQuota: true },
    data: {
      reservedQuota: false,
      reservedMinutes: null,
      creditsSpent: null,
      creditsFromGranted: null,
      creditsFromPromotional: null,
      creditFundingJson: null,
    },
  });
  if (claimed.count !== 1) {
    return { kind: "already_settled", renderJobId: job.id };
  }

  const summary = summarizeRenderReservationFunding(job);
  if (summary.funding === "clips") {
    await tx.user.updateMany({
      where: { id: input.userId, usageCount: { gt: 0 } },
      data: { usageCount: { decrement: 1 } },
    });
  } else {
    // Reuse the existing bucket-aware helper: mixed funding must restore both
    // included minutes and the exact credit buckets, not just its credit portion.
    await refundReservationInTransaction(tx, input.userId, job,
      `render-refund:${job.id}:${input.reason}`.slice(0, 300));
  }
  await settleFundingMirror(tx, job);

  const outputUrl = canonicalRenderUrl(job.videoUrl);
  if (outputUrl) {
    await tx.chargedClip.deleteMany({
      where: { userId: input.userId, outputUrl },
    });
  }

  return { kind: "refunded", renderJobId: job.id, ...summary };
}

/**
 * Reverse the one base-render charge owned by a VideoJob.
 *
 * The reservation guard, balance mutation, credit ledger entry, and ChargedClip removal
 * commit in one transaction. Calling this interface repeatedly therefore refunds at most once.
 */
export async function refundVideoJobBaseReservation(input: {
  videoJobId: string;
  userId: string;
  reason: string;
}): Promise<RenderReservationRefundResult> {
  return prisma.$transaction(async (tx) => {
    const candidates = await tx.renderJob.findMany({
      where: {
        parentJobId: input.videoJobId,
        userId: input.userId,
        type: "RENDER",
      },
      orderBy: { createdAt: "asc" },
      take: 2,
    });
    if (candidates.length === 0) return { kind: "not_found" as const };
    if (candidates.length !== 1) return { kind: "ambiguous" as const };
    if (!candidates[0].reservedQuota) {
      return { kind: "already_settled" as const, renderJobId: candidates[0].id };
    }
    if (candidates[0].status === "QUEUED" || candidates[0].status === "RUNNING") {
      return { kind: "in_flight" as const, renderJobId: candidates[0].id };
    }
    return settleRenderReservation(tx, candidates[0], input);
  });
}

/**
 * Settle every render reservation owned by a terminal VideoJob. This differs
 * from refundVideoJobBaseReservation: an avatar video can transfer the single
 * charge from its base RENDER job to its later BURN job.
 */
export async function refundVideoJobTerminalRenderReservations(input: {
  videoJobId: string;
  userId: string;
  reason: string;
}): Promise<VideoRenderReservationsRefundResult> {
  return prisma.$transaction(async (tx) => {
    const jobs = await tx.renderJob.findMany({
      where: {
        parentJobId: input.videoJobId,
        userId: input.userId,
      },
      orderBy: { createdAt: "asc" },
    });
    let refundedJobs = 0;
    let inFlightJobs = 0;
    for (const job of jobs) {
      if (!job.reservedQuota) continue;
      if (job.status === "QUEUED" || job.status === "RUNNING") {
        inFlightJobs += 1;
        continue;
      }
      const result = await settleRenderReservation(tx, job, input);
      if (result.kind === "refunded") refundedJobs += 1;
    }
    return inFlightJobs > 0
      ? {
          kind: "in_flight" as const,
          candidateJobs: jobs.length,
          refundedJobs,
          inFlightJobs,
        }
      : {
          kind: "settled" as const,
          candidateJobs: jobs.length,
          refundedJobs,
        };
  });
}

/**
 * Operator-only seam for legacy rows created before RenderJob.parentJobId was wired.
 * Ownership/type/status checks and the same reservation guard still apply.
 */
export async function refundRenderReservationById(input: {
  renderJobId: string;
  userId: string;
  reason: string;
}): Promise<RenderReservationRefundResult> {
  return prisma.$transaction(async (tx) => {
    const job = await tx.renderJob.findFirst({
      where: {
        id: input.renderJobId,
        userId: input.userId,
        type: "RENDER",
        status: "DONE",
      },
    });
    if (!job) return { kind: "not_found" as const };
    return settleRenderReservation(tx, job, input);
  });
}

/** Retry durable failed-job refund markers without replaying any render/provider work. */
export async function retryPendingVideoJobReservationRefunds(
  opts: { limit?: number } = {},
): Promise<{ inspected: number; settled: number; pending: number }> {
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 20)));
  const terminalStatuses = ["failed", "canceled"] as const;
  const jobs = await prisma.videoJob.findMany({
    where: { status: { in: [...terminalStatuses] }, reservationRefundPending: true },
    select: {
      id: true,
      userId: true,
      currentStep: true,
      reservationRefundReason: true,
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
  let settled = 0;

  for (const job of jobs) {
    try {
      const reason = job.reservationRefundReason ?? "pending-video-failure-refund";
      const imageSettlement = await refundSettledVideoImageBatch({
        userId: job.userId,
        videoJobId: job.id,
        reason,
      });
      const expectsRenderReservation = ["render", "avatar", "composite_queue", "composite", "burn"]
        .includes(job.currentStep ?? "");
      const result = expectsRenderReservation
        ? await refundVideoJobTerminalRenderReservations({
            videoJobId: job.id,
            userId: job.userId,
            reason,
          })
        : { kind: "settled" as const, candidateJobs: 0, refundedJobs: 0 };
      const done = result.kind === "settled" && imageSettlement.pendingJobs === 0;
      await prisma.videoJob.updateMany({
        where: {
          id: job.id,
          status: { in: [...terminalStatuses] },
          reservationRefundPending: true,
        },
        data: done
          ? {
              reservationRefundPending: false,
              reservationRefundReason: null,
              reservationRefundAttempts: { increment: 1 },
            }
          : { reservationRefundAttempts: { increment: 1 } },
      });
      if (done) settled++;
    } catch {
      await prisma.videoJob.updateMany({
        where: {
          id: job.id,
          status: { in: [...terminalStatuses] },
          reservationRefundPending: true,
        },
        data: { reservationRefundAttempts: { increment: 1 } },
      }).catch(() => {});
    }
  }

  return { inspected: jobs.length, settled, pending: jobs.length - settled };
}
