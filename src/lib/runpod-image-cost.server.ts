import "server-only";

import { prisma } from "@/lib/prisma";
import { getCostRates } from "@/lib/cost-rates";
import { AI_IMAGE_MODELS } from "@/lib/ai-image-policy";
import { runpodImageModelConfig } from "@/lib/runpod-serverless";
import {
  assessReportedRunpodImageCost,
  assessRunpodImageCost,
  DEFAULT_RUNPOD_IMAGE_COST_HARD_LIMIT_BAHT,
  DEFAULT_RUNPOD_IMAGE_COST_MIN_SAMPLE,
  DEFAULT_RUNPOD_IMAGE_COST_STALE_MS,
  DEFAULT_RUNPOD_IMAGE_COST_TARGET_BAHT,
  type RunpodImageCostPolicy,
  type RunpodImageCostStatus,
} from "@/lib/runpod-image-cost";

const RUNPOD_BILLING_URL = "https://rest.runpod.io/v1/billing/endpoints";
const DEFAULT_COST_WINDOW_DAYS = 7;
const DEFAULT_SYNC_LOOKBACK_HOURS = 72;
const HOUR_MS = 60 * 60_000;

type RunpodBillingRecord = {
  amount?: unknown;
  endpointId?: unknown;
  gpuTypeId?: unknown;
  time?: unknown;
  timeBilledMs?: unknown;
};

export type RunpodImageCostSnapshot = {
  endpointId: string;
  windowStart: string;
  windowEnd: string;
  billedUsd: number;
  billedUsdMicros: number;
  billedTimeMs: number;
  deliveredImages: number;
  bucketCount: number;
  usdThbRate: number;
  targetBahtPerImage: number;
  hardLimitBahtPerImage: number;
  minimumSample: number;
  costBahtPerImage: number | null;
  status: RunpodImageCostStatus;
  admitted: boolean;
  reason: string;
  lastSuccessfulSyncAt: string | null;
};

export type ActiveRunpodImageCostSnapshot = RunpodImageCostSnapshot & {
  providerRoute: "runpod-public" | "runpod-custom";
  costSource: "provider_reported_attempts" | "runpod_billing";
  pricedAttempts: number | null;
  lastCostReportedAt: string | null;
};

export class RunpodImageCostGuardError extends Error {
  readonly code = "RUNPOD_COST_GUARD";
  readonly status = 503;

  constructor(readonly snapshot: RunpodImageCostSnapshot) {
    super(snapshot.reason);
    this.name = "RunpodImageCostGuardError";
  }
}

function requiredEndpointId(explicit?: string): string {
  const endpointId = (
    explicit
    ?? process.env.RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID
    ?? ""
  ).trim();
  if (!endpointId) throw new Error("RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID is required");
  return endpointId;
}

function runpodApiKey(): string {
  const key = (process.env.RUNPOD_API_KEY ?? "").trim();
  if (!key) throw new Error("RUNPOD_API_KEY is required");
  return key;
}

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function costPolicy(): RunpodImageCostPolicy {
  return {
    targetBaht: positiveEnv(
      "HERO_RUNPOD_COST_TARGET_BAHT",
      DEFAULT_RUNPOD_IMAGE_COST_TARGET_BAHT,
    ),
    hardLimitBaht: positiveEnv(
      "HERO_RUNPOD_COST_HARD_LIMIT_BAHT",
      DEFAULT_RUNPOD_IMAGE_COST_HARD_LIMIT_BAHT,
    ),
    minSample: positiveIntEnv(
      "HERO_RUNPOD_COST_MIN_SAMPLE",
      DEFAULT_RUNPOD_IMAGE_COST_MIN_SAMPLE,
    ),
    staleAfterMs: positiveIntEnv(
      "HERO_RUNPOD_COST_STALE_MS",
      DEFAULT_RUNPOD_IMAGE_COST_STALE_MS,
    ),
  };
}

function floorToHour(date: Date): Date {
  return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);
}

function parseBillingRecord(
  raw: RunpodBillingRecord,
  expectedEndpointId: string,
): {
  endpointId: string;
  bucketStart: Date;
  gpuTypeId: string;
  amountUsdMicros: number;
  timeBilledMs: number;
} {
  const endpointId = typeof raw.endpointId === "string" && raw.endpointId.trim()
    ? raw.endpointId.trim()
    : expectedEndpointId;
  if (endpointId !== expectedEndpointId) {
    throw new Error("RunPod billing response included an unexpected endpoint");
  }
  const bucketStart = new Date(typeof raw.time === "string" ? raw.time : "");
  const amount = Number(raw.amount);
  const timeBilledMs = Number(raw.timeBilledMs ?? 0);
  if (
    !Number.isFinite(bucketStart.getTime())
    || !Number.isFinite(amount)
    || amount < 0
    || !Number.isFinite(timeBilledMs)
    || timeBilledMs < 0
  ) {
    throw new Error("RunPod billing response included an invalid record");
  }
  return {
    endpointId,
    bucketStart,
    gpuTypeId: typeof raw.gpuTypeId === "string" && raw.gpuTypeId.trim()
      ? raw.gpuTypeId.trim()
      : "unknown",
    amountUsdMicros: Math.round(amount * 1_000_000),
    timeBilledMs: Math.round(timeBilledMs),
  };
}

export async function syncRunpodImageBilling(input: {
  endpointId?: string;
  start?: Date;
  end?: Date;
  fetchImpl?: typeof fetch;
} = {}): Promise<{
  endpointId: string;
  start: string;
  end: string;
  rowsSeen: number;
  billedUsd: number;
  billedTimeMs: number;
}> {
  const endpointId = requiredEndpointId(input.endpointId);
  const end = input.end ?? new Date();
  const start = floorToHour(
    input.start
    ?? new Date(end.getTime() - DEFAULT_SYNC_LOOKBACK_HOURS * HOUR_MS),
  );
  if (!(start < end)) throw new Error("RunPod billing sync window must be positive");

  const url = new URL(RUNPOD_BILLING_URL);
  url.searchParams.set("endpointId", endpointId);
  url.searchParams.set("startTime", start.toISOString());
  url.searchParams.set("endTime", end.toISOString());
  url.searchParams.set("bucketSize", "hour");
  url.searchParams.set("grouping", "gpuTypeId");

  try {
    const response = await (input.fetchImpl ?? fetch)(url, {
      headers: { Authorization: `Bearer ${runpodApiKey()}` },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const detail = body && typeof body === "object" && "error" in body
        ? String((body as { error?: unknown }).error)
        : `HTTP ${response.status}`;
      throw new Error(`RunPod billing request failed: ${detail}`);
    }
    if (!Array.isArray(body)) throw new Error("RunPod billing response must be an array");
    const records = body.map((record) => parseBillingRecord(
      record as RunpodBillingRecord,
      endpointId,
    ));
    const syncedAt = new Date();

    await prisma.$transaction(async (tx) => {
      for (const record of records) {
        await tx.runpodBillingBucket.upsert({
          where: {
            endpointId_bucketStart_gpuTypeId: {
              endpointId: record.endpointId,
              bucketStart: record.bucketStart,
              gpuTypeId: record.gpuTypeId,
            },
          },
          create: record,
          update: {
            amountUsdMicros: record.amountUsdMicros,
            timeBilledMs: record.timeBilledMs,
          },
        });
      }
      await tx.runpodBillingSync.upsert({
        where: { endpointId },
        create: {
          endpointId,
          lastWindowStart: start,
          lastWindowEnd: end,
          lastSuccessAt: syncedAt,
          rowsSeen: records.length,
          lastError: null,
        },
        update: {
          lastWindowStart: start,
          lastWindowEnd: end,
          lastSuccessAt: syncedAt,
          rowsSeen: records.length,
          lastError: null,
        },
      });
    });

    return {
      endpointId,
      start: start.toISOString(),
      end: end.toISOString(),
      rowsSeen: records.length,
      billedUsd: records.reduce((sum, row) => sum + row.amountUsdMicros, 0) / 1_000_000,
      billedTimeMs: records.reduce((sum, row) => sum + row.timeBilledMs, 0),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "RunPod billing sync failed";
    await prisma.runpodBillingSync.upsert({
      where: { endpointId },
      create: {
        endpointId,
        lastWindowStart: start,
        lastWindowEnd: end,
        rowsSeen: 0,
        lastError: message.slice(0, 500),
      },
      update: {
        lastWindowStart: start,
        lastWindowEnd: end,
        lastError: message.slice(0, 500),
      },
    }).catch(() => {});
    throw error;
  }
}

export async function getRunpodImageCostSnapshot(input: {
  endpointId?: string;
  now?: Date;
  windowDays?: number;
} = {}): Promise<RunpodImageCostSnapshot> {
  const endpointId = requiredEndpointId(input.endpointId);
  const now = input.now ?? new Date();
  const windowDays = Math.max(
    1,
    Math.min(30, Math.floor(input.windowDays ?? DEFAULT_COST_WINDOW_DAYS)),
  );
  // The first bucket can include charges before the exact cutoff, which makes
  // the resulting COGS deliberately conservative.
  const windowStart = floorToHour(
    new Date(now.getTime() - windowDays * 24 * HOUR_MS),
  );
  const [billing, deliveredImages, checkpoint, rates] = await Promise.all([
    prisma.runpodBillingBucket.aggregate({
      where: {
        endpointId,
        bucketStart: { gte: windowStart, lt: now },
      },
      _sum: { amountUsdMicros: true, timeBilledMs: true },
      _count: { _all: true },
    }),
    prisma.aiGenerationJob.count({
      where: {
        kind: "image",
        provider: "runpod",
        providerEndpoint: endpointId,
        status: "completed",
        chargeState: "settled",
        finishedAt: { gte: windowStart, lt: now },
      },
    }),
    prisma.runpodBillingSync.findUnique({ where: { endpointId } }),
    getCostRates(),
  ]);
  const billedUsdMicros = billing._sum.amountUsdMicros ?? 0;
  const policy = costPolicy();
  const assessment = assessRunpodImageCost({
    billedUsdMicros,
    deliveredImages,
    usdThbRate: rates.fxBahtPerUsd,
    lastSuccessfulSyncAtMs: checkpoint?.lastSuccessAt?.getTime() ?? null,
    nowMs: now.getTime(),
    policy,
  });

  return {
    endpointId,
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    billedUsd: billedUsdMicros / 1_000_000,
    billedUsdMicros,
    billedTimeMs: billing._sum.timeBilledMs ?? 0,
    deliveredImages,
    bucketCount: billing._count._all,
    usdThbRate: rates.fxBahtPerUsd,
    targetBahtPerImage: policy.targetBaht,
    hardLimitBahtPerImage: policy.hardLimitBaht,
    minimumSample: policy.minSample,
    costBahtPerImage: assessment.costBahtPerImage,
    status: assessment.status,
    admitted: assessment.admitted,
    reason: assessment.reason,
    lastSuccessfulSyncAt: checkpoint?.lastSuccessAt?.toISOString() ?? null,
  };
}

/**
 * Reporting-only COGS for the Z-Image route that new production work is using.
 *
 * The public endpoint reports its price per provider attempt, so the numerator
 * sums every priced attempt (including retries and attempts whose customer
 * charge was later refunded). The denominator intentionally counts only
 * completed, settled image jobs. The custom route retains its invoice-backed
 * billing snapshot and its independent stale-telemetry admission semantics.
 */
export async function getActiveRunpodImageCostSnapshot(input: {
  now?: Date;
  windowDays?: number;
} = {}): Promise<ActiveRunpodImageCostSnapshot> {
  const zImageModel = AI_IMAGE_MODELS.find((model) => model.id === "z-image-turbo");
  if (!zImageModel) throw new Error("Z-Image model configuration is missing");
  const config = runpodImageModelConfig(zImageModel);
  if (!config) throw new Error("The active Z-Image RunPod route is not configured");

  const now = input.now ?? new Date();
  const windowDays = Math.max(
    1,
    Math.min(30, Math.floor(input.windowDays ?? DEFAULT_COST_WINDOW_DAYS)),
  );

  if (config.route === "runpod-custom") {
    const snapshot = await getRunpodImageCostSnapshot({
      endpointId: config.endpointId,
      now,
      windowDays,
    });
    return {
      ...snapshot,
      providerRoute: "runpod-custom",
      costSource: "runpod_billing",
      pricedAttempts: null,
      lastCostReportedAt: snapshot.lastSuccessfulSyncAt,
    };
  }

  const windowStart = new Date(now.getTime() - windowDays * 24 * HOUR_MS);
  const attemptWhere = {
    provider: "runpod",
    providerRoute: "runpod-public",
    providerEndpoint: config.endpointId,
    providerReportedCostUsdMicros: { not: null },
    finishedAt: { gte: windowStart, lt: now },
  } as const;
  const [reported, deliveredImages, latestReport, rates] = await Promise.all([
    prisma.aiGenerationAttempt.aggregate({
      where: attemptWhere,
      _sum: { providerReportedCostUsdMicros: true },
      _count: { _all: true },
    }),
    prisma.aiGenerationJob.count({
      where: {
        kind: "image",
        provider: "runpod",
        providerRoute: "runpod-public",
        providerEndpoint: config.endpointId,
        status: "completed",
        chargeState: "settled",
        finishedAt: { gte: windowStart, lt: now },
      },
    }),
    prisma.aiGenerationAttempt.findFirst({
      where: attemptWhere,
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true },
    }),
    getCostRates(),
  ]);
  const billedUsdMicros = reported._sum.providerReportedCostUsdMicros ?? 0;
  const policy = costPolicy();
  const assessment = assessReportedRunpodImageCost({
    billedUsdMicros,
    deliveredImages,
    usdThbRate: rates.fxBahtPerUsd,
    policy,
  });

  return {
    endpointId: config.endpointId,
    providerRoute: "runpod-public",
    costSource: "provider_reported_attempts",
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    billedUsd: billedUsdMicros / 1_000_000,
    billedUsdMicros,
    billedTimeMs: 0,
    deliveredImages,
    bucketCount: 0,
    pricedAttempts: reported._count._all,
    usdThbRate: rates.fxBahtPerUsd,
    targetBahtPerImage: policy.targetBaht,
    hardLimitBahtPerImage: policy.hardLimitBaht,
    minimumSample: policy.minSample,
    costBahtPerImage: assessment.costBahtPerImage,
    status: assessment.status,
    admitted: assessment.admitted,
    reason: assessment.reason,
    lastSuccessfulSyncAt: null,
    lastCostReportedAt: latestReport?.finishedAt?.toISOString() ?? null,
  };
}

export async function assertRunpodImageCostAdmission(
  endpointId?: string,
): Promise<RunpodImageCostSnapshot> {
  const snapshot = await getRunpodImageCostSnapshot({ endpointId });
  if (!snapshot.admitted) throw new RunpodImageCostGuardError(snapshot);
  return snapshot;
}
