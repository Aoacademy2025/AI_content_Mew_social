import "server-only";

import type { AiGenerationAttempt, AiGenerationJob, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordTelemetryEvent } from "@/lib/telemetry";
import {
  reserveStarterAiImageAllowance,
  settleStarterAiImageAllowance,
  starterAllowanceStatusForWindowInTransaction,
  starterAllowanceStatusInTransaction,
} from "@/lib/starter-ai-image-allowance.server";
import {
  heroVoiceResultFromJob,
  type HeroVoiceGenerationResult,
} from "@/lib/hero-voice-generation.server";
import {
  linkBrandLookPreviewJobInTransaction,
  syncBrandLookPreviewJobInTransaction,
} from "@/lib/brand-look-preview-job-link.server";
import {
  linkVisualBeatAssetInTransaction,
  visualBeatLinkFromImageJob,
} from "@/lib/project-visual-assets.server";
export {
  refundSettledVideoImageBatch,
  refundSettledVideoImageJob,
} from "@/lib/video-image-batch-settlement";

export type PublicAiGenerationJob = {
  id: string;
  kind: string;
  provider: string;
  model: string;
  providerModel: string | null;
  providerRoute: string | null;
  quoteVersion: string | null;
  status: string;
  inputPreview: string | null;
  input: Record<string, unknown> | null;
  voiceResult: HeroVoiceGenerationResult | null;
  outputUrl: string | null;
  creditCost: number;
  fundingSource: string;
  allowanceUnits: number;
  chargeState: string;
  errorCode: string | null;
  errorMessage: string | null;
  delayTimeMs: number | null;
  executionTimeMs: number | null;
  createdAt: string;
  finishedAt: string | null;
  mediaExpiresAt: string | null;
};

export type ImageFundingSnapshot =
  | { fundingSource: "credits" }
  | { fundingSource: "starter_allowance"; windowStartedAt: Date };

function parseInput(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

const LIVE_VIDEO_JOB_STATUSES = ["queued", "processing", "waiting_provider"] as const;

function parentVideoJobIdFromImageKey(idempotencyKey: string | null | undefined): string | null {
  const match = /^video:([^:]+):/.exec(idempotencyKey ?? "");
  return match?.[1]?.trim() || null;
}

/** Lock an existing parent VideoJob and prove it is still live in the same
 * transaction that reserves/settles its child image. Legacy keys whose parent
 * row no longer exists remain supported; a known terminal parent fails closed. */
async function claimLiveParentVideoJob(
  tx: Prisma.TransactionClient,
  userId: string,
  idempotencyKey: string | null | undefined,
): Promise<boolean> {
  const parentId = parentVideoJobIdFromImageKey(idempotencyKey);
  if (!parentId) return true;
  const parent = await tx.videoJob.findFirst({
    where: { id: parentId, userId },
    select: { id: true },
  });
  if (!parent) return true;
  const claimed = await tx.videoJob.updateMany({
    where: {
      id: parentId,
      userId,
      status: { in: [...LIVE_VIDEO_JOB_STATUSES] },
    },
    // This no-op counter update takes the parent row lock. A concurrent cancel
    // then waits until the child reservation commits and its batch sweep can see it.
    data: { reservationRefundAttempts: { increment: 0 } },
  });
  return claimed.count === 1;
}

export function publicAiGenerationJob(job: AiGenerationJob): PublicAiGenerationJob {
  const input = job.kind === "voice"
    ? { voiceId: job.model, backend: job.provider }
    : parseInput(job.inputJson);
  return {
    id: job.id,
    kind: job.kind,
    provider: job.provider,
    model: job.model,
    providerModel: job.providerModel,
    providerRoute: job.providerRoute,
    quoteVersion: job.quoteVersion,
    status: job.status,
    inputPreview: job.inputPreview,
    input,
    voiceResult: heroVoiceResultFromJob(job),
    outputUrl: job.outputUrl,
    creditCost: job.creditCost,
    fundingSource: job.fundingSource,
    allowanceUnits: job.allowanceUnits,
    chargeState: job.chargeState,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    delayTimeMs: job.delayTimeMs,
    executionTimeMs: job.executionTimeMs,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    mediaExpiresAt: job.mediaExpiresAt?.toISOString() ?? null,
  };
}

export async function createReservedImageJob(input: {
  userId: string;
  model: string;
  inputPreview: string;
  inputJson: string;
  creditCost: number;
  quoteVersion: string;
  costBudgetUsdMicros: number;
  provider: string;
  providerModel: string;
  providerRoute: string;
  providerEndpoint: string;
  estimatedCostUsdMicros: number;
  idempotencyKey: string;
  mediaExpiresAt: Date;
  /** Starter allowance belongs only to the Brand Visual activation surface.
   * Every generic/legacy image caller defaults to the shared credit wallet. */
  fundingPolicy?: "credits-only" | "brand-visual-activation";
  /** Durable VideoJob acceptance may pin both funding source and allowance
   * window. This bypasses later plan/rollout re-evaluation, not reservation
   * capacity or the exact-window settlement invariants. */
  fundingSnapshot?: ImageFundingSnapshot;
  /** Final hard-cap guard. The per-user wallet row is locked before counting,
   * so concurrent requests cannot all pass a count-then-create race. */
  dailyRateLimit?: { cap: number; now?: Date };
  reservationLink?: {
    brandLookPreviewItemId: string;
    expectedImageJobId: string | null;
  };
}): Promise<
  | {
      ok: true;
      created: boolean;
      job: AiGenerationJob;
      balanceAfter: number;
      fundingSource: "credits" | "starter_allowance";
      allowanceRemaining: number | null;
    }
  | {
      ok: false;
      reason: "insufficient" | "allowance_exhausted" | "rate_limited" | "parent_terminal";
      balanceAfter: number;
      allowanceRemaining: number | null;
      usedDay?: number;
      retryAfterSec?: number;
    }
> {
  if (input.estimatedCostUsdMicros > input.costBudgetUsdMicros) {
    throw new Error("Image provider route exceeds the quoted COGS budget");
  }
  const result = await prisma.$transaction(async (tx) => {
    if (!await claimLiveParentVideoJob(tx, input.userId, input.idempotencyKey)) {
      const balance = await tx.creditBalance.findUnique({ where: { userId: input.userId } });
      return {
        ok: false as const,
        reason: "parent_terminal" as const,
        balanceAfter: (balance?.granted ?? 0) + (balance?.purchased ?? 0),
        allowanceRemaining: null,
      };
    }
    const existing = await tx.aiGenerationJob.findFirst({
      where: { userId: input.userId, idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      // Fail closed if the key was already claimed by another KIND of generation. The
      // replay short-circuit exists so a retried image request reuses its own paid
      // reservation; adopting, say, a voice row would hand back a job that never
      // debited image credits — a free image. Only reachable if some caller-minted key
      // leaked into this namespace, which the per-surface prefixes (`studio:`,
      // `studio-voice:`) already prevent; this is the backstop for the next surface.
      if (existing.kind !== "image") {
        throw new Error("Image reservation key is already claimed by a non-image job");
      }
      const balance = await tx.creditBalance.findUnique({ where: { userId: input.userId } });
      const allowance = existing.fundingSource === "starter_allowance"
        ? existing.allowanceWindowStartedAt
          ? await starterAllowanceStatusForWindowInTransaction(
              tx,
              input.userId,
              existing.allowanceWindowStartedAt,
            )
          : await starterAllowanceStatusInTransaction(tx, input.userId)
        : null;
      if (input.reservationLink) {
        await linkBrandLookPreviewJobInTransaction(tx, {
          userId: input.userId,
          ...input.reservationLink,
          job: existing,
        });
      }
      return {
        ok: true as const,
        created: false,
        job: existing,
        balanceAfter: (balance?.granted ?? 0) + (balance?.purchased ?? 0),
        fundingSource: existing.fundingSource === "starter_allowance" ? "starter_allowance" as const : "credits" as const,
        allowanceRemaining: allowance?.remainingImages ?? null,
      };
    }

    const balance = await tx.creditBalance.upsert({
      where: { userId: input.userId },
      create: { userId: input.userId, granted: 0, purchased: 0 },
      update: {},
    });
    const total = balance.granted + balance.purchased;
    if (input.dailyRateLimit) {
      // SQLite serializes this no-op wallet write; databases with row-level
      // locking serialize only this user's reservations. Count and job insert
      // therefore live behind the same durable per-user lock.
      await tx.creditBalance.update({
        where: { userId: input.userId },
        data: { granted: { increment: 0 } },
      });
      const now = input.dailyRateLimit.now ?? new Date();
      const dayCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const recent = await tx.aiGenerationJob.findMany({
        where: { userId: input.userId, kind: "image", createdAt: { gte: dayCutoff } },
        select: { createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      const cap = Math.max(1, Math.floor(input.dailyRateLimit.cap));
      if (recent.length >= cap) {
        const oldest = recent[0]?.createdAt.getTime() ?? now.getTime();
        return {
          ok: false as const,
          reason: "rate_limited" as const,
          balanceAfter: total,
          allowanceRemaining: null,
          usedDay: recent.length,
          retryAfterSec: Math.max(1, Math.ceil((oldest + 24 * 60 * 60 * 1000 - now.getTime()) / 1000)),
        };
      }
    }
    const allowance = input.fundingSnapshot?.fundingSource === "starter_allowance"
      ? await reserveStarterAiImageAllowance(
          tx,
          input.userId,
          input.fundingSnapshot.windowStartedAt,
        )
      : input.fundingSnapshot?.fundingSource === "credits"
        ? { kind: "credits" as const }
        : input.fundingPolicy === "brand-visual-activation"
          ? await reserveStarterAiImageAllowance(tx, input.userId)
          : { kind: "credits" as const };
    if (allowance.kind === "allowance_exhausted") {
      return {
        ok: false as const,
        reason: "allowance_exhausted" as const,
        balanceAfter: total,
        allowanceRemaining: allowance.status.remainingImages,
      };
    }
    const fundingSource = allowance.kind === "reserved" ? "starter_allowance" as const : "credits" as const;
    let fromGranted = 0;
    let fromPurchased = 0;
    if (fundingSource === "credits") {
      if (total < input.creditCost) {
        return {
          ok: false as const,
          reason: "insufficient" as const,
          balanceAfter: total,
          allowanceRemaining: null,
        };
      }
      fromGranted = Math.min(balance.granted, input.creditCost);
      fromPurchased = input.creditCost - fromGranted;
      const debited = await tx.creditBalance.updateMany({
        where: {
          userId: input.userId,
          granted: { gte: fromGranted },
          purchased: { gte: fromPurchased },
        },
        data: {
          granted: { decrement: fromGranted },
          purchased: { decrement: fromPurchased },
        },
      });
      if (debited.count !== 1) {
        return {
          ok: false as const,
          reason: "insufficient" as const,
          balanceAfter: total,
          allowanceRemaining: null,
        };
      }
    }

    const job = await tx.aiGenerationJob.create({
      data: {
        userId: input.userId,
        kind: "image",
        provider: input.provider,
        model: input.model,
        providerModel: input.providerModel,
        providerRoute: input.providerRoute,
        providerEndpoint: input.providerEndpoint,
        quoteVersion: input.quoteVersion,
        costBudgetUsdMicros: input.costBudgetUsdMicros,
        estimatedCostUsdMicros: input.estimatedCostUsdMicros,
        status: "queued",
        inputPreview: input.inputPreview,
        inputJson: input.inputJson,
        creditCost: input.creditCost,
        creditsFromGranted: fromGranted,
        creditsFromPurchased: fromPurchased,
        fundingSource,
        allowanceUnits: fundingSource === "starter_allowance" ? 1 : 0,
        allowanceWindowStartedAt: allowance.kind === "reserved"
          ? allowance.status.windowStartedAt
          : null,
        chargeState: "reserved",
        idempotencyKey: input.idempotencyKey,
        mediaExpiresAt: input.mediaExpiresAt,
        attempts: {
          create: {
            sequence: 1,
            provider: input.provider,
            providerModel: input.providerModel,
            providerRoute: input.providerRoute,
            providerEndpoint: input.providerEndpoint,
            estimatedCostUsdMicros: input.estimatedCostUsdMicros,
          },
        },
      },
    });
    const balanceAfter = fundingSource === "credits" ? total - input.creditCost : total;
    if (fundingSource === "credits") {
      await tx.creditLedger.create({
        data: {
          userId: input.userId,
          delta: -input.creditCost,
          kind: "spend",
          action: `ai-image:${job.id}`,
          balanceAfter,
        },
      });
    }
    if (input.reservationLink) {
      await linkBrandLookPreviewJobInTransaction(tx, {
        userId: input.userId,
        ...input.reservationLink,
        job,
      });
    }
    return {
      ok: true as const,
      created: true,
      job,
      balanceAfter,
      fundingSource,
      allowanceRemaining: allowance.kind === "reserved" ? allowance.status.remainingImages : null,
    };
  });

  // A rejected reservation creates no AiGenerationJob by design, so without a
  // separate event it is invisible to launch/error audits. Keep the event free
  // of prompts or provider credentials and never let telemetry failure affect
  // the user's credit decision.
  if (!result.ok) {
    const surface = input.idempotencyKey.startsWith("video:")
      ? "video"
      : input.idempotencyKey.startsWith("studio:")
        ? "studio"
        : "other";
    await recordTelemetryEvent(input.userId, {
      name: "ai_image_credit_reservation_rejected",
      category: "error",
      source: "server",
      step: "credit_reservation",
      status: result.reason === "allowance_exhausted"
        ? "allowance_exhausted"
        : result.reason === "rate_limited"
          ? "rate_limited"
          : result.reason === "parent_terminal"
            ? "parent_video_terminal"
          : "insufficient_credits",
      value: input.creditCost,
      properties: {
        requiredCredits: input.creditCost,
        availableCredits: result.balanceAfter,
        allowanceRemaining: result.allowanceRemaining,
        model: input.model,
        provider: input.provider,
        providerRoute: input.providerRoute,
        surface,
        fundingPolicy: input.fundingPolicy ?? "credits-only",
        usedDay: result.usedDay ?? null,
        retryAfterSec: result.retryAfterSec ?? null,
      },
    }).catch((error) => {
      console.error("[ai-image] failed to record credit reservation rejection telemetry:", error);
    });
  }

  return result;
}

export async function latestImageGenerationAttempt(
  userId: string,
  jobId: string,
): Promise<AiGenerationAttempt | null> {
  return prisma.aiGenerationAttempt.findFirst({
    where: { jobId, job: { userId } },
    orderBy: { sequence: "desc" },
  });
}

/**
 * Claim the right to perform the external submission before crossing the
 * network boundary. Concurrent idempotent callers can poll the same durable
 * attempt, but only one may create the provider job.
 */
export async function claimPlannedImageAttemptSubmission(input: {
  userId: string;
  jobId: string;
  sequence: number;
}): Promise<boolean> {
  const claimed = await prisma.aiGenerationAttempt.updateMany({
    where: {
      jobId: input.jobId,
      sequence: input.sequence,
      status: "planned",
      job: {
        userId: input.userId,
        chargeState: "reserved",
        status: { in: ["queued", "in_progress"] },
      },
    },
    data: { status: "submitting" },
  });
  return claimed.count === 1;
}

export async function markImageAttemptSubmitted(input: {
  userId: string;
  jobId: string;
  sequence: number;
  providerJobId: string;
  inProgress: boolean;
}): Promise<AiGenerationJob | null> {
  return prisma.$transaction(async (tx) => {
    const job = await tx.aiGenerationJob.findFirst({ where: { id: input.jobId, userId: input.userId } });
    if (!job) return null;
    const now = new Date();
    await tx.aiGenerationAttempt.updateMany({
      where: {
        jobId: job.id,
        sequence: input.sequence,
        status: { in: ["planned", "submitting"] },
      },
      data: {
        providerJobId: input.providerJobId,
        status: input.inProgress ? "in_progress" : "queued",
        submittedAt: now,
      },
    });
    return tx.aiGenerationJob.update({
      where: { id: job.id },
      data: {
        providerJobId: input.providerJobId,
        status: input.inProgress ? "in_progress" : "queued",
        startedAt: input.inProgress ? (job.startedAt ?? now) : job.startedAt,
      },
    });
  });
}

export async function markImageAttemptProgress(input: {
  userId: string;
  jobId: string;
  sequence: number;
  inProgress: boolean;
  delayTimeMs?: number;
}): Promise<AiGenerationJob | null> {
  return prisma.$transaction(async (tx) => {
    const job = await tx.aiGenerationJob.findFirst({ where: { id: input.jobId, userId: input.userId } });
    if (!job) return null;
    const now = new Date();
    await tx.aiGenerationAttempt.updateMany({
      where: {
        jobId: job.id,
        sequence: input.sequence,
        status: { in: ["submitted", "submitting", "queued", "in_progress"] },
      },
      data: { status: input.inProgress ? "in_progress" : "queued" },
    });
    return tx.aiGenerationJob.update({
      where: { id: job.id },
      data: {
        status: input.inProgress ? "in_progress" : "queued",
        startedAt: input.inProgress ? (job.startedAt ?? now) : job.startedAt,
        delayTimeMs: input.delayTimeMs ?? job.delayTimeMs,
      },
    });
  });
}

/**
 * Replace one confirmed-cancelled same-engine attempt without touching the
 * customer's reservation. The provider/model/endpoint and cost estimate are
 * copied from the canceled attempt, so this cannot become a silent fallback.
 */
export async function replaceCanceledImageAttempt(input: {
  userId: string;
  jobId: string;
  sequence: number;
  providerJobId: string;
  cancellationConfirmed: boolean;
  reason: string;
}): Promise<AiGenerationAttempt | null> {
  if (!input.cancellationConfirmed) return null;
  return prisma.$transaction(async (tx) => {
    const job = await tx.aiGenerationJob.findFirst({
      where: { id: input.jobId, userId: input.userId },
    });
    if (!job || job.kind !== "image" || job.chargeState !== "reserved") return null;
    if (job.status === "completed" || job.status === "failed") return null;

    const attempt = await tx.aiGenerationAttempt.findUnique({
      where: {
        jobId_sequence: {
          jobId: job.id,
          sequence: input.sequence,
        },
      },
    });
    if (
      !attempt
      || attempt.sequence >= 2
      || attempt.providerJobId !== input.providerJobId
      || !["submitted", "queued", "in_progress"].includes(attempt.status)
    ) {
      return null;
    }

    const claimed = await tx.aiGenerationAttempt.updateMany({
      where: {
        id: attempt.id,
        providerJobId: input.providerJobId,
        status: { in: ["submitted", "queued", "in_progress"] },
      },
      data: {
        status: "canceled",
        errorCode: "RUNPOD_QUEUE_TIMEOUT",
        errorMessage: input.reason.slice(0, 500),
        finishedAt: new Date(),
      },
    });
    if (claimed.count !== 1) return null;

    const replacement = await tx.aiGenerationAttempt.create({
      data: {
        jobId: job.id,
        sequence: attempt.sequence + 1,
        provider: attempt.provider,
        providerModel: attempt.providerModel,
        providerRoute: attempt.providerRoute,
        providerEndpoint: attempt.providerEndpoint,
        estimatedCostUsdMicros: attempt.estimatedCostUsdMicros,
      },
    });
    await tx.aiGenerationJob.update({
      where: { id: job.id },
      data: {
        providerJobId: null,
        status: "queued",
        errorCode: null,
        errorMessage: null,
        finishedAt: null,
      },
    });
    return replacement;
  });
}

export async function failAndRefundAiJob(
  userId: string,
  jobId: string,
  errorCode: string,
  errorMessage: string,
): Promise<AiGenerationJob | null> {
  return prisma.$transaction(async (tx) => {
    const job = await tx.aiGenerationJob.findFirst({ where: { id: jobId, userId } });
    if (!job) return null;
    if (job.status === "completed" || job.chargeState === "settled") return job;

    await tx.aiGenerationAttempt.updateMany({
      where: { jobId: job.id, status: { in: ["planned", "submitting", "submitted", "queued", "in_progress"] } },
      data: {
        status: "failed",
        errorCode,
        errorMessage: errorMessage.slice(0, 500),
        finishedAt: new Date(),
      },
    });

    let chargeState = job.chargeState;
    if (job.chargeState === "reserved") {
      if (job.fundingSource === "starter_allowance") {
        if (!job.allowanceWindowStartedAt) {
          throw new Error("Starter allowance job is missing its usage window");
        }
        await settleStarterAiImageAllowance(tx, {
          userId,
          windowStartedAt: job.allowanceWindowStartedAt,
          units: job.allowanceUnits,
          outcome: "refunded",
        });
      } else {
        const restored = await tx.creditBalance.upsert({
          where: { userId },
          create: {
            userId,
            granted: job.creditsFromGranted,
            purchased: job.creditsFromPurchased,
          },
          update: {
            granted: { increment: job.creditsFromGranted },
            purchased: { increment: job.creditsFromPurchased },
          },
        });
        await tx.creditLedger.create({
          data: {
            userId,
            delta: job.creditCost,
            kind: "refund",
            action: `ai-image-refund:${job.id}`,
            balanceAfter: restored.granted + restored.purchased,
          },
        });
      }
      chargeState = "refunded";
    }

    const updated = await tx.aiGenerationJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        chargeState,
        errorCode,
        errorMessage: errorMessage.slice(0, 500),
        finishedAt: new Date(),
      },
    });
    await syncBrandLookPreviewJobInTransaction(tx, updated);
    return updated;
  });
}

export async function completeImageJob(input: {
  userId: string;
  jobId: string;
  outputUrl: string;
  delayTimeMs?: number;
  executionTimeMs?: number;
  providerReportedCostUsdMicros?: number;
  providerReportedCredits?: number;
  sceneTitle?: string;
}): Promise<AiGenerationJob | null> {
  return prisma.$transaction(async (tx) => {
    const job = await tx.aiGenerationJob.findFirst({ where: { id: input.jobId, userId: input.userId } });
    if (!job) return null;
    if (job.status === "completed") return job;
    if (job.status === "failed" || job.chargeState === "refunded") return job;

    if (!await claimLiveParentVideoJob(tx, input.userId, job.idempotencyKey)) {
      const errorCode = "PARENT_VIDEO_TERMINAL";
      const errorMessage = "Parent video is no longer deliverable";
      await tx.aiGenerationAttempt.updateMany({
        where: {
          jobId: job.id,
          status: { in: ["planned", "submitting", "submitted", "queued", "in_progress"] },
        },
        data: { status: "failed", errorCode, errorMessage, finishedAt: new Date() },
      });
      if (job.chargeState === "reserved") {
        if (job.fundingSource === "starter_allowance") {
          if (!job.allowanceWindowStartedAt) {
            throw new Error("Starter allowance job is missing its usage window");
          }
          await settleStarterAiImageAllowance(tx, {
            userId: input.userId,
            windowStartedAt: job.allowanceWindowStartedAt,
            units: job.allowanceUnits,
            outcome: "refunded",
          });
        } else {
          const restored = await tx.creditBalance.upsert({
            where: { userId: input.userId },
            create: {
              userId: input.userId,
              granted: job.creditsFromGranted,
              purchased: job.creditsFromPurchased,
            },
            update: {
              granted: { increment: job.creditsFromGranted },
              purchased: { increment: job.creditsFromPurchased },
            },
          });
          await tx.creditLedger.create({
            data: {
              userId: input.userId,
              delta: job.creditCost,
              kind: "refund",
              action: `ai-image-refund:${job.id}`,
              balanceAfter: restored.granted + restored.purchased,
            },
          });
        }
      }
      return tx.aiGenerationJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          chargeState: job.chargeState === "reserved" ? "refunded" : job.chargeState,
          errorCode,
          errorMessage,
          finishedAt: new Date(),
        },
      });
    }

    const image = await tx.generatedImage.create({
      data: {
        userId: input.userId,
        prompt: job.inputPreview ?? "AI artwork",
        url: input.outputUrl,
        imageModel: job.model,
        sceneTitle: input.sceneTitle?.slice(0, 180) || "AI Studio",
      },
    });
    await tx.aiGenerationAttempt.updateMany({
      where: { jobId: job.id, status: { in: ["submitted", "queued", "in_progress"] } },
      data: {
        status: "completed",
        providerReportedCostUsdMicros: input.providerReportedCostUsdMicros,
        providerReportedCredits: input.providerReportedCredits,
        finishedAt: new Date(),
      },
    });
    if (job.chargeState === "reserved" && job.fundingSource === "starter_allowance") {
      if (!job.allowanceWindowStartedAt) {
        throw new Error("Starter allowance job is missing its usage window");
      }
      await settleStarterAiImageAllowance(tx, {
        userId: input.userId,
        windowStartedAt: job.allowanceWindowStartedAt,
        units: job.allowanceUnits,
        outcome: "completed",
      });
    }
    const updated = await tx.aiGenerationJob.update({
      where: { id: job.id },
      data: {
        status: "completed",
        chargeState: job.chargeState === "reserved" ? "settled" : job.chargeState,
        outputUrl: input.outputUrl,
        generatedImageId: image.id,
        delayTimeMs: input.delayTimeMs,
        executionTimeMs: input.executionTimeMs,
        providerReportedCostUsdMicros: input.providerReportedCostUsdMicros,
        providerReportedCredits: input.providerReportedCredits,
        finishedAt: new Date(),
      },
    });
    const visualBeatLink = visualBeatLinkFromImageJob(job);
    if (visualBeatLink) {
      await linkVisualBeatAssetInTransaction(tx, {
        userId: input.userId,
        beatId: visualBeatLink.beatId,
        outputUrl: input.outputUrl,
        imageJobId: updated.id,
        identityKey: visualBeatLink.identityKey,
      });
    }
    await syncBrandLookPreviewJobInTransaction(tx, updated);
    return updated;
  });
}
