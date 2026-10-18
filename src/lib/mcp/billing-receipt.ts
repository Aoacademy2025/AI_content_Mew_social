import { prisma } from "@/lib/prisma";
import { EXTERNAL_MEDIA_DISCLOSURE } from "./video-quote";
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
  return getVideoJobChainBillingReceipt({ videoJobIds: [input.videoJobId], userId: input.userId });
}

/**
 * The same receipt across every VideoJob of one delivered video. T8 (ADR 0063): an MCP
 * Agent-created Project delivers through a Preview job plus its server-chained Export job;
 * the base render (preview) and the burn (export) are stages of ONE product, so the chain as
 * a whole must hold exactly one active charge. Owner-scoped like the single-job receipt.
 */
export async function getVideoJobChainBillingReceipt(input: {
  videoJobIds: string[];
  userId: string;
}): Promise<VideoJobBillingReceipt> {
  const active = await prisma.renderJob.findMany({
    where: {
      parentJobId: { in: input.videoJobIds },
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

  return renderReceiptFrom(active);
}

function renderReceiptFrom(active: { status: string; reservedMinutes: number | null; creditsSpent: number | null }[]): VideoJobBillingReceipt {
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

function storedObject(json: string | null): Record<string, unknown> {
  try { return JSON.parse(json ?? "{}") ?? {}; } catch { return {}; }
}

export type BillingReceiptJobRow = {
  id: string;
  userId: string;
  type: string;
  status: string;
  inputJson: string;
  idempotencyKey: string | null;
  projectId: string | null;
  budgetQuoteId: string | null;
  fundingState: string;
  fundedCreditsSpent: number | null;
  fundedMeteredMinutes: number | null;
  reservationRefundPending: boolean;
};

/** Current money, not the cached output receipt. The legacy render receipt above remains
 * the release invariant. This owner-scoped read also works before delivery and after failure.
 * Every component is read in one database snapshot; reservations are already wallet debits. */
export async function getVideoJobCostReceipt(input: {
  videoJobId: string;
  userId: string;
  requestedRow?: BillingReceiptJobRow | null;
}) {
  const requested = input.requestedRow && input.requestedRow.id === input.videoJobId && input.requestedRow.userId === input.userId
    ? input.requestedRow
    : await prisma.videoJob.findFirst({ where: { id: input.videoJobId, userId: input.userId } });
  if (!requested) return null;
  const requestedInput = storedObject(requested.inputJson);
  const quote = requested.budgetQuoteId
    ? await prisma.mcpVideoQuote.findFirst({ where: { id: requested.budgetQuoteId, userId: input.userId, status: "consumed" } })
    : null;
  const hintedRoot = quote?.rootJobId ?? requestedInput.mcpRootJobId ??
    (requested.idempotencyKey === `mcp-chain:${requestedInput.sourceJobId}` ? requestedInput.sourceJobId : null);
  const linkedRoot = typeof hintedRoot === "string"
    ? (hintedRoot === requested.id
        ? requested
        : await prisma.videoJob.findFirst({ where: { id: hintedRoot, userId: input.userId } }))
    : null;
  const root = linkedRoot && (quote || requested.idempotencyKey === `mcp-chain:${linkedRoot.id}` ||
    (requested.projectId && requested.projectId === linkedRoot.projectId)) ? linkedRoot : requested;
  const [candidates, approvals] = await Promise.all([
    prisma.videoJob.findMany({ where: { userId: input.userId, OR: [
      { id: root.id },
      ...(root.budgetQuoteId ? [{ budgetQuoteId: root.budgetQuoteId }] : []),
      ...(root.projectId ? [{ projectId: root.projectId }] : []),
      { idempotencyKey: `mcp-chain:${root.id}` },
    ] } }),
    root.budgetQuoteId
      ? prisma.mcpVideoQuote.findMany({
          where: { userId: input.userId, rootJobId: root.id, status: "consumed", OR: [{ id: root.budgetQuoteId }, { parentQuoteId: root.budgetQuoteId }] },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })
      : Promise.resolve([]),
  ]);
  const jobs = candidates.filter(job => {
    if (job.id === root.id) return true;
    const data = storedObject(job.inputJson);
    return (root.budgetQuoteId && job.budgetQuoteId === root.budgetQuoteId) ||
      (root.projectId && job.projectId === root.projectId && data.mcpRootJobId === root.id) ||
      (job.type === "export" && job.idempotencyKey === `mcp-chain:${root.id}` && data.sourceJobId === root.id);
  });
  const ids = jobs.map(job => job.id);
  const quoteIds = approvals.map(approval => approval.id);
  const [images, renders, balance, promotional] = await Promise.all([
    prisma.aiGenerationJob.findMany({ where: { userId: input.userId, kind: "image", OR: [
      ...(quoteIds.length ? [{ budgetQuoteId: { in: quoteIds } }] : []),
      ...ids.map(id => ({ idempotencyKey: { startsWith: `video:${id}:` } })),
    ] } }),
    prisma.renderJob.findMany({ where: { userId: input.userId, parentJobId: { in: ids } } }),
    prisma.creditBalance.findUnique({ where: { userId: input.userId } }),
    prisma.promotionalCreditGrant.aggregate({ where: { userId: input.userId, expiresAt: { gt: new Date() }, remainingAmount: { gt: 0 } }, _sum: { remainingAmount: true } }),
  ]);
  const refundActions = [
    ...images.flatMap(image => [{ action: `ai-image-refund:${image.id}` }, { action: { startsWith: `ai-image-output-refund:${image.id}:` } }, { action: { startsWith: `ai-image-batch-refund:${image.id}:` } }]),
    ...jobs.flatMap(job => [{ action: { startsWith: `video-job-refund:${job.id}:` } }, { action: `video-job-trim:${job.id}` }]),
    ...renders.flatMap(render => [{ action: { startsWith: `render-refund:${render.id}:` } }, { action: `queue-for job ${render.id}` }, { action: `queue-superseding QUEUED job ${render.id}` }]),
  ];
  const refunds = refundActions.length
    ? await prisma.creditLedger.findMany({ where: { userId: input.userId, kind: "refund", delta: { gt: 0 }, OR: refundActions }, select: { action: true, delta: true } })
    : [];
    let imageCredits = 0, renderCredits = 0, includedRenderMinutes = 0;
    let reservedImageCredits = 0, reservedRenderCredits = 0, reservedIncludedRenderMinutes = 0;
    let consumedTrialImageUnits = 0, reservedTrialImageUnits = 0, refundedTrialImageUnits = 0;
    let pendingRefundExposureCredits = 0;
    let fundingReconciliationRequired = false;
    const refundPending = jobs.some(job => job.reservationRefundPending);
    for (const image of images) {
      if (image.fundingSource === "starter_allowance") {
        if (image.chargeState === "settled") consumedTrialImageUnits += image.allowanceUnits;
        if (image.chargeState === "reserved") reservedTrialImageUnits += image.allowanceUnits;
        if (image.chargeState === "refunded") refundedTrialImageUnits += image.allowanceUnits;
        continue;
      }
      if (image.fundingSource !== "credits") continue;
      const returned = refunds.filter(row => row.action === `ai-image-refund:${image.id}` || row.action?.startsWith(`ai-image-output-refund:${image.id}:`) || row.action?.startsWith(`ai-image-batch-refund:${image.id}:`)).reduce((n, row) => n + row.delta, 0);
      const amount = Math.max(0, image.creditCost - returned);
      if (image.chargeState === "settled") imageCredits += amount;
      if (image.chargeState === "reserved") reservedImageCredits += amount;
      // A reserved ambiguous provider result remains exposed, not a promised refund.
      if (refundPending && ["reserved", "settled"].includes(image.chargeState)) pendingRefundExposureCredits += amount;
    }
    const pricing = storedObject(approvals.find(approval => approval.id === root.budgetQuoteId)?.pricingJson ?? null);
    const minuteRate = typeof pricing.minuteCreditRate === "number" && pricing.minuteCreditRate > 0 ? pricing.minuteCreditRate : creditCostFor("minute");
    const included = (minutes: number | null, credits: number) => Math.max(0, (minutes ?? 0) - credits / minuteRate);
    const active = renders.filter(render => render.reservedQuota);
    for (const render of active) {
      const returned = refunds.filter(row => row.action?.startsWith(`render-refund:${render.id}:`) || row.action === `queue-for job ${render.id}` || row.action === `queue-superseding QUEUED job ${render.id}`).reduce((n, row) => n + row.delta, 0);
      const amount = Math.max(0, (render.creditsSpent ?? 0) - returned);
      const minutes = included(render.reservedMinutes, render.creditsSpent ?? 0);
      if (render.status === "DONE") {
        renderCredits += amount;
        includedRenderMinutes += minutes;
      } else {
        reservedRenderCredits += amount;
        reservedIncludedRenderMinutes += minutes;
      }
      if (jobs.find(job => job.id === render.parentJobId)?.reservationRefundPending) pendingRefundExposureCredits += amount;
    }
    for (const job of jobs) {
      // Transferred funding is a mirror. If its render still owns the money, count only
      // that render. If the render cleared its flags before a failed refund, keep the
      // durable parent exposure outstanding until a confirmed ledger refund arrives.
      if (active.some(render => render.parentJobId === job.id)) continue;
      // The same reservation may have moved again from the root's base render to
      // a descendant composite/burn. Its transferred parent still is only a mirror.
      if (["transferred", "settled"].includes(job.fundingState) && active.length > 0) continue;
      if (!["reserved", "transferred", "settled"].includes(job.fundingState)) continue;
      const renderIds = renders.filter(render => job.fundingState !== "reserved" || render.parentJobId === job.id).map(render => render.id);
      const returned = refunds.filter(row => row.action?.startsWith(`video-job-refund:${job.id}:`) || renderIds.some(id => row.action?.startsWith(`render-refund:${id}:`) || row.action === `queue-for job ${id}` || row.action === `queue-superseding QUEUED job ${id}`)).reduce((n, row) => n + row.delta, 0);
      const amount = Math.max(0, (job.fundedCreditsSpent ?? 0) - returned);
      const minutes = included(job.fundedMeteredMinutes, job.fundedCreditsSpent ?? 0);
      if (job.fundingState !== "reserved" && renderIds.length > 0 && (amount > 0 || minutes > 0)) fundingReconciliationRequired = true;
      if (job.fundingState === "settled" && renderIds.length === 0) { renderCredits += amount; includedRenderMinutes += minutes; }
      else { reservedRenderCredits += amount; reservedIncludedRenderMinutes += minutes; }
      if (job.reservationRefundPending) pendingRefundExposureCredits += amount;
    }
    const outstandingReservedCredits = reservedImageCredits + reservedRenderCredits;
    const externalCharges = [...new Set(approvals.flatMap(approval => {
      const charges = storedObject(approval.receiptJson).externalCharges;
      return Array.isArray(charges) ? charges.filter((value): value is string => typeof value === "string") : [];
    }))];
    const source = approvals.find(approval => approval.id === root.budgetQuoteId)?.source ?? storedObject(root.inputJson).brollSource ?? "stock";
    if (source === "external" && !externalCharges.includes(EXTERNAL_MEDIA_DISCLOSURE)) externalCharges.push(EXTERNAL_MEDIA_DISCLOSURE);
    const renderReceipt = renderReceiptFrom(active);
    const confirmedRefundCredits = refunds.reduce((n, row) => n + row.delta, 0);
    const hasOutstanding = outstandingReservedCredits > 0 || reservedTrialImageUnits > 0 || reservedIncludedRenderMinutes > 0 || active.some(render => render.status !== "DONE");
    const settlementStatus = refundPending ? "refund_pending" : fundingReconciliationRequired ? "reconciliation_required" : hasOutstanding ? "in_progress" :
      imageCredits + renderCredits + includedRenderMinutes + consumedTrialImageUnits > 0 || active.some(render => render.status === "DONE") ? "settled" :
      confirmedRefundCredits > 0 || refundedTrialImageUnits > 0 || jobs.some(job => job.fundingState === "refunded") ? "refunded" : "unfunded";
    // A queued or fully refunded canceled job legitimately has no settled render.
    // Keep release errors for delivered jobs / multiple charges, not ordinary lifecycle states.
    const compatibleReceipt = renderReceipt.status === "error" && renderReceipt.code !== "multiple_active_charges" && !jobs.some(job => job.status === "done")
      ? { status: settlementStatus }
      : renderReceipt;
    return {
      ...compatibleReceipt,
      rootJobId: root.id,
      source: typeof source === "string" ? source : "stock",
      settlementStatus,
      approvals: approvals.map(approval => ({ quoteId: approval.id, parentQuoteId: approval.parentQuoteId, status: approval.status, approvedAt: approval.approvedAt?.toISOString() ?? null, imageCountCeiling: approval.imageCountCeiling, imageCreditCeiling: approval.imageCreditCeiling, renderCreditCeiling: approval.renderCreditCeiling, includedRenderMinutes: approval.includedRenderMinutes, totalHeroCreditCeiling: approval.totalHeroCreditCeiling, pricing: storedObject(approval.pricingJson) })),
      approvedImageCountCeiling: approvals.length ? approvals.reduce((n, approval) => n + approval.imageCountCeiling, 0) : null,
      approvedIncludedRenderMinutes: approvals.length ? approvals.reduce((n, approval) => n + approval.includedRenderMinutes, 0) : null,
      approvedImageCreditCeiling: approvals.length ? approvals.reduce((n, approval) => n + approval.imageCreditCeiling, 0) : null,
      approvedRenderCreditCeiling: approvals.length ? approvals.reduce((n, approval) => n + approval.renderCreditCeiling, 0) : null,
      approvedTotalHeroCreditCeiling: approvals.length ? approvals.reduce((n, approval) => n + approval.totalHeroCreditCeiling, 0) : null,
      imageCredits, renderCredits, includedRenderMinutes,
      settledTotalCredits: imageCredits + renderCredits,
      reservedImageCredits, reservedRenderCredits, outstandingReservedCredits, reservedIncludedRenderMinutes,
      confirmedRefundCredits,
      // The durable marker says reconciliation is pending, but does not allocate a
      // guaranteed refund amount. Never turn the whole exposed balance into a promise.
      pendingRefundCredits: refundPending ? null : 0,
      pendingRefundExposureCredits, refundPending, fundingReconciliationRequired,
      consumedTrialImageUnits, reservedTrialImageUnits, refundedTrialImageUnits,
      // CreditBalance contains available money AFTER reservations; never subtract them twice.
      availableCredits: (balance?.granted ?? 0) + (balance?.purchased ?? 0) + (promotional._sum.remainingAmount ?? 0),
    renderChargeCount: active.length,
    externalCharges,
  };
}
