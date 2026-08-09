import "server-only";

import type { AiGenerationJob, Prisma } from "@prisma/client";

type DbTransaction = Prisma.TransactionClient;

async function refreshPreviewBatch(tx: DbTransaction, batchId: string): Promise<void> {
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
  await refreshPreviewBatch(tx, item.batchId);
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
  await refreshPreviewBatch(tx, item.batchId);
}
