import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { quoteHash, currentQuotePricing, stableQuoteJson, QUOTE_TTL_MS, type QuoteReceipt } from "./video-quote";
import { VideoBudgetHoldError } from "./video-budget-admission";
import { PipelineApiError, type PipelineCaller } from "./pipeline-client";

type Entry = { path: string; state: "running" | "done"; result?: unknown };
type Checkpoint = { version: 1; calls: Record<string, Entry>; hold?: { reason: string; quoteId?: string } };
const parse = (json: string | null): Checkpoint => json ? JSON.parse(json) : { version: 1, calls: {} };
const cachedPaths = new Set(["/api/videos/tts", "/api/videos/tts-gemini", "/api/videos/audio-duration", "/api/videos/transcribe", "/api/videos/split-script", "/api/videos/keywords", "/api/videos/extract-keywords", "/api/videos/fetch-stock", "/api/videos/render"]);

/** Successful narration/planning/media responses are durable before the next stage.
 * An ambiguous narration submission is never retried automatically after restart. */
export function checkpointedBudgetCaller(userId: string, jobId: string, caller: PipelineCaller): PipelineCaller {
  return { ...caller, async post<T>(path: string, body: unknown, opts?: Parameters<PipelineCaller["post"]>[2]): Promise<T> {
    if (!cachedPaths.has(path)) return caller.post<T>(path, body, opts);
    const job = await prisma.videoJob.findFirst({ where: { id: jobId, userId } });
    if (!job?.budgetQuoteId) return caller.post<T>(path, body, opts);
    if (path === "/api/videos/render") {
      const renderBody = body as { subtitleOverlayConfig?: unknown };
      const durable = await prisma.renderJob.findFirst({ where: { userId, parentJobId: jobId, type: renderBody.subtitleOverlayConfig ? "BURN" : "RENDER", status: { in: ["QUEUED", "RUNNING", "DONE"] } }, orderBy: { createdAt: "asc" } });
      if (durable && (durable.status !== "DONE" || durable.videoUrl)) return { jobId: durable.id } as T;
    }
    const key = quoteHash({ path, body });
    const checkpoint = parse(job.budgetCheckpointJson);
    if (checkpoint.calls[key]?.state === "done") return checkpoint.calls[key].result as T;
    if (checkpoint.calls[key]?.state === "running" && (path.includes("/tts") || path === "/api/videos/render")) throw new VideoBudgetHoldError(path === "/api/videos/render" ? "render_outcome_unknown" : "narration_outcome_unknown");
    await prisma.$transaction(async tx => {
      const current = await tx.videoJob.findUniqueOrThrow({ where: { id: jobId } });
      const next = parse(current.budgetCheckpointJson);
      next.calls[key] = { path, state: "running" };
      await tx.videoJob.update({ where: { id: jobId }, data: { budgetCheckpointJson: JSON.stringify(next) } });
    });
    let result: T;
    try {
      result = await caller.post<T>(path, body, { ...opts, retries: 0 });
    } catch (error) {
      // A definitive admission refusal submitted no render. Preserve unknown
      // transport outcomes, but do not turn a budget refusal into uncertain spend.
      if (path === "/api/videos/render" && (error instanceof VideoBudgetHoldError || (error instanceof PipelineApiError && error.status === 409 && error.code === "confirmation_required"))) {
        await prisma.$transaction(async tx => {
          const current = await tx.videoJob.findUniqueOrThrow({ where: { id: jobId } });
          const next = parse(current.budgetCheckpointJson);
          delete next.calls[key];
          await tx.videoJob.update({ where: { id: jobId }, data: { budgetCheckpointJson: JSON.stringify(next) } });
        });
      }
      throw error;
    }
    await prisma.$transaction(async tx => {
      const current = await tx.videoJob.findUniqueOrThrow({ where: { id: jobId } });
      const next = parse(current.budgetCheckpointJson);
      next.calls[key] = { path, state: "done", result };
      await tx.videoJob.update({ where: { id: jobId }, data: { budgetCheckpointJson: JSON.stringify(next) } });
    });
    return result;
  } };
}

export async function holdVideoBudget(userId: string, jobId: string, error: VideoBudgetHoldError) {
  return prisma.$transaction(async tx => {
    const job = await tx.videoJob.findFirst({ where: { id: jobId, userId } });
    if (!job?.budgetQuoteId || job.status === "canceled" || job.status === "failed" || job.status === "done") return null;
    const original = await tx.mcpVideoQuote.findFirst({ where: { id: job.budgetQuoteId, userId, status: "consumed" } });
    if (!original?.rootJobId) return null;
    const checkpoint = parse(job.budgetCheckpointJson);
    if (job.status === "confirmation_required" && checkpoint.hold) return checkpoint.hold.quoteId ?? null;
    const revision = job.budgetCheckpointRevision + 1;
    // Unknown provider exposure needs reconciliation, never another spending permission.
    const additional = error.additional;
    let quoteId: string | undefined;
    if (Object.values(additional).some(n => n && n > 0) || error.reason === "image_price_changed" || error.reason === "render_price_changed") {
      const priorReceipt = JSON.parse(original.receiptJson) as QuoteReceipt;
      const priorIncrements = await tx.mcpVideoQuote.aggregate({ where: { userId, parentQuoteId: original.id, status: "consumed" }, _sum: { totalHeroCreditCeiling: true } });
      const wallet = await tx.creditBalance.findUnique({ where: { userId } });
      const promotional = await tx.promotionalCreditGrant.aggregate({ where: { userId, expiresAt: { gt: new Date() }, remainingAmount: { gt: 0 } }, _sum: { remainingAmount: true } });
      const availableCredits = (wallet?.granted ?? 0) + (wallet?.purchased ?? 0) + (promotional._sum.remainingAmount ?? 0);
      const pricing = currentQuotePricing();
      const images = additional.images ?? 0;
      const imageCredits = additional.imageCredits ?? 0;
      const renderCredits = additional.renderCredits ?? 0;
      const renderMinutes = additional.renderMinutes ?? 0;
      const receipt = { ...priorReceipt, pricing, availableCredits, projectedRemainingCredits: availableCredits - imageCredits - renderCredits, imageCountCeiling: images, imageCreditCeiling: imageCredits, renderCreditCeiling: renderCredits, renderMinutesCeiling: renderMinutes, includedRenderMinutes: Math.max(0, renderMinutes - renderCredits / priorReceipt.pricing.minuteCreditRate), totalHeroCreditCeiling: imageCredits + renderCredits, cumulativeHeroCreditCeiling: original.totalHeroCreditCeiling + (priorIncrements._sum.totalHeroCreditCeiling ?? 0) + imageCredits + renderCredits, incremental: true, retainedRootJobId: original.rootJobId, checkpointRevision: revision };
      const execution = { ...JSON.parse(original.executionJson), resumeJobId: jobId, checkpointHash: quoteHash(checkpoint), additional };
      const quote = await tx.mcpVideoQuote.create({ data: {
        userId, parentQuoteId: original.id, rootJobId: original.rootJobId, checkpointRevision: revision,
        inputJson: original.inputJson, inputHash: original.inputHash,
        executionJson: stableQuoteJson(execution), executionHash: quoteHash(execution), pricingJson: stableQuoteJson(pricing), pricingHash: quoteHash(pricing),
        receiptJson: JSON.stringify(receipt), source: original.source, imageCountCeiling: images, imageCreditCeiling: imageCredits, renderCreditCeiling: renderCredits, includedRenderMinutes: receipt.includedRenderMinutes, totalHeroCreditCeiling: imageCredits + renderCredits,
        expiresAt: new Date(Date.now() + QUOTE_TTL_MS),
      } });
      quoteId = quote.id;
    }
    checkpoint.hold = { reason: error.reason, quoteId };
    await tx.videoJob.update({ where: { id: jobId }, data: { status: "confirmation_required", errorCode: "confirmation_required", errorMessage: error.message, budgetCheckpointJson: JSON.stringify(checkpoint), budgetCheckpointRevision: revision, outputJson: JSON.stringify({ confirmationRequired: true, quoteId, retainedCheckpoint: true }) } });
    return quoteId;
  });
}

/** Persist derived scene plans and individual successful assets under stable work keys. */
export async function budgetStage<T>(userId: string, jobId: string | undefined, stage: string, work: unknown, run: () => Promise<T>): Promise<T> {
  if (!jobId) return run();
  const job = await prisma.videoJob.findFirst({ where: { id: jobId, userId } });
  if (!job?.budgetQuoteId) return run();
  const key = quoteHash({ stage, work });
  const checkpoint = parse(job.budgetCheckpointJson);
  if (checkpoint.calls[key]?.state === "done") return checkpoint.calls[key].result as T;
  const result = await run();
  await prisma.$transaction(async tx => {
    const current = await tx.videoJob.findUniqueOrThrow({ where: { id: jobId } });
    const next = parse(current.budgetCheckpointJson);
    next.calls[key] = { path: stage, state: "done", result };
    await tx.videoJob.update({ where: { id: jobId }, data: { budgetCheckpointJson: JSON.stringify(next) } });
  });
  return result;
}

/** Only durable outcomes can unpark uncertain work; approval holds are never released here. */
export async function resumeKnownBudgetWorkInTransaction(tx: Prisma.TransactionClient, userId: string, jobId: string, recoveringWorker = false): Promise<boolean> {
  const job = await tx.videoJob.findFirst({ where: { id: jobId, userId, budgetQuoteId: { not: null }, status: { in: recoveringWorker ? ["processing", "confirmation_required"] : ["confirmation_required"] } } });
  if (!job?.budgetCheckpointJson) return false;
  const checkpoint = parse(job.budgetCheckpointJson);
  if (checkpoint.hold?.quoteId || Object.values(checkpoint.calls).some(call => call.state === "running" && call.path.includes("/tts"))) return false;
  const approval = await tx.mcpVideoQuote.findFirst({ where: { id: job.budgetQuoteId!, userId, status: "consumed" } });
  if (!approval) return false;
  let known = false;
  if (job.currentStep === "render") {
    const render = await tx.renderJob.findFirst({ where: { userId, parentJobId: job.id, type: "RENDER", status: { in: ["QUEUED", "RUNNING", "DONE"] } }, orderBy: { createdAt: "asc" } });
    known = !!render && (render.status !== "DONE" || !!render.videoUrl);
  } else if (checkpoint.hold?.reason === "image_poll_unknown" || checkpoint.hold?.reason === "image_submission_unknown" || checkpoint.hold?.reason === "image_cancel_unknown") {
    const images = await tx.aiGenerationJob.findMany({ where: { userId, budgetQuoteId: job.budgetQuoteId, idempotencyKey: { startsWith: `video:${job.id}:` } }, select: { status: true, chargeState: true, outputUrl: true } });
    known = images.length > 0 && images.every(image => image.status === "completed" && image.chargeState === "settled" && !!image.outputUrl);
  }
  if (!known) return false;
  delete checkpoint.hold;
  await tx.videoJob.update({ where: { id: job.id }, data: { status: "queued", currentStep: null, startedAt: null, finishedAt: null, errorCode: null, errorMessage: null, outputJson: null, budgetCheckpointJson: JSON.stringify(checkpoint) } });
  return true;
}

/** Renew an expired/rejected incremental review without discarding retained work. */
export async function renewBudgetQuote(userId: string, jobId: string): Promise<string | null> {
  return prisma.$transaction(async tx => {
    if (await resumeKnownBudgetWorkInTransaction(tx, userId, jobId)) {
      return (await tx.videoJob.findUniqueOrThrow({ where: { id: jobId } })).budgetQuoteId;
    }
    const job = await tx.videoJob.findFirst({ where: { id: jobId, userId, status: "confirmation_required" } });
    if (!job?.budgetQuoteId) return null;
    const checkpoint = parse(job.budgetCheckpointJson);
    if (!checkpoint.hold?.quoteId) return null;
    const old = await tx.mcpVideoQuote.findFirst({ where: { id: checkpoint.hold.quoteId, userId, parentQuoteId: job.budgetQuoteId } });
    if (!old) return null;
    if ((old.status === "draft" || old.status === "approved") && old.expiresAt > new Date()) return old.id;
    const pricing = currentQuotePricing();
    const oldReceipt = JSON.parse(old.receiptJson) as QuoteReceipt;
    const imageCreditCeiling = Math.max(0, old.imageCreditCeiling + old.imageCountCeiling * (pricing.perImageCredits - oldReceipt.pricing.perImageCredits));
    const renderCreditCeiling = old.renderCreditCeiling / oldReceipt.pricing.minuteCreditRate * pricing.minuteCreditRate;
    const wallet = await tx.creditBalance.findUnique({ where: { userId } });
    const promotional = await tx.promotionalCreditGrant.aggregate({ where: { userId, expiresAt: { gt: new Date() }, remainingAmount: { gt: 0 } }, _sum: { remainingAmount: true } });
    const availableCredits = (wallet?.granted ?? 0) + (wallet?.purchased ?? 0) + (promotional._sum.remainingAmount ?? 0);
    const receipt = { ...oldReceipt, pricing, availableCredits, projectedRemainingCredits: availableCredits - imageCreditCeiling - renderCreditCeiling, imageCreditCeiling, renderCreditCeiling, totalHeroCreditCeiling: imageCreditCeiling + renderCreditCeiling, cumulativeHeroCreditCeiling: (oldReceipt.cumulativeHeroCreditCeiling ?? old.totalHeroCreditCeiling) - old.totalHeroCreditCeiling + imageCreditCeiling + renderCreditCeiling };
    const next = await tx.mcpVideoQuote.create({ data: {
      userId, parentQuoteId: old.parentQuoteId, rootJobId: old.rootJobId, checkpointRevision: old.checkpointRevision,
      inputJson: old.inputJson, inputHash: old.inputHash, executionJson: old.executionJson, executionHash: old.executionHash,
      pricingJson: stableQuoteJson(pricing), pricingHash: quoteHash(pricing), receiptJson: JSON.stringify(receipt), source: old.source,
      imageCountCeiling: old.imageCountCeiling, imageCreditCeiling, renderCreditCeiling, includedRenderMinutes: old.includedRenderMinutes, totalHeroCreditCeiling: receipt.totalHeroCreditCeiling,
      expiresAt: new Date(Date.now() + QUOTE_TTL_MS),
    } });
    checkpoint.hold.quoteId = next.id;
    await tx.videoJob.update({ where: { id: job.id }, data: { budgetCheckpointJson: JSON.stringify(checkpoint) } });
    return next.id;
  });
}
