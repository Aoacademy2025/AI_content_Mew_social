import "server-only";

import type { AiGenerationJob, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type DbTransaction = Prisma.TransactionClient;

export async function refreshBrandLookPreviewBatchInTransaction(
  tx: DbTransaction,
  batchId: string,
): Promise<void> {
  const items = await tx.brandLookPreviewItem.findMany({
    where: { batchId },
    select: { status: true },
  });
  if (items.length === 0) return;
  const completed = items.filter((item) => item.status === "completed").length;
  const terminal = items.every((item) => item.status === "completed" || item.status === "failed");
  const status = terminal
    ? completed === items.length ? "completed" : completed > 0 ? "partial" : "failed"
    : "in_progress";
  await tx.brandLookPreviewBatch.update({
    where: { id: batchId },
    data: {
      status,
      finishedAt: terminal ? new Date() : null,
    },
  });
}

function terminalItemState(job: AiGenerationJob, priorOutputUrl: string | null) {
  if (job.status === "completed" && job.outputUrl) {
    return {
      status: "completed",
      outputUrl: job.outputUrl,
      errorCode: null,
    };
  }
  if (job.status === "failed" || job.chargeState === "refunded") {
    return {
      status: priorOutputUrl ? "completed" : "failed",
      outputUrl: priorOutputUrl,
      errorCode: job.errorCode ?? "GENERATION_FAILED",
    };
  }
  return {
    status: "in_progress",
    outputUrl: priorOutputUrl,
    errorCode: null,
  };
}

/** Atomically attach a preview item to the same image reservation transaction.
 * expectedImageJobId is a compare-and-set guard: two different rerolls cannot
 * both charge and race to become the item's recoverable job. */
export async function linkBrandLookPreviewJobInTransaction(
  tx: DbTransaction,
  input: {
    userId: string;
    brandLookPreviewItemId: string;
    expectedImageJobId: string | null;
    job: AiGenerationJob;
  },
): Promise<void> {
  const item = await tx.brandLookPreviewItem.findFirst({
    where: {
      id: input.brandLookPreviewItemId,
      batch: { userId: input.userId },
    },
  });
  if (!item) throw new Error("Brand preview reservation target not found");
  if (
    item.aiGenerationJobId !== input.job.id
    && item.aiGenerationJobId !== input.expectedImageJobId
  ) {
    throw new Error("Brand preview reservation target changed concurrently");
  }
  const state = terminalItemState(input.job, item.outputUrl);
  await tx.brandLookPreviewItem.update({
    where: { id: item.id },
    data: {
      aiGenerationJobId: input.job.id,
      sourceType: "generated",
      ...state,
    },
  });
  await refreshBrandLookPreviewBatchInTransaction(tx, item.batchId);
}

/** Completion/refund helpers call this inside their own money transaction, so
 * a recovered stale job also makes its user-facing preview durable. */
export async function syncBrandLookPreviewJobInTransaction(
  tx: DbTransaction,
  job: AiGenerationJob,
): Promise<void> {
  const item = await tx.brandLookPreviewItem.findUnique({
    where: { aiGenerationJobId: job.id },
  });
  if (!item) return;
  const state = terminalItemState(job, item.outputUrl);
  await tx.brandLookPreviewItem.update({
    where: { id: item.id },
    data: state,
  });
  await refreshBrandLookPreviewBatchInTransaction(tx, item.batchId);
}

/** A provider poll error can be ambiguous after reservation linkage. Preserve
 * that durable job as in-progress so retry/reconciliation can settle it; only
 * an error before linkage is terminal and safe to expose as rerollable. */
export async function recoverBrandLookPreviewAfterGeneratorError(input: {
  itemId: string;
  errorCode: string;
}): Promise<"recoverable" | "terminal"> {
  return prisma.$transaction(async (tx) => {
    const item = await tx.brandLookPreviewItem.findUnique({
      where: { id: input.itemId },
      include: { aiGenerationJob: true },
    });
    if (!item) return "terminal";
    if (item.aiGenerationJob) {
      const state = terminalItemState(item.aiGenerationJob, item.outputUrl);
      await tx.brandLookPreviewItem.update({
        where: { id: item.id },
        data: state,
      });
      await refreshBrandLookPreviewBatchInTransaction(tx, item.batchId);
      return state.status === "in_progress" ? "recoverable" : "terminal";
    }
    await tx.brandLookPreviewItem.update({
      where: { id: item.id },
      data: { status: "failed", errorCode: input.errorCode },
    });
    await refreshBrandLookPreviewBatchInTransaction(tx, item.batchId);
    return "terminal";
  });
}

/** Recover preview work interrupted around reservation linkage. A stale item
 * with no job failed before money/provider work; a stale item still pointing at
 * a terminal prior job is a reroll claim that crashed before linking its new
 * reservation, so restore that prior terminal/deliverable state. */
export async function sweepStaleUnlinkedBrandLookPreviewItems(input: {
  now?: Date;
  olderThanMinutes?: number;
  limit?: number;
  dryRun?: boolean;
} = {}): Promise<{
  dryRun: boolean;
  scanned: number;
  failed: number;
  resumable: number;
  batchIds: string[];
}> {
  const now = input.now ?? new Date();
  const olderThanMinutes = Math.min(10_080, Math.max(30, Math.floor(input.olderThanMinutes ?? 30)));
  const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 50)));
  const cutoff = new Date(now.getTime() - olderThanMinutes * 60_000);
  const candidates = await prisma.brandLookPreviewItem.findMany({
    where: {
      status: { in: ["queued", "in_progress"] },
      OR: [
        { aiGenerationJobId: null },
        {
          aiGenerationJob: {
            is: {
              OR: [
                { status: { in: ["completed", "failed"] } },
                { chargeState: "refunded" },
              ],
            },
          },
        },
      ],
      updatedAt: { lt: cutoff },
    },
    include: { aiGenerationJob: true },
    orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
    take: limit,
  });
  const candidateBatchIds = [...new Set(candidates.map((item) => item.batchId))];
  if (input.dryRun === true || candidates.length === 0) {
    return {
      dryRun: input.dryRun === true,
      scanned: candidates.length,
      failed: 0,
      resumable: candidates.filter((item) => !item.aiGenerationJobId).length,
      batchIds: candidateBatchIds,
    };
  }

  return prisma.$transaction(async (tx) => {
    let failed = 0;
    let resumable = 0;
    const changedBatchIds = new Set<string>();
    for (const candidate of candidates) {
      const priorJob = candidate.aiGenerationJob;
      if (!priorJob) {
        // This is an admitted durable Preview child whose process died before
        // reservation linkage. Leave it queued for the cron dispatcher; never
        // turn an infrastructure interruption into a paid partial preview.
        resumable += 1;
        changedBatchIds.add(candidate.batchId);
        continue;
      }
      const state = terminalItemState(priorJob, candidate.outputUrl);
      const changed = await tx.brandLookPreviewItem.updateMany({
        where: {
          id: candidate.id,
          status: { in: ["queued", "in_progress"] },
          aiGenerationJobId: candidate.aiGenerationJobId,
          updatedAt: { lt: cutoff },
        },
        data: state,
      });
      if (changed.count === 1) {
        if (state.status === "failed") failed += 1;
        changedBatchIds.add(candidate.batchId);
      }
    }
    for (const batchId of changedBatchIds) {
      await refreshBrandLookPreviewBatchInTransaction(tx, batchId);
    }
    return {
      dryRun: false,
      scanned: candidates.length,
      failed,
      resumable,
      batchIds: [...changedBatchIds],
    };
  });
}
