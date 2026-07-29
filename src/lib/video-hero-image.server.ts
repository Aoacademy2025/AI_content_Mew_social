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
  createReservedImageJob,
  failAndRefundAiJob,
  latestImageGenerationAttempt,
  markImageAttemptProgress,
  markImageAttemptSubmitted,
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
  openHeroRunpodCircuit,
  type RunpodTerminalFailure,
} from "@/lib/hero-image-resilience";
import { cancelRunpodImageJob } from "@/lib/runpod-serverless";

const MODEL = AI_IMAGE_MODELS.find((item) => item.id === "z-image-turbo")!;
const TERMINAL_PROVIDER = new Set(["FAILED", "TIMED_OUT", "CANCELLED"]);

export class HeroImageGenerationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INSUFFICIENT_CREDITS"
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
}): Promise<HeroImageGenerationResult> {
  const timeoutMs = Math.max(30_000, Math.min(input.timeoutMs ?? 540_000, 600_000));
  const deadline = Date.now() + timeoutMs;
  const aspectRatio = "9:16" as const;
  const style = input.style ?? "photoreal";
  const { width, height } = dimensionsForAspectRatio(aspectRatio);
  const artworkPrompt = buildArtworkOnlyPrompt(input.prompt, style, {
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
    throw new HeroImageGenerationError(
      `เครดิตไม่พอสำหรับ Hero AI Image ต้องใช้ ${prepared.quote.credits} เครดิตต่อฉาก (คงเหลือ ${reserved.balanceAfter})`,
      "INSUFFICIENT_CREDITS",
      402,
    );
  }

  let job = reserved.job;
  if (job.status === "completed") return completedResult(job);
  if (job.status === "failed" || job.chargeState === "refunded") {
    const providerFailure = classifyRunpodTerminalFailure(job.errorMessage || job.errorCode);
    throw new HeroImageGenerationError(
      job.errorMessage || "งาน Hero AI Image นี้ล้มเหลวแล้ว",
      "PROVIDER_FAILED",
      503,
      providerFailure,
    );
  }

  if (reserved.created) {
    try {
      const submitted = await submitPreparedImageGeneration(prepared, input.userId);
      job = await markImageAttemptSubmitted({
        userId: input.userId,
        jobId: job.id,
        providerJobId: submitted.providerJobId,
        inProgress: submitted.status === "IN_PROGRESS",
      }) ?? job;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "RunPod submission failed";
      const providerFailure = classifyRunpodTerminalFailure(detail);
      if (providerFailure.systemic) openHeroRunpodCircuit(providerFailure.code);
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
  }

  let providerJobId = job.providerJobId;
  while (!providerJobId && Date.now() < deadline - 1_000) {
    await sleep(500);
    job = await prisma.aiGenerationJob.findFirst({ where: { id: job.id, userId: input.userId } }) ?? job;
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
    providerJobId = job.providerJobId;
  }
  if (!providerJobId) {
    await failAndRefundAiJob(input.userId, job.id, "SUBMIT_TIMEOUT", "Provider job id was not recorded");
    throw new HeroImageGenerationError("RunPod ไม่คืนรหัสงานภายในเวลาที่กำหนด เครดิตถูกคืนแล้ว", "PROVIDER_TIMEOUT");
  }

  const durableAttempt = await latestImageGenerationAttempt(input.userId, job.id);
  if (!durableAttempt?.providerJobId) {
    throw new HeroImageGenerationError("ข้อมูล RunPod attempt ของงานไม่ครบ", "PROVIDER_POLL_FAILED");
  }
  const attempt: ImageGenerationAttemptRef = {
    provider: durableAttempt.provider,
    providerModel: durableAttempt.providerModel,
    providerRoute: durableAttempt.providerRoute,
    providerEndpoint: durableAttempt.providerEndpoint,
    providerJobId: durableAttempt.providerJobId,
  };
  const providerEndpoint = attempt.providerEndpoint;
  if (!providerEndpoint) {
    throw new HeroImageGenerationError("ข้อมูล RunPod endpoint ของงานไม่ครบ", "PROVIDER_POLL_FAILED");
  }

  let pollFailures = 0;
  while (Date.now() < deadline - 1_000) {
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
      );
    }

    if (snapshot.status === "IN_QUEUE" || snapshot.status === "IN_PROGRESS") {
      job = await markImageAttemptProgress({
        userId: input.userId,
        jobId: job.id,
        inProgress: snapshot.status === "IN_PROGRESS",
        delayTimeMs: snapshot.delayTimeMs,
      }) ?? job;
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
      if (providerFailure.systemic) openHeroRunpodCircuit(providerFailure.code);
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

  // A scale-to-zero custom worker can exhaust the route's bounded wait. Cancel
  // the exact durable job before refunding; never submit a hidden fallback or
  // duplicate provider attempt.
  const providerFailure: RunpodTerminalFailure = {
    code: "RUNPOD_QUEUE_TIMEOUT",
    systemic: true,
    retryable: true,
  };
  openHeroRunpodCircuit(providerFailure.code);
  const cancelled = await cancelRunpodImageJob(providerEndpoint, providerJobId);
  if (cancelled) {
    await failAndRefundAiJob(
      input.userId,
      job.id,
      providerFailure.code,
      "RunPod image job exceeded the bounded queue wait and was cancelled",
    );
  }
  throw new HeroImageGenerationError(
    cancelled
      ? "Hero AI Image รอ RunPod เกินเวลาที่กำหนด งานเดิมถูกยกเลิกและคืนเครดิตแล้ว"
      : "Hero AI Image รอ RunPod เกินเวลาที่กำหนด ระบบหยุดงานที่เหลือเพื่อตรวจสอบงานเดิม",
    "PROVIDER_TIMEOUT",
    504,
    providerFailure,
  );
}
