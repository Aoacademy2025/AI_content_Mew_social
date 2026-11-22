export const DEFAULT_RUNPOD_IMAGE_COST_TARGET_BAHT = 0.90;
export const DEFAULT_RUNPOD_IMAGE_COST_HARD_LIMIT_BAHT = 1.08;
export const DEFAULT_RUNPOD_IMAGE_COST_MIN_SAMPLE = 20;
export const DEFAULT_RUNPOD_IMAGE_COST_STALE_MS = 3 * 60 * 60_000;

export type RunpodImageCostStatus =
  | "insufficient_data"
  | "healthy"
  | "warning"
  | "hard_stop"
  | "stale";

export type RunpodImageCostPolicy = {
  targetBaht: number;
  hardLimitBaht: number;
  minSample: number;
  staleAfterMs: number;
};

export type RunpodImageCostAssessment = {
  status: RunpodImageCostStatus;
  admitted: boolean;
  costBahtPerImage: number | null;
  sampleEnough: boolean;
  reason: string;
};

function validPositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function normalizeRunpodImageCostPolicy(
  input: Partial<RunpodImageCostPolicy> = {},
): RunpodImageCostPolicy {
  const targetBaht = validPositive(
    input.targetBaht ?? DEFAULT_RUNPOD_IMAGE_COST_TARGET_BAHT,
    DEFAULT_RUNPOD_IMAGE_COST_TARGET_BAHT,
  );
  const hardLimitBaht = Math.max(
    targetBaht,
    validPositive(
      input.hardLimitBaht ?? DEFAULT_RUNPOD_IMAGE_COST_HARD_LIMIT_BAHT,
      DEFAULT_RUNPOD_IMAGE_COST_HARD_LIMIT_BAHT,
    ),
  );
  const minSampleRaw = input.minSample ?? DEFAULT_RUNPOD_IMAGE_COST_MIN_SAMPLE;
  const staleAfterRaw = input.staleAfterMs ?? DEFAULT_RUNPOD_IMAGE_COST_STALE_MS;
  return {
    targetBaht,
    hardLimitBaht,
    minSample: Number.isInteger(minSampleRaw) && minSampleRaw > 0
      ? minSampleRaw
      : DEFAULT_RUNPOD_IMAGE_COST_MIN_SAMPLE,
    staleAfterMs: Number.isFinite(staleAfterRaw) && staleAfterRaw > 0
      ? staleAfterRaw
      : DEFAULT_RUNPOD_IMAGE_COST_STALE_MS,
  };
}

/**
 * Assess fully-loaded provider COGS. "Delivered images" intentionally excludes
 * refunded video batches, while billed USD includes every endpoint charge.
 *
 * A brand-new/low-volume endpoint is allowed to collect a sample in private
 * beta. Once a successful sync exists, stale telemetry fails closed because the
 * hard cost ceiling can no longer be proven.
 */
export function assessRunpodImageCost(input: {
  billedUsdMicros: number;
  deliveredImages: number;
  usdThbRate: number;
  lastSuccessfulSyncAtMs: number | null;
  nowMs?: number;
  policy?: Partial<RunpodImageCostPolicy>;
}): RunpodImageCostAssessment {
  const policy = normalizeRunpodImageCostPolicy(input.policy);
  const nowMs = input.nowMs ?? Date.now();
  const deliveredImages = Math.max(0, Math.floor(input.deliveredImages));
  const billedUsdMicros = Math.max(0, Math.round(input.billedUsdMicros));
  const usdThbRate = validPositive(input.usdThbRate, 36);
  const sampleEnough = deliveredImages >= policy.minSample;
  const hasSuccessfulSync = input.lastSuccessfulSyncAtMs !== null
    && Number.isFinite(input.lastSuccessfulSyncAtMs);
  const stale = hasSuccessfulSync
    && nowMs - input.lastSuccessfulSyncAtMs! > policy.staleAfterMs;
  const costBahtPerImage = deliveredImages > 0
    ? (billedUsdMicros / 1_000_000) * usdThbRate / deliveredImages
    : null;

  if (stale) {
    return {
      status: "stale",
      admitted: false,
      costBahtPerImage,
      sampleEnough,
      reason: "RunPod billing telemetry is stale; new image traffic is paused",
    };
  }
  if (!hasSuccessfulSync || !sampleEnough || billedUsdMicros === 0 || costBahtPerImage === null) {
    return {
      status: "insufficient_data",
      admitted: true,
      costBahtPerImage,
      sampleEnough,
      reason: "Collecting a minimum private-beta billing sample",
    };
  }
  if (costBahtPerImage > policy.hardLimitBaht) {
    return {
      status: "hard_stop",
      admitted: false,
      costBahtPerImage,
      sampleEnough,
      reason: "Fully-loaded RunPod image COGS exceeds the Kie GPT Image 2 ceiling",
    };
  }
  if (costBahtPerImage > policy.targetBaht) {
    return {
      status: "warning",
      admitted: true,
      costBahtPerImage,
      sampleEnough,
      reason: "Fully-loaded RunPod image COGS is above the operating target",
    };
  }
  return {
    status: "healthy",
    admitted: true,
    costBahtPerImage,
    sampleEnough,
    reason: "Fully-loaded RunPod image COGS is within target",
  };
}

/**
 * Assess a pay-per-attempt RunPod route whose cost is reported on each provider
 * attempt. Unlike a private endpoint billing ledger, these rows do not depend
 * on a separate billing sync and therefore must not become "stale" merely
 * because the private-endpoint sync is idle.
 */
export function assessReportedRunpodImageCost(input: {
  billedUsdMicros: number;
  deliveredImages: number;
  usdThbRate: number;
  policy?: Partial<RunpodImageCostPolicy>;
}): RunpodImageCostAssessment {
  const policy = normalizeRunpodImageCostPolicy(input.policy);
  const deliveredImages = Math.max(0, Math.floor(input.deliveredImages));
  const billedUsdMicros = Math.max(0, Math.round(input.billedUsdMicros));
  const usdThbRate = validPositive(input.usdThbRate, 36);
  const sampleEnough = deliveredImages >= policy.minSample;
  const costBahtPerImage = deliveredImages > 0
    ? (billedUsdMicros / 1_000_000) * usdThbRate / deliveredImages
    : null;

  if (!sampleEnough || billedUsdMicros === 0 || costBahtPerImage === null) {
    return {
      status: "insufficient_data",
      admitted: true,
      costBahtPerImage,
      sampleEnough,
      reason: "Collecting a minimum active-route provider cost sample",
    };
  }
  if (costBahtPerImage > policy.hardLimitBaht) {
    return {
      status: "hard_stop",
      admitted: false,
      costBahtPerImage,
      sampleEnough,
      reason: "Fully-loaded RunPod image COGS exceeds the Kie GPT Image 2 ceiling",
    };
  }
  if (costBahtPerImage > policy.targetBaht) {
    return {
      status: "warning",
      admitted: true,
      costBahtPerImage,
      sampleEnough,
      reason: "Fully-loaded RunPod image COGS is above the operating target",
    };
  }
  return {
    status: "healthy",
    admitted: true,
    costBahtPerImage,
    sampleEnough,
    reason: "Fully-loaded RunPod image COGS is within target",
  };
}

function describeErrorCause(cause: unknown, depth = 0): string | null {
  if (!cause || depth > 4) return null;
  if (typeof cause === "string") {
    const trimmed = cause.trim();
    return trimmed || null;
  }
  if (typeof cause !== "object") return null;

  const record = cause as {
    code?: unknown;
    message?: unknown;
    errors?: unknown;
    cause?: unknown;
  };
  const code = typeof record.code === "string" ? record.code.trim() : "";
  const message = cause instanceof Error
    ? cause.message.trim()
    : typeof record.message === "string"
      ? record.message.trim()
      : "";

  if (code && message) {
    return message.includes(code) ? message : `${code}: ${message}`;
  }
  if (code) return code;
  if (message) return message;

  if (Array.isArray(record.errors)) {
    for (const nested of record.errors) {
      const described = describeErrorCause(nested, depth + 1);
      if (described) return described;
    }
  }
  if (record.cause && record.cause !== cause) {
    return describeErrorCause(record.cause, depth + 1);
  }
  return null;
}

export function formatRunpodBillingError(
  error: unknown,
  fallback = "RunPod billing sync failed",
): string {
  if (typeof error === "string") {
    const trimmed = error.trim();
    return trimmed || fallback;
  }
  if (!(error instanceof Error)) return fallback;

  const base = error.message.trim() || fallback;
  const causeDetail = describeErrorCause((error as Error & { cause?: unknown }).cause);
  if (causeDetail && !base.includes(causeDetail)) {
    return `${base} (cause: ${causeDetail})`;
  }
  return base;
}
