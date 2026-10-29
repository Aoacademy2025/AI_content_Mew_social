import type { Prisma } from "@prisma/client";
import { currentQuotePricing, quoteHash, type QuoteReceipt } from "./video-quote";

export class VideoBudgetHoldError extends Error {
  readonly code = "confirmation_required";
  constructor(public readonly reason: string, public readonly additional: { images?: number; imageCredits?: number; renderCredits?: number; renderMinutes?: number } = {}) {
    super("วงเงินที่ยืนยันไม่ครอบคลุมงานนี้ — เปิดใบยืนยันใหม่ใน Studio เพื่อทำต่อจากงานที่บันทึกไว้");
    this.name = "VideoBudgetHoldError";
  }
}

/** Resolve only persisted, owner-checked attribution. Client JSON never grants a budget. */
export async function resolveVideoBudget(tx: Prisma.TransactionClient, userId: string, jobId: string) {
  const job = await tx.videoJob.findFirst({ where: { id: jobId, userId } });
  if (!job?.budgetQuoteId) return null;
  const quote = await tx.mcpVideoQuote.findFirst({ where: { id: job.budgetQuoteId, userId, status: "consumed" } });
  if (!quote?.rootJobId) throw new VideoBudgetHoldError("invalid_budget");
  const root = await tx.videoJob.findFirst({ where: { id: quote.rootJobId, userId, budgetQuoteId: quote.id } });
  if (!root) throw new VideoBudgetHoldError("invalid_root");
  // Lock before aggregate admission. SQLite writers serialize through this root.
  await tx.videoJob.update({ where: { id: root.id }, data: { budgetCheckpointRevision: { increment: 0 } } });
  const increments = await tx.mcpVideoQuote.findMany({ where: { userId, rootJobId: root.id, parentQuoteId: quote.id, status: "consumed" }, orderBy: { consumedAt: "asc" } });
  const approvals = [quote, ...increments];
  return { job, root, quote, priceApproval: increments.at(-1) ?? quote, receipt: JSON.parse(quote.receiptJson) as QuoteReceipt,
    imageCount: approvals.reduce((n, q) => n + q.imageCountCeiling, 0),
    imageCredits: approvals.reduce((n, q) => n + q.imageCreditCeiling, 0),
    renderCredits: approvals.reduce((n, q) => n + q.renderCreditCeiling, 0),
    totalCredits: approvals.reduce((n, q) => n + q.totalHeroCreditCeiling, 0),
    renderMinutes: approvals.reduce((n, q) => n + (JSON.parse(q.receiptJson) as QuoteReceipt).renderMinutesCeiling, 0),
  };
}

export async function budgetExposure(tx: Prisma.TransactionClient, userId: string, quoteId: string) {
  const images = await tx.aiGenerationJob.findMany({ where: { userId, budgetQuoteId: quoteId, kind: "image", chargeState: { in: ["reserved", "settled"] } }, select: { creditCost: true, fundingSource: true } });
  // Root funding mirrors a transferred render debit. Count that mirror once, never both.
  const jobs = await tx.videoJob.findMany({ where: { userId, budgetQuoteId: quoteId, fundingState: { in: ["reserved", "transferred", "settled"] } }, select: { fundedCreditsSpent: true } });
  return { images: images.length, imageCredits: images.reduce((n, j) => n + (j.fundingSource === "starter_allowance" ? 0 : j.creditCost), 0), renderCredits: jobs.reduce((n, j) => n + (j.fundedCreditsSpent ?? 0), 0) };
}

export async function admitBudgetImage(tx: Prisma.TransactionClient, input: { userId: string; idempotencyKey: string; inputJson: string; creditCost: number; provider: string; model: string; productSurface?: string }, fundingSource: string) {
  if (input.productSurface === "scene_reroll") return null;
  const linked = /^video:([^:]+):/.exec(input.idempotencyKey)?.[1];
  const data = JSON.parse(input.inputJson) as { videoJobId?: string };
  const jobId = data.videoJobId ?? linked;
  if (!jobId) return null;
  const budget = await resolveVideoBudget(tx, input.userId, jobId);
  if (!budget) return null;
  if (budget.job.status === "confirmation_required") throw new VideoBudgetHoldError("job_held");
  if (linked && data.videoJobId && linked !== data.videoJobId) throw new VideoBudgetHoldError("image_parent_changed");
  const cost = fundingSource === "starter_allowance" ? 0 : input.creditCost;
  if (!linked || (budget.quote.source !== "automix" && budget.quote.source !== "hero-ai-image")) throw new VideoBudgetHoldError("unapproved_image_work", { images: 1, imageCredits: cost });
  const used = await budgetExposure(tx, input.userId, budget.quote.id);
  const additional = { images: Math.max(0, used.images + 1 - budget.imageCount), imageCredits: Math.max(0, used.imageCredits + cost - budget.imageCredits, used.imageCredits + used.renderCredits + cost - budget.totalCredits) };
  if (input.provider !== "runpod" || input.model !== "z-image-turbo") throw new VideoBudgetHoldError("unapproved_provider");
  if (quoteHash(currentQuotePricing()) !== budget.priceApproval.pricingHash || input.creditCost !== (JSON.parse(budget.priceApproval.pricingJson) as ReturnType<typeof currentQuotePricing>).perImageCredits) throw new VideoBudgetHoldError("image_price_changed", additional);
  if (used.images + 1 > budget.imageCount || used.imageCredits + cost > budget.imageCredits || used.imageCredits + used.renderCredits + cost > budget.totalCredits) throw new VideoBudgetHoldError("image_ceiling", additional);
  return budget.quote.id;
}

export async function admitBudgetRender(tx: Prisma.TransactionClient, userId: string, jobId: string, addedCredits: number, actualMinutes: number) {
  const budget = await resolveVideoBudget(tx, userId, jobId);
  if (!budget) return;
  const used = await budgetExposure(tx, userId, budget.quote.id);
  if (quoteHash(currentQuotePricing()) !== budget.priceApproval.pricingHash || actualMinutes > budget.renderMinutes || used.renderCredits + addedCredits > budget.renderCredits || used.imageCredits + used.renderCredits + addedCredits > budget.totalCredits) {
    throw new VideoBudgetHoldError(quoteHash(currentQuotePricing()) !== budget.priceApproval.pricingHash ? "render_price_changed" : "render_ceiling", { renderCredits: Math.max(0, used.renderCredits + addedCredits - budget.renderCredits, used.imageCredits + used.renderCredits + addedCredits - budget.totalCredits), renderMinutes: Math.max(0, actualMinutes - budget.renderMinutes) });
  }
}
