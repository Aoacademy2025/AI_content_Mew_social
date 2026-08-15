import { randomInt } from "node:crypto";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import {
  AI_IMAGE_MODELS,
  buildArtworkOnlyPrompt,
  dimensionsForAspectRatio,
  isAiImageAspectRatio,
  isAiImageEngine,
  isAiImageModelId,
  isAiImageStyle,
  previewGenerationInput,
} from "@/lib/ai-image-policy";
import { ensureMonthlyGrant } from "@/lib/credits";
import {
  claimPlannedImageAttemptSubmission,
  createReservedImageJob,
  failAndRefundAiJob,
  markImageAttemptSubmitted,
  publicAiGenerationJob,
} from "@/lib/ai-generation-jobs.server";
import {
  ImageGenerationConfigError,
  prepareImageGeneration,
  submitPreparedImageGeneration,
  type PreparedImageGeneration,
} from "@/lib/image-generation-provider.server";
import { apiError } from "@/lib/api-error";
import { videoExpiryFor } from "@/lib/plan-limits";
import { isInternalAiTester } from "@/lib/internal-ai-access";
import { getRunpodImageCostSnapshot } from "@/lib/runpod-image-cost.server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let reservedJobId: string | null = null;
  let userId: string | null = null;
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isInternalAiTester(user)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    userId = user.id;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const prompt = typeof body?.prompt === "string" ? body.prompt.replace(/\s+/g, " ").trim() : "";
    const modelId = body?.model;
    const engine = body?.engine;
    const aspectRatio = body?.aspectRatio;
    const style = body?.style;
    const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";

    if (prompt.length < 3 || prompt.length > 1_500) {
      return NextResponse.json({ error: "กรุณาใส่รายละเอียดภาพ 3–1,500 ตัวอักษร" }, { status: 400 });
    }
    if (!isAiImageModelId(modelId)
      || !isAiImageEngine(engine)
      || !isAiImageAspectRatio(aspectRatio)
      || !isAiImageStyle(style)) {
      return NextResponse.json({ error: "รูปแบบการสร้างภาพไม่ถูกต้อง" }, { status: 400 });
    }
    if (!/^[A-Za-z0-9:_-]{8,113}$/.test(idempotencyKey)) {
      return NextResponse.json({ error: "idempotencyKey ไม่ถูกต้อง" }, { status: 400 });
    }
    // Namespace the caller-minted key server-side. Without this a Studio caller could
    // mint a `video:<jobId>:…` key and have their image swept by a video-failure
    // compensation sweep (refundSettledVideoImageBatch matches on that prefix).
    // 113 + "studio:" keeps the stored key inside the 120-char contract.
    const storedIdempotencyKey = `studio:${idempotencyKey}`;

    const model = AI_IMAGE_MODELS.find((item) => item.id === modelId)!;
    if (model.engine !== engine) {
      return NextResponse.json({ error: "โมเดลไม่อยู่ใน AI Engine ที่เลือก" }, { status: 400 });
    }
    const { width, height } = dimensionsForAspectRatio(aspectRatio);
    const parsedSeed = typeof body?.seed === "number" ? Math.floor(body.seed) : Number.NaN;
    const seed = Number.isSafeInteger(parsedSeed) && parsedSeed >= 0 && parsedSeed <= 2_147_483_647
      ? parsedSeed
      : randomInt(0, 2_147_483_647);
    const artworkPrompt = buildArtworkOnlyPrompt(prompt, style);
    // Resolve provider + immutable retail quote, then fully prepare the request
    // before credits are reserved. Polling never changes this route later.
    let preparedProviderJob: PreparedImageGeneration;
    try {
      preparedProviderJob = prepareImageGeneration(model, {
        prompt: artworkPrompt.positive,
        // Delivered only on a model whose `negativePromptDelivery` is
        // `workflow-defined`; on an `ignored` model (z-image-turbo, gpt-image-2)
        // the artwork-only invariant rests entirely on the positive prompt.
        negativePrompt: artworkPrompt.negative,
        width,
        height,
        seed,
        aspectRatio,
      });
    } catch (error) {
      if (error instanceof ImageGenerationConfigError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: 503 });
      }
      throw error;
    }

    if (
      preparedProviderJob.provider === "runpod"
      && preparedProviderJob.providerRoute === "runpod-custom"
    ) {
      const runpodCost = await getRunpodImageCostSnapshot({
        endpointId: preparedProviderJob.providerEndpoint,
      });
      if (!runpodCost.admitted) {
        return NextResponse.json({
          error: runpodCost.status === "stale"
            ? "ระบบตรวจสอบต้นทุน RunPod ขาดข้อมูลล่าสุด จึงหยุดงานก่อนหักเครดิต"
            : "ต้นทุน RunPod สูงกว่าเพดานที่กำหนด จึงหยุดงานก่อนหักเครดิต",
          code: "RUNPOD_COST_GUARD",
          retryable: true,
        }, { status: 503 });
      }
    }

    await ensureMonthlyGrant(user.id);
    const creditCost = preparedProviderJob.quote.credits;
    const reserved = await createReservedImageJob({
      userId: user.id,
      model: model.id,
      inputPreview: previewGenerationInput(prompt),
      inputJson: JSON.stringify({ prompt, engine, aspectRatio, style, seed, width, height, artworkOnly: true }),
      creditCost,
      quoteVersion: preparedProviderJob.quote.version,
      costBudgetUsdMicros: preparedProviderJob.quote.costBudgetUsdMicros,
      provider: preparedProviderJob.provider,
      providerModel: preparedProviderJob.providerModel,
      providerRoute: preparedProviderJob.providerRoute,
      providerEndpoint: preparedProviderJob.providerEndpoint,
      estimatedCostUsdMicros: preparedProviderJob.quote.estimatedProviderCostUsdMicros,
      idempotencyKey: storedIdempotencyKey,
      mediaExpiresAt: videoExpiryFor(user.plan),
      productSurface: "ai_studio",
      fundingPolicy: "credits-only",
    });
    if (!reserved.ok) {
      return NextResponse.json({
        error: `เครดิตไม่พอ ต้องใช้ ${creditCost} เครดิต`,
        code: "INSUFFICIENT_CREDITS",
        balance: reserved.balanceAfter,
      }, { status: 402 });
    }
    reservedJobId = reserved.job.id;
    if (!reserved.created) {
      return NextResponse.json({ job: publicAiGenerationJob(reserved.job), balance: reserved.balanceAfter }, { status: 202 });
    }

    try {
      const claimed = await claimPlannedImageAttemptSubmission({
        userId: user.id,
        jobId: reserved.job.id,
        sequence: 1,
      });
      if (!claimed) {
        return NextResponse.json({
          job: publicAiGenerationJob(reserved.job),
          balance: reserved.balanceAfter,
        }, { status: 202 });
      }
      const submitted = await submitPreparedImageGeneration(preparedProviderJob, user.id);
      const job = await markImageAttemptSubmitted({
        userId: user.id,
        jobId: reserved.job.id,
        sequence: 1,
        providerJobId: submitted.providerJobId,
        inProgress: submitted.status === "IN_PROGRESS",
      });
      if (!job) throw new Error("Reserved image job disappeared before provider submission was recorded");
      return NextResponse.json({ job: publicAiGenerationJob(job), balance: reserved.balanceAfter }, { status: 202 });
    } catch (error) {
      const failed = await failAndRefundAiJob(
        user.id,
        reserved.job.id,
        error instanceof ImageGenerationConfigError ? error.code : "PROVIDER_SUBMIT_FAILED",
        error instanceof Error ? error.message : "Image provider submission failed",
      );
      return NextResponse.json({
        error: "ส่งงานสร้างภาพไม่สำเร็จ เครดิตถูกคืนแล้ว",
        job: failed ? publicAiGenerationJob(failed) : null,
      }, { status: 503 });
    }
  } catch (error) {
    if (reservedJobId && userId) {
      await failAndRefundAiJob(
        userId,
        reservedJobId,
        "SUBMIT_CRASH",
        error instanceof Error ? error.message : "Unexpected image submission failure",
      ).catch(() => {});
    }
    return apiError({ route: "ai-studio/images", error });
  }
}
