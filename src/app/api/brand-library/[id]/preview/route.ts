import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import {
  brandLookPreviewRequiresGeneration,
  checkBrandLookPreviewFunding,
  createBrandLookPreview,
} from "@/lib/brand-look-preview.server";
import { requireBrandVisualUser } from "@/lib/brand-visual-access.server";
import { checkHeroImageRate, heroImageRateLimitMessage } from "@/lib/hero-image-rate-limit";
import { getRunpodImageCostSnapshot } from "@/lib/runpod-image-cost.server";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { describeHeroImageOffer, HeroImageGenerationError } from "@/lib/video-hero-image.server";

export const runtime = "nodejs";
export const maxDuration = 900;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  try {
    const auth = await requireBrandVisualUser();
    if (!auth.ok) return auth.response;
    const body = await req.json().catch(() => ({}));
    const projectId = typeof body?.projectId === "string" ? body.projectId : undefined;
    const generating = await brandLookPreviewRequiresGeneration({ userId: auth.user.id, projectId });
    if (generating) {
      const funding = await checkBrandLookPreviewFunding({ userId: auth.user.id, imageCount: 3 });
      if (!funding.ok) {
        if (funding.code === "ALLOWANCE_EXHAUSTED") {
          return NextResponse.json({
            error: "allowance_exhausted",
            message: `สิทธิ์ทดลองภาพ AI เหลือ ${funding.remainingImages ?? 0} ภาพ แต่การทดลองแนวภาพใหม่ต้องใช้ 3 ภาพ`,
            remainingImages: funding.remainingImages ?? 0,
            upgradeUrl: "/pricing",
            stockAction: "use-stock",
          }, { status: 402 });
        }
        return NextResponse.json({
          code: "INSUFFICIENT_CREDITS",
          error: "INSUFFICIENT_CREDITS",
          message: `เครดิตไม่พอสำหรับภาพทดลอง 3 ภาพ ต้องใช้ ${funding.requiredCredits} เครดิต (คงเหลือ ${funding.balance})`,
          requiredCredits: funding.requiredCredits,
          balance: funding.balance,
        }, { status: 402 });
      }
    }
    if (generating && auth.user.role !== "ADMIN") {
      const rate = await checkHeroImageRate(auth.user.id, 3);
      if (!rate.ok) {
        return NextResponse.json(
          { error: "RATE_LIMITED", message: heroImageRateLimitMessage(rate), retryAfterSec: rate.retryAfterSec },
          { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } },
        );
      }
    }
    if (generating) {
      const offer = describeHeroImageOffer();
      if (!offer.available || offer.providerRoute !== "runpod-custom") {
        return NextResponse.json({ error: "hero_image_unavailable", message: "ระบบทดลองแนวภาพยังไม่พร้อม" }, { status: 503 });
      }
      const cost = await getRunpodImageCostSnapshot({ endpointId: offer.providerEndpoint });
      if (!cost.admitted) {
        return NextResponse.json({ error: "runpod_cost_guard", retryable: true, message: "ระบบพักงานใหม่เพื่อควบคุมต้นทุนภาพ" }, { status: 503 });
      }
    }
    const { id } = await params;
    const batch = await createBrandLookPreview({
      userId: auth.user.id,
      profileId: id,
      projectId,
      useDraft: body?.useDraft === true,
    });
    const generatedCount = batch.items.filter((item) => item.sourceType === "generated" && item.status === "completed").length;
    const reusedCount = batch.items.filter((item) => item.sourceType === "reused").length;
    await recordTelemetryEvent(auth.user.id, {
      name: "brand_look_preview_finished",
      category: "performance",
      source: "server",
      status: batch.status,
      durationMs: Date.now() - startedAt,
      properties: { batchId: batch.id, profileId: id, generatedCount, reusedCount, cohort: auth.access.cohort },
    }).catch(() => {});
    return NextResponse.json({ batch, generatedCount, reusedCount });
  } catch (error) {
    if (error instanceof HeroImageGenerationError && error.status === 402) {
      return NextResponse.json({
        error: error.code === "ALLOWANCE_EXHAUSTED" ? "allowance_exhausted" : "INSUFFICIENT_CREDITS",
        code: error.code,
        message: error.message,
        upgradeUrl: "/pricing",
        stockAction: "use-stock",
      }, { status: 402 });
    }
    return apiError({ route: "POST /api/brand-library/[id]/preview", error });
  }
}
