import "server-only";

import { checkBrandLookPreviewFunding } from "@/lib/brand-look-preview.server";
import {
  checkHeroImageRate,
  heroImageRateLimitMessage,
  type HeroImageRateCheck,
} from "@/lib/hero-image-rate-limit";
import { getRunpodImageCostSnapshot } from "@/lib/runpod-image-cost.server";
import { describeHeroImageOffer } from "@/lib/video-hero-image.server";

export type BrandLookGenerationAdmission =
  | { ok: true }
  | {
    ok: false;
    status: 402 | 429 | 503;
    body: Record<string, unknown>;
    headers?: Record<string, string>;
  };

type AdmissionDependencies = {
  checkFunding: (input: { userId: string; imageCount: number }) => Promise<
    Awaited<ReturnType<typeof checkBrandLookPreviewFunding>>
  >;
  checkRate: (userId: string, imageCount: number) => Promise<HeroImageRateCheck>;
  describeOffer: () => Pick<ReturnType<typeof describeHeroImageOffer>, "available" | "providerRoute" | "providerEndpoint">;
  getCost: (input: { endpointId?: string }) => Promise<Pick<
    Awaited<ReturnType<typeof getRunpodImageCostSnapshot>>,
    "admitted"
  >>;
};

const defaultDependencies: AdmissionDependencies = {
  checkFunding: checkBrandLookPreviewFunding,
  checkRate: checkHeroImageRate,
  describeOffer: describeHeroImageOffer,
  getCost: getRunpodImageCostSnapshot,
};

/** One admission seam for every Brand Look generation entry point. It checks
 * the complete logical request before any durable image job can reserve
 * allowance/credits, and keeps funding/rate/provider/COGS decisions identical
 * for saved previews, unsaved previews, and single-scene rerolls. */
export async function admitBrandLookGeneration(
  input: {
    userId: string;
    role?: string | null;
    imageCount: 1 | 3;
    purpose: "preview" | "reroll";
  },
  dependencies: AdmissionDependencies = defaultDependencies,
): Promise<BrandLookGenerationAdmission> {
  const funding = await dependencies.checkFunding({
    userId: input.userId,
    imageCount: input.imageCount,
  });
  if (!funding.ok) {
    if (funding.code === "ALLOWANCE_EXHAUSTED") {
      const message = input.purpose === "reroll"
        ? "ใช้สิทธิ์ทดลองภาพ AI ครบแล้ว ภาพเดิมยังอยู่"
        : `สิทธิ์ทดลองภาพ AI เหลือ ${funding.remainingImages ?? 0} ภาพ แต่การทดลองแนวภาพใหม่ต้องใช้ ${input.imageCount} ภาพ`;
      return {
        ok: false,
        status: 402,
        body: {
          error: "allowance_exhausted",
          code: "ALLOWANCE_EXHAUSTED",
          message,
          remainingImages: funding.remainingImages ?? 0,
          upgradeUrl: "/pricing",
          ...(input.purpose === "preview" ? { stockAction: "use-stock" } : {}),
        },
      };
    }
    const message = input.purpose === "reroll"
      ? `เครดิตไม่พอสำหรับลองภาพนี้ใหม่ ต้องใช้ ${funding.requiredCredits} เครดิต (คงเหลือ ${funding.balance})`
      : `เครดิตไม่พอสำหรับภาพทดลอง ${input.imageCount} ภาพ ต้องใช้ ${funding.requiredCredits} เครดิต (คงเหลือ ${funding.balance})`;
    return {
      ok: false,
      status: 402,
      body: {
        error: "INSUFFICIENT_CREDITS",
        code: "INSUFFICIENT_CREDITS",
        message,
        requiredCredits: funding.requiredCredits,
        balance: funding.balance,
      },
    };
  }

  if (input.role !== "ADMIN") {
    const rate = await dependencies.checkRate(input.userId, input.imageCount);
    if (!rate.ok) {
      return {
        ok: false,
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSec) },
        body: {
          error: "RATE_LIMITED",
          message: heroImageRateLimitMessage(rate),
          retryAfterSec: rate.retryAfterSec,
        },
      };
    }
  }

  const offer = dependencies.describeOffer();
  if (!offer.available || offer.providerRoute !== "runpod-custom") {
    return {
      ok: false,
      status: 503,
      body: { error: "hero_image_unavailable", message: "ระบบทดลองแนวภาพยังไม่พร้อม" },
    };
  }
  const cost = await dependencies.getCost({ endpointId: offer.providerEndpoint });
  if (!cost.admitted) {
    return {
      ok: false,
      status: 503,
      body: {
        error: "runpod_cost_guard",
        retryable: true,
        message: "ระบบพักงานใหม่เพื่อควบคุมต้นทุนภาพ",
      },
    };
  }
  return { ok: true };
}
