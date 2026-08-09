import "server-only";

import { createHash } from "node:crypto";
import type { AiGenerationJob } from "@prisma/client";
import {
  AI_IMAGE_MODELS,
  buildArtworkOnlyPrompt,
  dimensionsForAspectRatio,
  previewGenerationInput,
  type AiImageStyle,
} from "@/lib/ai-image-policy";
import { ensureMonthlyGrant } from "@/lib/credits";
import { videoExpiryFor } from "@/lib/plan-limits";
import { prisma } from "@/lib/prisma";
import {
  completeImageJob,
  claimPlannedImageAttemptSubmission,
  createReservedImageJob,
  failAndRefundAiJob,
  latestImageGenerationAttempt,
  markImageAttemptProgress,
  markImageAttemptSubmitted,
  replaceCanceledImageAttempt,
} from "@/lib/ai-generation-jobs.server";
import { persistAiGenerationImage } from "@/lib/ai-generation-media.server";
import {
  ImageGenerationConfigError,
  describeImageOffer,
  pollImageGenerationAttempt,
  prepareImageGeneration,
  submitPreparedImageGeneration,
  type ImageGenerationAttemptRef,
} from "@/lib/image-generation-provider.server";
import {
  classifyRunpodTerminalFailure,
  DEFAULT_HERO_RUNPOD_ORPHAN_QUEUE_MS,
  recordHeroRunpodFailure,
  recordHeroRunpodSuccess,
  shouldRetryQueuedRunpodJob,
  type RunpodTerminalFailure,
} from "@/lib/hero-image-resilience";
import {
  cancelRunpodImageJob,
  getRunpodEndpointHealth,
} from "@/lib/runpod-serverless";
import { resolveProjectVisualPromptForVideoScene } from "@/lib/project-look.server";
import { recordVisualBeatAsset } from "@/lib/content-preflight.server";
import type { CompiledBrandVisualPrompt } from "@/lib/brand-visual-system";
import { decideBrandVisualAccess } from "@/lib/brand-visual-rollout.server";

const MODEL = AI_IMAGE_MODELS.find((item) => item.id === "z-image-turbo")!;
const TERMINAL_PROVIDER = new Set(["FAILED", "TIMED_OUT", "CANCELLED"]);

export class HeroImageGenerationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INSUFFICIENT_CREDITS"
      | "ALLOWANCE_EXHAUSTED"
      | "NOT_CONFIGURED"
      | "PROVIDER_FAILED"
      | "PROVIDER_POLL_FAILED"
      | "PROVIDER_TIMEOUT"
      | "OUTPUT_INVALID",
    readonly status = 503,
    readonly providerFailure?: RunpodTerminalFailure,
  ) {
    super(message);
    this.name = "HeroImageGenerationError";
  }
}

export function describeHeroImageOffer() {
  return describeImageOffer(MODEL);
}

export type HeroImageGenerationResult = {
  jobId: string;
  outputUrl: string;
  creditCost: number;
  fundingSource: string;
  allowanceUnits: number;
  creditsFromGranted: number;
  creditsFromPurchased: number;
  provider: "runpod";
  providerModel: "z-image-turbo";
  providerRoute: string | null;
  providerJobId: string | null;
  delayTimeMs: number | null;
  executionTimeMs: number | null;
  providerReportedCostUsdMicros: number | null;
};

function deterministicSeed(idempotencyKey: string): number {
  const digest = createHash("sha256").update(idempotencyKey).digest();
  return digest.readUInt32BE(0) & 0x7fffffff;
}

function completedResult(job: AiGenerationJob): HeroImageGenerationResult {
  if (!job.outputUrl) throw new HeroImageGenerationError("งานภาพเสร็จแต่ไม่พบไฟล์ผลลัพธ์", "OUTPUT_INVALID");
  return {
    jobId: job.id,
    outputUrl: job.outputUrl,
    creditCost: job.creditCost,
    fundingSource: job.fundingSource,
    allowanceUnits: job.allowanceUnits,
    creditsFromGranted: job.creditsFromGranted,
    creditsFromPurchased: job.creditsFromPurchased,
    provider: "runpod",
    providerModel: "z-image-turbo",
    providerRoute: job.providerRoute,
    providerJobId: job.providerJobId,
    delayTimeMs: job.delayTimeMs,
    executionTimeMs: job.executionTimeMs,
    providerReportedCostUsdMicros: job.providerReportedCostUsdMicros,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Durable, idempotent Hero AI Image generation for one Video Editor scene.
 * This seam is RunPod-only by contract: it never imports or invokes KIE and it
 * never changes provider/model after credits have been quoted and reserved.
 */
export async function generateHeroImageForVideo(input: {
  userId: string;
  plan: string;
  prompt: string;
  idempotencyKey: string;
  videoJobId: string;
  sceneIndex: number;
  sceneTitle?: string;
  style?: AiImageStyle;
  interfaceExpected?: boolean;
  timeoutMs?: number;
  brandVisualPrompt?: {
    source: "project-look" | "brand-revision" | "suggested";
    compiled: CompiledBrandVisualPrompt;
    visualBeatId?: string;
    identityKey?: string;
  };
}): Promise<HeroImageGenerationResult> {
  // The verified private BF16 image needs about ten minutes for a completely
  // fresh 28 GB pull, while FlashBoot revivals complete in seconds. Keep the
  // wait bounded above the worker's 800-second initialization ceiling so the
  // exact provider job can still be cancelled and refunded on exhaustion.
  const timeoutMs = Math.max(30_000, Math.min(input.timeoutMs ?? 840_000, 900_000));
  const configuredOrphanQueueMs = Number(process.env.HERO_RUNPOD_ORPHAN_QUEUE_MS);
  const orphanQueueMs = Number.isFinite(configuredOrphanQueueMs)
    ? Math.max(30_000, Math.min(timeoutMs, Math.floor(configuredOrphanQueueMs)))
    : DEFAULT_HERO_RUNPOD_ORPHAN_QUEUE_MS;
  const aspectRatio = "9:16" as const;
  const style = input.style ?? "photoreal";
  const { width, height } = dimensionsForAspectRatio(aspectRatio);
  const projectVisual = input.brandVisualPrompt ?? await resolveProjectVisualPromptForVideoScene({
    userId: input.userId,
    videoJobId: input.videoJobId,
    sceneIndex: input.sceneIndex,
  });
  const brandVisualActor = projectVisual
    ? await prisma.user.findUnique({
        where: { id: input.userId },
        select: { id: true, email: true, role: true, createdAt: true },
      })
    : null;
  const brandVisualAccess = brandVisualActor
    ? decideBrandVisualAccess(brandVisualActor)
    : null;
  // This is the exact provider-neutral prompt contract that passed the
  // 21-image gate. Appending the legacy photoreal preset would overwrite a
  // creator-selected comic, marker or retro format.
  const artworkPrompt = projectVisual
    ? {
        positive: projectVisual.compiled.positive,
        negative: projectVisual.compiled.negative,
      }
    : buildArtworkOnlyPrompt(input.prompt, style, {
        interfaceExpected: input.interfaceExpected,
      });
  let prepared;
  try {
    prepared = prepareImageGeneration(MODEL, {
      prompt: artworkPrompt.positive,
      negativePrompt: artworkPrompt.negative,
      width,
      height,
      seed: deterministicSeed(input.idempotencyKey),
      aspectRatio,
    });
  } catch (error) {
    throw new HeroImageGenerationError(
      error instanceof Error ? error.message : "Hero AI Image ยังไม่ได้เชื่อม RunPod",
      "NOT_CONFIGURED",
    );
  }
  if (prepared.provider !== "runpod" || prepared.providerRoute !== "runpod-custom") {
    throw new HeroImageGenerationError(
      "Hero AI Image ต้องใช้ RunPod custom endpoint ที่ผ่านการตรวจสอบ จึงหยุดงานก่อนหักเครดิต",
      "NOT_CONFIGURED",
    );
  }

  await ensureMonthlyGrant(input.userId);
  const reserved = await createReservedImageJob({
    userId: input.userId,
    model: MODEL.id,
    inputPreview: previewGenerationInput(input.prompt),
    inputJson: JSON.stringify({
      engine: "runpod",
      aspectRatio,
      style,
      width,
      height,
      artworkOnly: true,
      videoJobId: input.videoJobId,
      sceneIndex: input.sceneIndex,
      interfaceExpected: input.interfaceExpected === true,
      brandVisualSource: projectVisual?.source ?? null,
      visualFormatId: projectVisual?.compiled.visualFormatId ?? null,
      visualRecipeVersion: projectVisual?.compiled.recipeVersion ?? null,
      visualBeatId: projectVisual?.visualBeatId ?? null,
      brandVisualIdentityKey: projectVisual?.identityKey ?? null,
      brandVisualCohort: brandVisualAccess?.cohort ?? null,
      brandVisualRolloutBucket: brandVisualAccess?.bucket ?? null,
    }),
    creditCost: prepared.quote.credits,
    quoteVersion: prepared.quote.version,
    costBudgetUsdMicros: prepared.quote.costBudgetUsdMicros,
    provider: prepared.provider,
    providerModel: prepared.providerModel,
    providerRoute: prepared.providerRoute,
    providerEndpoint: prepared.providerEndpoint,
    estimatedCostUsdMicros: prepared.quote.estimatedProviderCostUsdMicros,
    idempotencyKey: input.idempotencyKey,
    mediaExpiresAt: videoExpiryFor(input.plan),
  });
  if (!reserved.ok) {
    if (reserved.reason === "allowance_exhausted") {
      throw new HeroImageGenerationError(
        "ใช้สิทธิ์ทดลองภาพ AI ครบ 8 ภาพในรอบนี้แล้ว อัปเกรดเพื่อสร้างต่อหรือเปลี่ยนไปใช้ Stock ฟรี",
        "ALLOWANCE_EXHAUSTED",
        402,
      );
    }
    throw new HeroImageGenerationError(
      `เครดิตไม่พอสำหรับ Hero AI Image ต้องใช้ ${prepared.quote.credits} เครดิตต่อฉาก (คงเหลือ ${reserved.balanceAfter})`,
      "INSUFFICIENT_CREDITS",
      402,
    );
  }

  let job = reserved.job;
  if (job.status === "completed") {
    if (projectVisual?.visualBeatId && job.outputUrl) {
      await recordVisualBeatAsset({
        userId: input.userId,
        beatId: projectVisual.visualBeatId,
        outputUrl: job.outputUrl,
        imageJobId: job.id,
      }).catch((error) => console.error("[brand-visual] failed to attach replayed image:", error));
    }
    return completedResult(job);
  }
  if (job.status === "failed" || job.chargeState === "refunded") {
    const providerFailure = classifyRunpodTerminalFailure(job.errorMessage || job.errorCode);
    throw new HeroImageGenerationError(
      job.errorMessage || "งาน Hero AI Image นี้ล้มเหลวแล้ว",
      "PROVIDER_FAILED",
      503,
      providerFailure,
    );
  }

  let sequenceToSubmit = reserved.created ? 1 : null;

  // At most two durable submissions of the exact same prepared request. Credits
  // stay reserved across the retry and are settled/refunded exactly once.
  while (true) {
    if (sequenceToSubmit !== null) {
      const claimed = await claimPlannedImageAttemptSubmission({
        userId: input.userId,
        jobId: job.id,
        sequence: sequenceToSubmit,
      });
      if (!claimed) {
        sequenceToSubmit = null;
        continue;
      }
      try {
        const submitted = await submitPreparedImageGeneration(prepared, input.userId);
        job = await markImageAttemptSubmitted({
          userId: input.userId,
          jobId: job.id,
          sequence: sequenceToSubmit,
          providerJobId: submitted.providerJobId,
          inProgress: submitted.status === "IN_PROGRESS",
        }) ?? job;
      } catch (error) {
        const detail = error instanceof Error ? error.message : "RunPod submission failed";
        const providerFailure = classifyRunpodTerminalFailure(detail);
        if (providerFailure.systemic) {
          recordHeroRunpodFailure(providerFailure.code, job.id);
        }
        await failAndRefundAiJob(
          input.userId,
          job.id,
          error instanceof ImageGenerationConfigError ? error.code : providerFailure.code,
          detail,
        );
        throw new HeroImageGenerationError(
          "ส่งงาน Hero AI Image ไป RunPod ไม่สำเร็จ เครดิตถูกคืนแล้ว",
          "PROVIDER_FAILED",
          503,
          providerFailure,
        );
      }
      sequenceToSubmit = null;
    }

    const attemptDeadline = Date.now() + timeoutMs;
    let durableAttempt = await latestImageGenerationAttempt(input.userId, job.id);
    let providerJobId = durableAttempt?.providerJobId ?? job.providerJobId;
    while (!providerJobId && Date.now() < attemptDeadline - 1_000) {
      await sleep(500);
      job = await prisma.aiGenerationJob.findFirst({
        where: { id: job.id, userId: input.userId },
      }) ?? job;
      if (job.status === "completed") return completedResult(job);
      if (job.status === "failed") {
        const providerFailure = classifyRunpodTerminalFailure(job.errorMessage || job.errorCode);
        throw new HeroImageGenerationError(
          job.errorMessage || "Hero AI Image ล้มเหลว",
          "PROVIDER_FAILED",
          503,
          providerFailure,
        );
      }
      durableAttempt = await latestImageGenerationAttempt(input.userId, job.id);
      providerJobId = durableAttempt?.providerJobId ?? job.providerJobId;
    }
    if (!providerJobId || !durableAttempt) {
      // An external submission without a durable provider id cannot be safely
      // canceled or duplicated. Keep the reservation for reconciliation.
      throw new HeroImageGenerationError(
        "RunPod ไม่คืนรหัสงานที่ตรวจสอบได้ ระบบพักงานนี้ไว้เพื่อป้องกันการสร้างหรือคืนเงินซ้ำ",
        "PROVIDER_POLL_FAILED",
        503,
        {
          code: "RUNPOD_FAILED",
          systemic: false,
          retryable: true,
          stopBatch: true,
        },
      );
    }

    const attempt: ImageGenerationAttemptRef = {
      provider: durableAttempt.provider,
      providerModel: durableAttempt.providerModel,
      providerRoute: durableAttempt.providerRoute,
      providerEndpoint: durableAttempt.providerEndpoint,
      providerJobId,
    };
    const providerEndpoint = attempt.providerEndpoint;
    if (!providerEndpoint) {
      throw new HeroImageGenerationError("ข้อมูล RunPod endpoint ของงานไม่ครบ", "PROVIDER_POLL_FAILED");
    }

    let pollFailures = 0;
    let lastProviderStatus = durableAttempt.status === "in_progress" ? "IN_PROGRESS" : "IN_QUEUE";
    let lastHealthCheckAt = 0;
    let replacementSequence: number | null = null;

    while (Date.now() < attemptDeadline - 1_000) {
      await sleep(1_000);
      let snapshot;
      try {
        snapshot = await pollImageGenerationAttempt(attempt);
        pollFailures = 0;
      } catch (error) {
        pollFailures += 1;
        if (pollFailures < 5) continue;
        // Keep the reservation and provider id durable: a temporary status outage
        // must not refund work that RunPod may already have completed.
        throw new HeroImageGenerationError(
          error instanceof Error ? error.message : "ตรวจสถานะ RunPod ไม่สำเร็จ",
          "PROVIDER_POLL_FAILED",
          503,
          {
            code: "RUNPOD_FAILED",
            systemic: false,
            retryable: true,
            stopBatch: true,
          },
        );
      }
      lastProviderStatus = snapshot.status;

      if (snapshot.status === "IN_QUEUE" || snapshot.status === "IN_PROGRESS") {
        job = await markImageAttemptProgress({
          userId: input.userId,
          jobId: job.id,
          sequence: durableAttempt.sequence,
          inProgress: snapshot.status === "IN_PROGRESS",
          delayTimeMs: snapshot.delayTimeMs,
        }) ?? job;

        const queuedMs = snapshot.status === "IN_QUEUE"
          ? Math.max(
              snapshot.delayTimeMs ?? 0,
              Date.now() - (durableAttempt.submittedAt?.getTime() ?? Date.now()),
            )
          : 0;
        if (
          snapshot.status === "IN_QUEUE"
          && durableAttempt.sequence < 2
          && queuedMs >= orphanQueueMs
          && Date.now() - lastHealthCheckAt >= 15_000
        ) {
          lastHealthCheckAt = Date.now();
          const health = await getRunpodEndpointHealth(providerEndpoint).catch(() => null);
          if (health && shouldRetryQueuedRunpodJob({ queuedMs, health, orphanQueueMs })) {
            const cancelled = await cancelRunpodImageJob(providerEndpoint, providerJobId);
            if (!cancelled) {
              throw new HeroImageGenerationError(
                "RunPod ค้างในคิวและยังยืนยันการยกเลิกงานเดิมไม่ได้ ระบบพักงานนี้เพื่อป้องกันงานซ้ำ",
                "PROVIDER_TIMEOUT",
                504,
                {
                  code: "RUNPOD_QUEUE_TIMEOUT",
                  systemic: false,
                  retryable: true,
                  stopBatch: true,
                },
              );
            }
            recordHeroRunpodFailure("RUNPOD_QUEUE_TIMEOUT", job.id);
            const replacement = await replaceCanceledImageAttempt({
              userId: input.userId,
              jobId: job.id,
              sequence: durableAttempt.sequence,
              providerJobId,
              cancellationConfirmed: true,
              reason: "RunPod reported an idle worker while this job remained queued",
            });
            if (replacement) {
              replacementSequence = replacement.sequence;
              break;
            }
            const concurrentReplacement = await latestImageGenerationAttempt(input.userId, job.id);
            if (concurrentReplacement && concurrentReplacement.sequence > durableAttempt.sequence) {
              replacementSequence = concurrentReplacement.sequence;
              break;
            }
          }
        }
        continue;
      }
      if (snapshot.status === "COMPLETED") {
        try {
          if (!snapshot.image) throw new Error("RunPod completed without an image");
          const outputUrl = await persistAiGenerationImage(snapshot.image);
          job = await completeImageJob({
            userId: input.userId,
            jobId: job.id,
            outputUrl,
            delayTimeMs: snapshot.delayTimeMs,
            executionTimeMs: snapshot.executionTimeMs,
            providerReportedCostUsdMicros: snapshot.providerReportedCostUsdMicros,
            providerReportedCredits: snapshot.providerReportedCredits,
            sceneTitle: input.sceneTitle || `Video ${input.videoJobId} · scene ${input.sceneIndex + 1}`,
          }) ?? job;
          if (projectVisual?.visualBeatId && job.outputUrl) {
            await recordVisualBeatAsset({
              userId: input.userId,
              beatId: projectVisual.visualBeatId,
              outputUrl: job.outputUrl,
              imageJobId: job.id,
            }).catch((error) => console.error("[brand-visual] failed to attach generated image:", error));
          }
          recordHeroRunpodSuccess();
          return completedResult(job);
        } catch (error) {
          await failAndRefundAiJob(
            input.userId,
            job.id,
            "OUTPUT_INVALID",
            error instanceof Error ? error.message : "RunPod output could not be stored",
          );
          throw new HeroImageGenerationError("บันทึกภาพจาก RunPod ไม่สำเร็จ เครดิตถูกคืนแล้ว", "OUTPUT_INVALID");
        }
      }
      if (TERMINAL_PROVIDER.has(snapshot.status)) {
        const providerFailure = classifyRunpodTerminalFailure(snapshot.error);
        if (providerFailure.systemic) {
          recordHeroRunpodFailure(providerFailure.code, job.id);
        }
        await failAndRefundAiJob(
          input.userId,
          job.id,
          providerFailure.code === "RUNPOD_FAILED"
            ? `RUNPOD_${snapshot.status}`
            : providerFailure.code,
          snapshot.error || `RunPod job ${snapshot.status.toLowerCase()}`,
        );
        throw new HeroImageGenerationError(
          "RunPod สร้างภาพไม่สำเร็จ เครดิตถูกคืนแล้ว",
          "PROVIDER_FAILED",
          503,
          providerFailure,
        );
      }
    }

    if (replacementSequence !== null) {
      sequenceToSubmit = replacementSequence;
      continue;
    }

    const queueTimedOut = lastProviderStatus === "IN_QUEUE";
    const cancelled = await cancelRunpodImageJob(providerEndpoint, providerJobId);
    if (
      queueTimedOut
      && durableAttempt.sequence < 2
      && cancelled
    ) {
      recordHeroRunpodFailure("RUNPOD_QUEUE_TIMEOUT", job.id);
      const replacement = await replaceCanceledImageAttempt({
        userId: input.userId,
        jobId: job.id,
        sequence: durableAttempt.sequence,
        providerJobId,
        cancellationConfirmed: true,
        reason: "RunPod image job exceeded the bounded queue wait",
      });
      if (replacement) {
        sequenceToSubmit = replacement.sequence;
        continue;
      }
      const concurrentReplacement = await latestImageGenerationAttempt(input.userId, job.id);
      if (concurrentReplacement && concurrentReplacement.sequence > durableAttempt.sequence) {
        sequenceToSubmit = concurrentReplacement.sequence;
        continue;
      }
    }

    const signal = queueTimedOut
      ? recordHeroRunpodFailure("RUNPOD_QUEUE_TIMEOUT", job.id)
      : { circuitOpened: false };
    const providerFailure: RunpodTerminalFailure = queueTimedOut
      ? {
          code: "RUNPOD_QUEUE_TIMEOUT",
          systemic: signal.circuitOpened,
          retryable: true,
          stopBatch: true,
        }
      : {
          code: "RUNPOD_FAILED",
          systemic: false,
          retryable: true,
          stopBatch: true,
        };
    if (cancelled) {
      await failAndRefundAiJob(
        input.userId,
        job.id,
        providerFailure.code,
        queueTimedOut
          ? "RunPod image job exceeded the bounded queue wait and both same-engine attempts were exhausted"
          : "RunPod image job exceeded the bounded execution wait and was cancelled",
      );
    }
    throw new HeroImageGenerationError(
      cancelled
        ? "Hero AI Image รอ RunPod เกินเวลาที่กำหนด งานเดิมถูกยกเลิกและคืนเครดิตแล้ว"
        : "Hero AI Image เกินเวลาที่กำหนดแต่ยังยืนยันการยกเลิกไม่ได้ ระบบพักงานนี้เพื่อป้องกันงานซ้ำ",
      "PROVIDER_TIMEOUT",
      504,
      providerFailure,
    );
  }
}
