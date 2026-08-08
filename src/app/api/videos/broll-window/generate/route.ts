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
import { HERO_AI_IMAGE_PLAN_REQUIRED_RESPONSE, isHeroAiImageEligible } from "@/lib/internal-ai-access";
import { getRunpodImageCostSnapshot } from "@/lib/runpod-image-cost.server";
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
  const isAdmin = user.role === "ADMIN";
  if (!isHeroAiImageEligible(user)) {
    if (process.env.HERO_AI_IMAGE_PUBLIC === "1") {
      return NextResponse.json(HERO_AI_IMAGE_PLAN_REQUIRED_RESPONSE.body, { status: HERO_AI_IMAGE_PLAN_REQUIRED_RESPONSE.status });
    }
    return NextResponse.json(
      { error: "beta_only", message: "Hero AI Image ยังเปิดเฉพาะทีมงาน (Beta)" },
      { status: 403 },
    );
  }
  // Rate cap (public-launch abuse guard) — one regenerated window = one planned
  // image. Runs before any credit reservation. Admins are exempt (team ops).
  if (!isAdmin) {
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
    select: { status: true },
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

  const offer = describeHeroImageOffer();
  if (!offer.available || offer.providerRoute !== "runpod-custom") {
    return NextResponse.json(
      {
        error: "hero_image_unavailable",
        message: "Hero AI Image ยังไม่พร้อมบน RunPod custom endpoint ที่ผ่านการตรวจสอบ",
      },
      { status: 503 },
    );
  }
  const costSnapshot = await getRunpodImageCostSnapshot({ endpointId: offer.providerEndpoint });
  if (!costSnapshot.admitted) {
    return NextResponse.json(
      {
        error: "runpod_cost_guard",
        retryable: true,
        message: costSnapshot.status === "stale"
          ? "ระบบตรวจสอบต้นทุน Hero AI Image ขาดข้อมูลล่าสุด จึงยังไม่รับงานใหม่"
          : "ต้นทุน Hero AI Image สูงกว่าเพดาน จึงยังไม่รับงานใหม่",
      },
      { status: 503 },
    );
  }

  const stocksDir = path.join(process.cwd(), "stocks");
  fs.mkdirSync(stocksDir, { recursive: true });
  const stamp = `${Date.now()}-${randomUUID()}`;
  const outFile = `broll-ai-${stamp}.mp4`;
  const outPath = path.join(stocksDir, outFile);
  const tmpImagePath = path.join(os.tmpdir(), `broll-hero-src-${stamp}.png`);
  let generated: HeroImageGenerationResult | null = null;

  try {
    generated = await generateHeroImageForVideo({
      userId: user.id,
      plan: user.plan,
      prompt: input.prompt,
      idempotencyKey: input.idempotencyKey,
      videoJobId: input.videoJobId,
      sceneIndex: input.sceneIndex,
      sceneTitle: `B-roll scene ${input.sceneIndex + 1}`,
      style: input.heroStyle,
    });
    await copyOwnedHeroImage(generated.outputUrl, tmpImagePath);
    await applyKenBurns(tmpImagePath, outPath, input.kenBurnsDurationSec);
    if (!isValidMp4Path(outPath)) throw new Error("Hero Ken Burns produced no usable output");
    try { fs.writeFileSync(normalizedMarkerPath(outPath), ""); } catch {}

    const balanceAfter = (await getBalance(user.id)).total;
    return NextResponse.json({
      src: `/api/stocks/${outFile}`,
      clipDuration: input.kenBurnsDurationSec,
      creditsSpent: generated.creditCost,
      balanceAfter,
      provider: generated.provider,
      model: generated.providerModel,
    });
  } catch (error) {
    safeUnlink(outPath);
    safeUnlink(normalizedMarkerPath(outPath));
    let refundPending = false;

    // The durable Hero service refunds provider failures itself. If RunPod
    // succeeded but the customer-facing clip failed locally, compensate that
    // exact settled image so the user never pays for an unusable B-roll asset.
    if (generated) {
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
