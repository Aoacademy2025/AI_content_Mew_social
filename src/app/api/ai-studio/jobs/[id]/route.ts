import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { AI_IMAGE_MODELS } from "@/lib/ai-image-policy";
import {
  completeImageJob,
  failAndRefundAiJob,
  latestImageGenerationAttempt,
  markImageAttemptProgress,
  publicAiGenerationJob,
} from "@/lib/ai-generation-jobs.server";
import { persistAiGenerationImage } from "@/lib/ai-generation-media.server";
import {
  pollImageGenerationAttempt,
  type ImageGenerationAttemptRef,
} from "@/lib/image-generation-provider.server";
import { runpodImageModelConfig } from "@/lib/runpod-serverless";
import { apiError } from "@/lib/api-error";
import { isInternalAiTester } from "@/lib/internal-ai-access";
import { advanceHeroVoiceGeneration } from "@/lib/hero-voice-generation.server";
import {
  isHeroVoiceCloneCanaryUser,
  isHeroVoiceCloneGenerationJob,
} from "@/lib/omnivoice-policy";
import {
  heroVoiceClonePrivateJson,
  heroVoiceClonePrivateResponse,
} from "@/lib/hero-voice-clone-response.server";
import {
  heroVoiceCloneFailureHttpStatus,
  isHeroVoiceCloneDurableRecord,
  isHeroVoiceCloneTerminalStatus,
  normalizeHeroVoiceClonePublicJob,
} from "@/lib/hero-voice-clone-state";

export const runtime = "nodejs";

const TERMINAL = new Set(["completed", "failed", "canceled"]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser();
    if (!user) return heroVoiceClonePrivateJson({ error: "Unauthorized" }, { status: 401 });
    const { id } = await params;
    let job = await prisma.aiGenerationJob.findFirst({ where: { id, userId: user.id } });
    if (!job) return heroVoiceClonePrivateJson({ error: "Not found" }, { status: 404 });
    if (job.kind === "voice") {
      const cloneCanaryJob = isHeroVoiceCloneGenerationJob(job) || isHeroVoiceCloneDurableRecord(job);
      if (!cloneCanaryJob || !isHeroVoiceCloneCanaryUser(user)) {
        return heroVoiceClonePrivateJson({ error: "Not found" }, { status: 404 });
      }
      const previousStatus = job.status;
      // The durable boundary also reconciles a crash after the at-most-once
      // cancel claim. Calling it for terminal clone rows cannot resubmit work.
      job = await advanceHeroVoiceGeneration(user.id, job.id);
      const failureStatus = heroVoiceCloneFailureHttpStatus(job.errorCode);
      if (!isHeroVoiceCloneTerminalStatus(previousStatus) && failureStatus !== 200) {
        return heroVoiceClonePrivateJson({
          error: job.errorMessage ?? "Hero Voice clone status failed",
          code: job.errorCode,
          retryable: false,
        }, { status: failureStatus });
      }
      return heroVoiceClonePrivateJson({
        job: normalizeHeroVoiceClonePublicJob(publicAiGenerationJob(job)),
      });
    }
    if (!isInternalAiTester(user)) return heroVoiceClonePrivateJson({ error: "Not found" }, { status: 404 });
    if (job.kind !== "image" || TERMINAL.has(job.status)) {
      return heroVoiceClonePrivateJson({ job: publicAiGenerationJob(job) });
    }
    const providerJobId = job.providerJobId;
    if (!providerJobId) {
      const stale = Date.now() - job.createdAt.getTime() > 5 * 60_000;
      if (stale) {
        const failed = await failAndRefundAiJob(user.id, job.id, "SUBMIT_TIMEOUT", "Provider job id was not recorded");
        if (failed) job = failed;
      }
      return heroVoiceClonePrivateJson({ job: publicAiGenerationJob(job) });
    }

    const durableAttempt = await latestImageGenerationAttempt(user.id, job.id);
    let attemptRef: ImageGenerationAttemptRef | null = durableAttempt?.providerJobId ? {
      provider: durableAttempt.provider,
      providerModel: durableAttempt.providerModel,
      providerRoute: durableAttempt.providerRoute,
      providerEndpoint: durableAttempt.providerEndpoint,
      providerJobId: durableAttempt.providerJobId,
    } : null;

    // Backward compatibility for an in-flight job created before provider-attempt
    // accounting was deployed. New jobs always use the durable attempt above.
    if (!attemptRef && job.provider === "runpod") {
      const legacyModelId = job.model;
      const model = AI_IMAGE_MODELS.find((item) => item.id === legacyModelId);
      const providerConfig = model ? runpodImageModelConfig(model) : null;
      if (providerConfig) {
        attemptRef = {
          provider: "runpod",
          providerModel: model!.providerModel,
          providerRoute: providerConfig.route,
          providerEndpoint: providerConfig.endpointId,
          providerJobId,
        };
      }
    }
    if (!attemptRef) {
      return heroVoiceClonePrivateJson({ error: "ข้อมูล provider attempt ของงานนี้ไม่ครบ", retryable: true }, { status: 503 });
    }

    let provider;
    try {
      provider = await pollImageGenerationAttempt(attemptRef);
    } catch (error) {
      console.error(`[ai-studio/job] provider poll failed job=${job.id}:`, error instanceof Error ? error.message : error);
      return heroVoiceClonePrivateJson({ error: "ตรวจสถานะผู้ให้บริการไม่สำเร็จ", retryable: true }, { status: 502 });
    }

    if (provider.status === "IN_QUEUE" || provider.status === "IN_PROGRESS") {
      job = await markImageAttemptProgress({
        userId: user.id,
        jobId: job.id,
        sequence: durableAttempt?.sequence ?? 1,
        inProgress: provider.status === "IN_PROGRESS",
        delayTimeMs: provider.delayTimeMs,
      }) ?? job;
      return heroVoiceClonePrivateJson({ job: publicAiGenerationJob(job) });
    }

    if (provider.status === "COMPLETED") {
      try {
        if (!provider.image) throw new Error("Image provider completed without an image");
        const outputUrl = await persistAiGenerationImage(provider.image);
        job = await completeImageJob({
          userId: user.id,
          jobId: job.id,
          outputUrl,
          delayTimeMs: provider.delayTimeMs,
          executionTimeMs: provider.executionTimeMs,
          providerReportedCostUsdMicros: provider.providerReportedCostUsdMicros,
          providerReportedCredits: provider.providerReportedCredits,
        }) ?? job;
      } catch (error) {
        job = await failAndRefundAiJob(
          user.id,
          job.id,
          "OUTPUT_INVALID",
          error instanceof Error ? error.message : "Runpod output could not be stored",
        ) ?? job;
      }
      return heroVoiceClonePrivateJson({ job: publicAiGenerationJob(job) });
    }

    if (provider.status === "FAILED" || provider.status === "TIMED_OUT" || provider.status === "CANCELLED") {
      job = await failAndRefundAiJob(
        user.id,
        job.id,
        `${attemptRef.provider.toUpperCase()}_${provider.status}`,
        provider.error || `${attemptRef.provider} job ${provider.status.toLowerCase()}`,
      ) ?? job;
      return heroVoiceClonePrivateJson({ job: publicAiGenerationJob(job) });
    }

    return heroVoiceClonePrivateJson({ job: publicAiGenerationJob(job) });
  } catch (error) {
    return heroVoiceClonePrivateResponse(apiError({ route: "ai-studio/jobs/[id]", error }));
  }
}
