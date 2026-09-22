/**
 * Pure reporting helpers for AI-image credit-ledger rows.
 *
 * New durable image reservations use namespaced actions (`ai-image:<jobId>`),
 * while the older managed-KIE path wrote the exact legacy action (`ai-image`).
 * Admin reporting must include both and, when a durable job exists, prefer its
 * real model over inferring the provider from a shared credit delta.
 */

export type AiImageCostBucket = "hero1k" | "flux1k" | "gpt1k" | "nano1k" | "gpt2k" | "nano2k";

export type AiImageCounts = Record<AiImageCostBucket, number>;

export function emptyAiImageCounts(): AiImageCounts {
  return { hero1k: 0, flux1k: 0, gpt1k: 0, nano1k: 0, gpt2k: 0, nano2k: 0 };
}

export function aiImageLedgerActionWhere(kind: "spend" | "refund") {
  if (kind === "spend") {
    return {
      OR: [
        { action: "ai-image" },
        { action: { startsWith: "ai-image:" } },
        { action: { startsWith: "ai-image-reservation:" } },
      ],
    };
  }
  return { OR: [{ action: "ai-image-refund" }, { action: { startsWith: "ai-image-refund:" } }] };
}

export function aiImageJobIdFromAction(action: string | null | undefined): string | null {
  if (typeof action !== "string") return null;
  for (const prefix of ["ai-image:", "ai-image-refund:"] as const) {
    if (action.startsWith(prefix)) {
      const jobId = action.slice(prefix.length).trim();
      return jobId || null;
    }
  }
  return null;
}

export function aiImageReservationKeyFromAction(action: string | null | undefined): string | null {
  const prefix = "ai-image-reservation:";
  if (typeof action !== "string" || !action.startsWith(prefix)) return null;
  return action.slice(prefix.length).trim() || null;
}

export function aiImageCostBucket(input: {
  model?: string | null;
  delta: number;
}): AiImageCostBucket | null {
  const model = input.model?.trim().toLowerCase() ?? "";
  if (model === "z-image-turbo") return "hero1k";
  if (model === "flux2-klein-4b" || model === "flux-2/pro-text-to-image") return "flux1k";
  if (model === "gpt-image-2" || model === "gpt-image-2-text-to-image") return "gpt1k";
  if (model === "nano-banana-2") return "nano1k";

  // Legacy rows predate durable AiGenerationJob linkage. Keep their historical
  // credit-delta attribution as a fallback rather than dropping the spend.
  const absDelta = Math.abs(input.delta);
  if (absDelta === 2) return "flux1k";
  if (absDelta === 3) return "gpt1k";
  if (absDelta === 4) return "nano1k";
  if (absDelta === 5) return "gpt2k";
  if (absDelta === 6) return "nano2k";
  return null;
}

type AiImageLedgerRow = {
  userId: string;
  delta: number;
  action: string | null;
};

type AiImageReportJob = {
  id: string;
  userId: string;
  model: string;
  status: string;
  chargeState: string;
  creditCost: number;
  fundingSource: string;
  idempotencyKey: string | null;
  finishedAt: Date | null;
};

export type AiImageUsageSummary = {
  /** Known completed delivery counts used for customer/output reporting. */
  imageCounts: AiImageCounts;
  /** Gross provider-work estimates, kept independent from wallet refunds. */
  estimatedImageCounts: AiImageCounts;
  perUserImages: Map<string, AiImageCounts>;
  creditsSpent: number;
  deliveredImages: number;
  allowanceImages: number;
  unattributedImages: number;
};

type AiImageProviderCostSnapshot = {
  billedUsdMicros: number;
  usdThbRate: number;
  costCoverage: "complete" | "partial" | "unavailable" | "stale";
  costSource: "provider_reported_attempts" | "runpod_billing";
};

export type AiImageCostReport = {
  status: "actual" | "actual_plus_estimates" | "partial" | "unavailable" | "stale";
  source: AiImageProviderCostSnapshot["costSource"] | null;
  actualRunpodBaht: number | null;
  estimatedOtherBaht: number;
  totalBaht: number | null;
  unattributedImages: number;
};

/** Keep provider charges independent from customer-wallet refunds. */
export function resolveAiImageCost(input: {
  providerSnapshot: AiImageProviderCostSnapshot | null;
  estimatedOtherBaht: number;
  unattributedImages: number;
}): AiImageCostReport {
  const snapshot = input.providerSnapshot;
  if (!snapshot) {
    return {
      status: "unavailable",
      source: null,
      actualRunpodBaht: null,
      estimatedOtherBaht: input.estimatedOtherBaht,
      totalBaht: null,
      unattributedImages: input.unattributedImages,
    };
  }
  if (snapshot.costCoverage !== "complete") {
    return {
      status: snapshot.costCoverage,
      source: snapshot.costSource,
      actualRunpodBaht: null,
      estimatedOtherBaht: input.estimatedOtherBaht,
      totalBaht: null,
      unattributedImages: input.unattributedImages,
    };
  }
  const actualRunpodBaht = (snapshot.billedUsdMicros / 1_000_000) * snapshot.usdThbRate;
  if (input.unattributedImages > 0) {
    return {
      status: "partial",
      source: snapshot.costSource,
      actualRunpodBaht,
      estimatedOtherBaht: input.estimatedOtherBaht,
      totalBaht: null,
      unattributedImages: input.unattributedImages,
    };
  }
  return {
    status: input.estimatedOtherBaht > 0 ? "actual_plus_estimates" : "actual",
    source: snapshot.costSource,
    actualRunpodBaht,
    estimatedOtherBaht: input.estimatedOtherBaht,
    totalBaht: actualRunpodBaht + input.estimatedOtherBaht,
    unattributedImages: 0,
  };
}

function addImage(
  imageCounts: AiImageCounts,
  perUserImages: Map<string, AiImageCounts>,
  userId: string,
  bucket: AiImageCostBucket,
) {
  imageCounts[bucket]++;
  const userCounts = perUserImages.get(userId) ?? emptyAiImageCounts();
  userCounts[bucket]++;
  perUserImages.set(userId, userCounts);
}

/**
 * Reconciles the two historical ledger namespaces with the durable image-job
 * projection. Durable completed jobs are the delivery source of truth, so a
 * reservation row never counts the same image twice and allowance-funded
 * deliveries remain visible even though they have no wallet row.
 */
export function summarizeAiImageUsage(input: {
  spendRows: AiImageLedgerRow[];
  refundRows: Pick<AiImageLedgerRow, "delta" | "action">[];
  jobs: AiImageReportJob[];
  from?: Date;
  to?: Date;
}): AiImageUsageSummary {
  const imageCounts = emptyAiImageCounts();
  const estimatedImageCounts = emptyAiImageCounts();
  const perUserImages = new Map<string, AiImageCounts>();
  const jobsById = new Map(input.jobs.map((job) => [job.id, job]));
  const jobsByReservation = new Map(
    input.jobs
      .filter((job) => Boolean(job.idempotencyKey))
      .map((job) => [`${job.userId}\u0000${job.idempotencyKey}`, job]),
  );
  let deliveredImages = 0;
  let allowanceImages = 0;
  let unattributedImages = 0;
  const hasUnlinkedLegacyRefund = input.refundRows.some(
    (row) => row.action == null || row.action === "ai-image-refund",
  );

  for (const job of input.jobs) {
    if (job.status !== "completed" || job.chargeState !== "settled") continue;
    if (!job.finishedAt) continue;
    if (input.from && job.finishedAt < input.from) continue;
    if (input.to && job.finishedAt >= input.to) continue;
    deliveredImages++;
    if (job.fundingSource === "starter_allowance") allowanceImages++;
    const bucket = aiImageCostBucket({ model: job.model, delta: -job.creditCost });
    if (!bucket) {
      unattributedImages++;
      continue;
    }
    estimatedImageCounts[bucket]++;
    addImage(imageCounts, perUserImages, job.userId, bucket);
  }

  for (const row of input.spendRows) {
    const jobId = aiImageJobIdFromAction(row.action);
    const reservationKey = aiImageReservationKeyFromAction(row.action);
    const durableJob = jobId
      ? jobsById.get(jobId)
      : reservationKey
        ? jobsByReservation.get(`${row.userId}\u0000${reservationKey}`)
        : null;
    if (durableJob) continue;
    const bucket = aiImageCostBucket({ delta: row.delta });
    if (bucket) estimatedImageCounts[bucket]++;
    if (row.action === "ai-image" && hasUnlinkedLegacyRefund) {
      unattributedImages++;
      continue;
    }
    deliveredImages++;
    if (!bucket) {
      unattributedImages++;
      continue;
    }
    addImage(imageCounts, perUserImages, row.userId, bucket);
  }

  const grossCredits = input.spendRows.reduce((sum, row) => sum + Math.abs(row.delta), 0);
  const refundedCredits = input.refundRows.reduce((sum, row) => sum + Math.abs(row.delta), 0);
  return {
    imageCounts,
    estimatedImageCounts,
    perUserImages,
    creditsSpent: Math.max(0, grossCredits - refundedCredits),
    deliveredImages,
    allowanceImages,
    unattributedImages,
  };
}
