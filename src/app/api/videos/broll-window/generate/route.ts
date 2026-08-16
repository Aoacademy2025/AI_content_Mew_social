import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import {
  applyKenBurns,
  downloadAndCrop,
  isValidMp4Path,
  normalizedMarkerPath,
  safeUnlink,
} from "@/lib/broll-asset-lib";
import { parseHeroBrollWindowRequest } from "@/lib/broll-window-hero";
import { HERO_AI_IMAGE_CREDITS } from "@/lib/credit-costs";
import { getBalance } from "@/lib/credits";
import { checkHeroImageRate, heroImageRateLimitMessage } from "@/lib/hero-image-rate-limit";
import { isHeroRunpodRoute, usesCustomRunpodEndpoint } from "@/lib/hero-image-route-policy";
import { getRunpodImageCostSnapshot } from "@/lib/runpod-image-cost.server";
import { resolveBrandVisualAccess } from "@/lib/brand-visual-rollout.server";
import {
  parseBrandVisualJobAcceptance,
  prepareBrandVisualJobAcceptance,
  resolveBrandVisualRenderAccess,
} from "@/lib/brand-visual-job-acceptance.server";
import { parseProjectVisualContext, resolveProjectVisualPromptForVideoScene } from "@/lib/project-look.server";
import { resolveSceneRerollCapability } from "@/lib/scene-reroll-capability";
import { recordVisualBeatAsset } from "@/lib/content-preflight.server";
import { getStarterAiImageAllowanceStatus } from "@/lib/starter-ai-image-allowance.server";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { reusableProjectVisualAssets } from "@/lib/project-visual-assets.server";
import {
  describeHeroImageOffer,
  generateHeroImageForVideo,
  HeroImageGenerationError,
  type HeroImageGenerationResult,
} from "@/lib/video-hero-image.server";
import { refundSettledVideoImageJob } from "@/lib/video-image-batch-settlement";

// POST /api/videos/broll-window/generate — regenerate one existing B-roll
// window through the same RunPod-only Hero AI Image product used by new videos.
// Browser-supplied model/provider fields are intentionally ignored: this route
// never reads a KIE key and cannot cross-fallback to Cloud API.
export const runtime = "nodejs";
export const maxDuration = 900;

async function copyOwnedHeroImage(outputUrl: string, imagePath: string): Promise<void> {
  if (!outputUrl.startsWith("/api/renders/")) {
    await downloadAndCrop(outputUrl, imagePath);
    return;
  }
  const filename = decodeURIComponent(outputUrl.slice("/api/renders/".length));
  if (!filename || path.basename(filename) !== filename) {
    throw new Error("invalid local Hero image path");
  }
  const sourcePath = path.join(process.cwd(), "public", "renders", filename);
  if (!fs.existsSync(sourcePath)) throw new Error("persisted Hero image is missing");
  fs.copyFileSync(sourcePath, imagePath);
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const parsed = parseHeroBrollWindowRequest(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error, message: parsed.message },
      { status: 400 },
    );
  }
  const input = parsed.value;

  const sourceJob = await prisma.videoJob.findFirst({
    where: { id: input.videoJobId, userId: user.id },
    select: {
      status: true,
      projectId: true,
      contentPreflightId: true,
      projectVisualContextJson: true,
    },
  });
  if (!sourceJob) {
    return NextResponse.json(
      { error: "video_not_found", message: "ไม่พบวิดีโอต้นฉบับ" },
      { status: 404 },
    );
  }
  if (sourceJob.status !== "done") {
    return NextResponse.json(
      { error: "video_not_ready", message: "วิดีโอต้นฉบับยังไม่พร้อมแก้ไข" },
      { status: 409 },
    );
  }
  const sceneRerollCapability = resolveSceneRerollCapability({
    projectId: sourceJob.projectId,
    contentPreflightId: sourceJob.contentPreflightId,
    hasProjectVisualContext: parseProjectVisualContext(sourceJob.projectVisualContextJson) !== null,
  });
  if (
    !sceneRerollCapability.available
    || !sourceJob.projectId
    || !sourceJob.contentPreflightId
    || !sourceJob.projectVisualContextJson
  ) {
    return NextResponse.json(
      {
        error: "scene_reroll_unavailable",
        message: sceneRerollCapability.available
          ? "คลิปนี้ยังไม่มีข้อมูลฉากที่สมบูรณ์สำหรับลองภาพใหม่"
          : sceneRerollCapability.message,
      },
      { status: 409 },
    );
  }
  const projectId = sourceJob.projectId;
  const contentPreflightId = sourceJob.contentPreflightId;
  const projectVisualContextJson = sourceJob.projectVisualContextJson;
  const brandVisualPrompt = await resolveProjectVisualPromptForVideoScene({
    userId: user.id,
    videoJobId: input.videoJobId,
    sceneIndex: input.sceneIndex,
  });
  if (!brandVisualPrompt?.visualBeatId || !brandVisualPrompt.identityKey) {
    return NextResponse.json(
      {
        error: "scene_reroll_unavailable",
        message: "ไม่พบฉากที่ตรงกับคลิปนี้ กรุณาโหลดโปรเจกต์ใหม่",
      },
      { status: 409 },
    );
  }
  // Replay is resolved before every mutable admission gate. A response lost at
  // the daily-cap boundary or after COGS telemetry becomes stale must still
  // recover the exact paid/allowance image instead of minting a second request.
  const existingImageJob = await prisma.aiGenerationJob.findFirst({
    where: { userId: user.id, idempotencyKey: input.idempotencyKey },
  });

  let acceptance = null;
  if (!existingImageJob) {
    const sourceAssets = await reusableProjectVisualAssets({
      userId: user.id,
      projectId,
      preflightId: contentPreflightId,
    });
    if (!sourceAssets.some((asset) => asset.beatId === brandVisualPrompt.visualBeatId)) {
      return NextResponse.json(
        {
          error: "scene_reroll_requires_ai_asset",
          message: "ลองภาพใหม่ได้เฉพาะฉากที่มีภาพ AI เดิมอยู่แล้ว",
        },
        { status: 409 },
      );
    }
    const access = resolveBrandVisualRenderAccess({
      requestsBrandVisualImage: true,
      hasPersistedProjectPin: true,
      liveAccess: await resolveBrandVisualAccess(user),
    });
    if (!access) {
      return NextResponse.json(
        { error: "brand_visual_unavailable", message: "แนวภาพยังไม่เปิดให้บัญชีนี้ใช้งาน" },
        { status: 403 },
      );
    }

    // Rate cap (public-launch abuse guard) — one rerolled scene = one planned
    // image. Existing idempotent work bypasses this preflight above; the image
    // reservation transaction remains the final concurrency-safe cap.
    if (user.role !== "ADMIN") {
      const heroRate = await checkHeroImageRate(user.id, 1);
      if (!heroRate.ok) {
        return NextResponse.json(
          {
            error: "RATE_LIMITED",
            message: heroImageRateLimitMessage(heroRate),
            retryAfterSec: heroRate.retryAfterSec,
          },
          { status: 429, headers: { "Retry-After": String(heroRate.retryAfterSec) } },
        );
      }
    }

    const offer = describeHeroImageOffer();
    if (!offer.available || !isHeroRunpodRoute(offer.providerRoute)) {
      return NextResponse.json(
        {
          error: "hero_image_unavailable",
          message: "Hero AI Image ยังไม่พร้อมใช้งานในขณะนี้",
        },
        { status: 503 },
      );
    }
    if (usesCustomRunpodEndpoint(offer.providerRoute)) {
      const costSnapshot = await getRunpodImageCostSnapshot({ endpointId: offer.providerEndpoint });
      if (!costSnapshot.admitted) {
        return NextResponse.json(
          {
            error: "hero_image_cost_guard",
            retryable: true,
            message: costSnapshot.status === "stale"
              ? "ระบบตรวจสอบต้นทุน Hero AI Image ขาดข้อมูลล่าสุด จึงยังไม่รับงานใหม่"
              : "ต้นทุน Hero AI Image สูงกว่าเพดาน จึงยังไม่รับงานใหม่",
          },
          { status: 503 },
        );
      }
    }
    acceptance = parseBrandVisualJobAcceptance(await prepareBrandVisualJobAcceptance({
      userId: user.id,
      projectId,
      projectVisualPin: {
        contentPreflightId,
        projectVisualContextJson,
      },
      access,
    }));
  }

  const stocksDir = path.join(process.cwd(), "stocks");
  fs.mkdirSync(stocksDir, { recursive: true });
  const stamp = `${Date.now()}-${randomUUID()}`;
  const outFile = `broll-ai-${stamp}.mp4`;
  const outPath = path.join(stocksDir, outFile);
  const tmpImagePath = path.join(os.tmpdir(), `broll-hero-src-${stamp}.png`);
  let generated: Pick<
    HeroImageGenerationResult,
    "jobId" | "outputUrl" | "creditCost" | "fundingSource" | "allowanceUnits"
  > | null = null;

  try {
    generated = existingImageJob?.status === "completed"
      && existingImageJob.chargeState === "settled"
      && existingImageJob.outputUrl
      ? {
          jobId: existingImageJob.id,
          outputUrl: existingImageJob.outputUrl,
          creditCost: existingImageJob.creditCost,
          fundingSource: existingImageJob.fundingSource,
          allowanceUnits: existingImageJob.allowanceUnits,
        }
      : await generateHeroImageForVideo({
          userId: user.id,
          plan: user.plan,
          prompt: `Scene reroll ${input.sceneIndex + 1}`,
          idempotencyKey: input.idempotencyKey,
          videoJobId: input.videoJobId,
          sceneIndex: input.sceneIndex,
          sceneTitle: `B-roll scene ${input.sceneIndex + 1}`,
          brandVisualPrompt,
          deferVisualBeatLink: true,
          ...(acceptance ? { brandVisualAcceptance: acceptance } : {}),
          productSurface: "scene_reroll",
        });
    await copyOwnedHeroImage(generated.outputUrl, tmpImagePath);
    await applyKenBurns(tmpImagePath, outPath, input.kenBurnsDurationSec);
    if (!isValidMp4Path(outPath)) throw new Error("Hero Ken Burns produced no usable output");
    try { fs.writeFileSync(normalizedMarkerPath(outPath), ""); } catch {}
    await recordVisualBeatAsset({
      userId: user.id,
      beatId: brandVisualPrompt.visualBeatId,
      outputUrl: generated.outputUrl,
      imageJobId: generated.jobId,
      identityKey: brandVisualPrompt.identityKey,
    });

    const [balance, allowanceStatus] = await Promise.all([
      getBalance(user.id),
      getStarterAiImageAllowanceStatus(user.id),
    ]);
    if (!existingImageJob) {
      await recordTelemetryEvent(user.id, {
        name: "brand_look_scene_rerolled",
        category: "product",
        source: "server",
        step: "scene_reroll",
        status: "succeeded",
        value: 1,
        properties: {
          surface: "post-phase",
          videoJobId: input.videoJobId,
          sceneIndex: input.sceneIndex,
          aiGenerationJobId: generated.jobId,
          visualFormatId: brandVisualPrompt.compiled.visualFormatId,
          brandVisualIdentityKey: brandVisualPrompt.identityKey,
          brandLookIdentityKey: brandVisualPrompt.lookIdentityKey,
          cohort: acceptance?.cohort ?? null,
          fundingSource: generated.fundingSource,
        },
      }).catch((error) => {
        console.error("[broll-window/generate] telemetry failed:", error);
      });
    }
    return NextResponse.json({
      src: `/api/stocks/${outFile}`,
      clipDuration: input.kenBurnsDurationSec,
      imageJobId: generated.jobId,
      imageOutputUrl: generated.outputUrl,
      creditsSpent: generated.fundingSource === "credits" ? generated.creditCost : 0,
      quotedCreditCost: generated.creditCost,
      fundingSource: generated.fundingSource,
      allowanceUsed: generated.allowanceUnits,
      allowanceRemaining: allowanceStatus.eligible ? allowanceStatus.remainingImages : null,
      allowanceLimit: allowanceStatus.eligible ? allowanceStatus.limitImages : null,
      balanceAfter: balance.total,
      replayed: Boolean(existingImageJob),
    });
  } catch (error) {
    safeUnlink(outPath);
    safeUnlink(normalizedMarkerPath(outPath));
    let refundPending = false;

    // The durable Hero service refunds provider failures itself. If RunPod
    // succeeded but the customer-facing clip failed locally, compensate that
    // exact settled image so the user never pays for an unusable B-roll asset.
    if (generated && !existingImageJob) {
      try {
        await refundSettledVideoImageJob({
          userId: user.id,
          jobId: generated.jobId,
          reason: "broll_window_post_processing_failed",
        });
      } catch (refundError) {
        refundPending = true;
        console.error("[broll-window/generate] Hero output refund failed:", refundError);
      }
    }

    if (generated && existingImageJob) {
      return NextResponse.json(
        {
          error: "reroll_derivative_failed",
          retryable: true,
          retrySameRequest: true,
          message: "เตรียมภาพสำหรับวิดีโอยังไม่สำเร็จ กรุณาลองคำขอเดิมอีกครั้ง",
        },
        { status: 503 },
      );
    }

    console.error("[broll-window/generate] Hero generation failed:", error);
    if (refundPending) {
      return NextResponse.json(
        {
          error: "refund_pending",
          retryable: true,
          retrySameRequest: true,
          message: "สร้างคลิปจากภาพไม่สำเร็จและยังยืนยันการคืนเครดิตไม่ได้ กรุณาลองคำขอเดิมอีกครั้ง",
        },
        { status: 503 },
      );
    }
    if (error instanceof HeroImageGenerationError) {
      const durable = await prisma.aiGenerationJob.findFirst({
        where: { userId: user.id, idempotencyKey: input.idempotencyKey },
        select: { status: true, chargeState: true },
      });
      const retrySameRequest = Boolean(
        durable && durable.status !== "failed" && durable.chargeState !== "refunded",
      );
      if (error.code === "ALLOWANCE_EXHAUSTED") {
        return NextResponse.json(
          {
            error: "allowance_exhausted",
            remainingImages: 0,
            message: error.message,
            upgradeUrl: "/pricing",
            stockAction: "use-stock",
          },
          { status: 402 },
        );
      }
      if (error.code === "INSUFFICIENT_CREDITS") {
        const balance = (await getBalance(user.id)).total;
        return NextResponse.json(
          {
            error: "insufficient_credits",
            need: HERO_AI_IMAGE_CREDITS,
            balance,
            message: "เครดิตไม่พอสำหรับ Hero AI Image",
          },
          { status: 402 },
        );
      }
      return NextResponse.json(
        {
          error: error.code.toLowerCase(),
          retryable: error.providerFailure?.retryable ?? error.code !== "NOT_CONFIGURED",
          ...(retrySameRequest ? { retrySameRequest: true } : {}),
          message: error.message || "Hero AI Image ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
        },
        { status: error.status },
      );
    }
    return NextResponse.json(
      {
        error: "generation_failed",
        retryable: true,
        message: "สร้าง Hero AI Image ไม่สำเร็จ ระบบคืนเครดิตแล้ว กรุณาลองใหม่อีกครั้ง",
      },
      { status: 503 },
    );
  } finally {
    safeUnlink(tmpImagePath);
  }
}
