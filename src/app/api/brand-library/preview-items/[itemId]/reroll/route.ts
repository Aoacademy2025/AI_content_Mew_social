import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { checkBrandLookPreviewFunding, rerollBrandLookPreviewItem } from "@/lib/brand-look-preview.server";
import { requireBrandVisualUser } from "@/lib/brand-visual-access.server";
import { checkHeroImageRate, heroImageRateLimitMessage } from "@/lib/hero-image-rate-limit";
import { getRunpodImageCostSnapshot } from "@/lib/runpod-image-cost.server";
import { describeHeroImageOffer, HeroImageGenerationError } from "@/lib/video-hero-image.server";
import { recordTelemetryEvent } from "@/lib/telemetry";

export const runtime = "nodejs";
export const maxDuration = 900;

export async function POST(req: Request, { params }: { params: Promise<{ itemId: string }> }) {
  const startedAt = Date.now();
  try {
    const auth = await requireBrandVisualUser();
    if (!auth.ok) return auth.response;
    const body = await req.json().catch(() => null);
    if (typeof body?.requestId !== "string" || !body.requestId.trim()) {
      return NextResponse.json({ error: "requestId is required" }, { status: 400 });
    }
    const funding = await checkBrandLookPreviewFunding({ userId: auth.user.id, imageCount: 1 });
    if (!funding.ok) {
      if (funding.code === "ALLOWANCE_EXHAUSTED") {
        return NextResponse.json({
          error: "allowance_exhausted",
          message: "ใช้สิทธิ์ทดลองภาพ AI ครบแล้ว ภาพเดิมยังอยู่",
          remainingImages: funding.remainingImages ?? 0,
          upgradeUrl: "/pricing",
        }, { status: 402 });
      }
      return NextResponse.json({
        error: "INSUFFICIENT_CREDITS",
        code: "INSUFFICIENT_CREDITS",
        message: `เครดิตไม่พอสำหรับลองภาพนี้ใหม่ ต้องใช้ ${funding.requiredCredits} เครดิต (คงเหลือ ${funding.balance})`,
        requiredCredits: funding.requiredCredits,
        balance: funding.balance,
      }, { status: 402 });
    }
    if (auth.user.role !== "ADMIN") {
      const rate = await checkHeroImageRate(auth.user.id, 1);
      if (!rate.ok) {
        return NextResponse.json(
          { error: "RATE_LIMITED", message: heroImageRateLimitMessage(rate), retryAfterSec: rate.retryAfterSec },
          { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } },
        );
      }
    }
    const offer = describeHeroImageOffer();
    if (!offer.available || offer.providerRoute !== "runpod-custom") {
      return NextResponse.json({ error: "hero_image_unavailable" }, { status: 503 });
    }
    const cost = await getRunpodImageCostSnapshot({ endpointId: offer.providerEndpoint });
    if (!cost.admitted) return NextResponse.json({ error: "runpod_cost_guard", retryable: true }, { status: 503 });
    const { itemId } = await params;
    const item = await rerollBrandLookPreviewItem({
      userId: auth.user.id,
      itemId,
      requestId: body.requestId,
    });
    await recordTelemetryEvent(auth.user.id, {
      name: "brand_look_scene_rerolled",
      category: item.status === "completed" ? "performance" : "error",
      source: "server",
      status: item.status,
      durationMs: Date.now() - startedAt,
      properties: { itemId, phase: item.phase, cohort: auth.access.cohort },
    }).catch(() => {});
    return NextResponse.json({ item });
  } catch (error) {
    if (error instanceof HeroImageGenerationError && error.status === 402) {
      return NextResponse.json({
        error: error.code === "ALLOWANCE_EXHAUSTED" ? "allowance_exhausted" : "INSUFFICIENT_CREDITS",
        code: error.code,
        message: error.message,
        upgradeUrl: "/pricing",
      }, { status: 402 });
    }
    return apiError({ route: "POST /api/brand-library/preview-items/[itemId]/reroll", error });
  }
}
