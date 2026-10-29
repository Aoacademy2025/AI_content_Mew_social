import "server-only";

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  applyKenBurns,
  downloadAndCrop,
  isValidMp4Path,
  normalizedMarkerPath,
  safeUnlink,
} from "@/lib/broll-asset-lib";
import {
  createCatalogTreatmentPin,
  treatmentPromptDirection,
  type TreatmentPresetId,
} from "@/lib/brand-treatment-catalog";
import {
  compileBrandVisualPrompt,
  visualBeatFromCustomPrompt,
} from "@/lib/brand-visual-system";
import { shotScaleForAction } from "@/lib/scene-brief-diversity";
import { planHeroAiWindowGeneration } from "@/lib/hero-ai-broll";
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
import {
  parseProjectVisualContext,
  projectHasAdmittedPersistedPin,
  resolveProjectVisualPromptForVideoScene,
} from "@/lib/project-look.server";
import {
  cutawayTimelineSourceFromJob,
  sceneRerollBeatTarget,
} from "@/lib/cutaway-plan";
import {
  describeHeroImageOffer,
  generateHeroImageForBrollWindow,
  HeroImageGenerationError,
  resolveVideoHeroAspectRatio,
} from "@/lib/video-hero-image.server";
import { refundSettledVideoImageJob } from "@/lib/video-image-batch-settlement";

export type McpBrollWindowHeroInput = {
  user: User;
  sourceVideoJobId: string;
  sceneIndex: number;
  durationSec: number;
  fallbackSceneText: string;
  treatment?: TreatmentPresetId;
  prompt?: string;
};

export type McpBrollWindowHeroResult =
  | {
      ok: true;
      src: string;
      imageJobId: string;
      clipDuration: number;
      creditsSpent: number;
    }
  | {
      ok: false;
      code: string;
      message: string;
      next: string;
    };

type TestOverrideFn = (input: McpBrollWindowHeroInput) => Promise<McpBrollWindowHeroResult>;
let testOverride: TestOverrideFn | null = null;

export function setMcpHeroBrollWindowGeneratorForTests(fn: TestOverrideFn | null): void {
  testOverride = fn;
}

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

export async function generateMcpBrollWindowHeroClip(
  input: McpBrollWindowHeroInput,
): Promise<McpBrollWindowHeroResult> {
  if (testOverride) {
    return testOverride(input);
  }
  const { user } = input;
  const sourceJob = await prisma.videoJob.findFirst({
    where: { id: input.sourceVideoJobId, userId: user.id },
    select: {
      id: true,
      status: true,
      projectId: true,
      contentPreflightId: true,
      projectVisualContextJson: true,
      inputJson: true,
      outputJson: true,
    },
  });
  if (!sourceJob || sourceJob.status !== "done") {
    return {
      ok: false,
      code: "source_not_exportable",
      message: "วิดีโอตัวอย่างยังไม่พร้อมแก้ไข",
      next: "เรียก get_edit_state เพื่อตรวจสอบสถานะล่าสุด",
    };
  }

  if (user.role !== "ADMIN") {
    const heroRate = await checkHeroImageRate(user.id, 1);
    if (!heroRate.ok) {
      return {
        ok: false,
        code: "rate_limited",
        message: heroImageRateLimitMessage(heroRate),
        next: `รอประมาณ ${heroRate.retryAfterSec} วินาทีแล้วลองเรียก replace_broll_window อีกครั้ง`,
      };
    }
  }

  const offer = describeHeroImageOffer();
  if (!offer.available || !isHeroRunpodRoute(offer.providerRoute)) {
    return {
      ok: false,
      code: "hero_image_unavailable",
      message: "Hero AI Image ยังไม่พร้อมใช้งานในขณะนี้",
      next: "ลองอีกครั้งภายหลัง หรือส่ง url / uploadId แทน",
    };
  }
  if (usesCustomRunpodEndpoint(offer.providerRoute)) {
    const costSnapshot = await getRunpodImageCostSnapshot({ endpointId: offer.providerEndpoint });
    if (!costSnapshot.admitted) {
      return {
        ok: false,
        code: "hero_image_cost_guard",
        message: costSnapshot.status === "stale"
          ? "ระบบตรวจสอบต้นทุน Hero AI Image ขาดข้อมูลล่าสุด จึงยังไม่รับงานใหม่"
          : "ต้นทุน Hero AI Image สูงกว่าเพดาน จึงยังไม่รับงานใหม่",
        next: "ลองอีกครั้งภายหลัง หรือส่ง url / uploadId แทน",
      };
    }
  }

  const beatTarget = sceneRerollBeatTarget(
    input.sceneIndex,
    cutawayTimelineSourceFromJob(sourceJob),
  );
  if (beatTarget.kind === "presenter") {
    return {
      ok: false,
      code: "window_locked_presenter_hook",
      message: "ช่วงเปิดคลิปเป็นคนพูด จึงเปลี่ยนเป็นภาพ AI ไม่ได้",
      next: "เลือกช่วง B-roll อื่นจาก get_edit_state",
    };
  }

  let brandVisualPrompt: {
    source: "project-look" | "brand-revision" | "suggested";
    compiled: ReturnType<typeof compileBrandVisualPrompt>;
    visualBeatId?: string;
    identityKey?: string;
    lookIdentityKey?: string;
  };
  let acceptance = undefined;

  if (
    sourceJob.projectId
    && sourceJob.contentPreflightId
    && parseProjectVisualContext(sourceJob.projectVisualContextJson) !== null
  ) {
    const resolved = await resolveProjectVisualPromptForVideoScene({
      userId: user.id,
      videoJobId: sourceJob.id,
      sceneIndex: beatTarget.visualBeatSequence,
      treatmentPresetId: input.treatment,
      customPrompt: input.prompt,
    });
    if (!resolved) {
      return {
        ok: false,
        code: "scene_reroll_unavailable",
        message: "ไม่พบข้อมูลฉากที่ตรงกับช่วงนี้",
        next: "ระบุ prompt เพื่ออธิบายฉากที่ต้องการ หรือเลือกช่วงอื่น",
      };
    }
    brandVisualPrompt = resolved;
    const access = resolveBrandVisualRenderAccess({
      requestsBrandVisualImage: true,
      hasAdmittedPersistedPin: await projectHasAdmittedPersistedPin({
        userId: user.id,
        projectId: sourceJob.projectId,
      }),
      liveAccess: await resolveBrandVisualAccess(user),
    });
    if (access) {
      acceptance = parseBrandVisualJobAcceptance(await prepareBrandVisualJobAcceptance({
        userId: user.id,
        projectId: sourceJob.projectId,
        projectVisualPin: {
          contentPreflightId: sourceJob.contentPreflightId,
          projectVisualContextJson: sourceJob.projectVisualContextJson!,
        },
        access,
      }));
    }
  } else {
    const pin = createCatalogTreatmentPin(
      input.treatment ?? "practical-documentary",
      input.treatment ? "creator" : "adaptive",
    );
    const beat = visualBeatFromCustomPrompt(
      input.prompt?.trim() || input.fallbackSceneText || `B-roll scene ${input.sceneIndex + 1}`,
      input.sceneIndex === 0 ? "hook" : "explain",
    );
    const compiled = compileBrandVisualPrompt({
      visualFormatId: "cinematic-realism",
      contentDomain: "a visually led subject",
      treatment: treatmentPromptDirection(pin),
      treatmentPin: pin,
      visualBeat: beat,
      sceneShotScale: shotScaleForAction(beat.subject),
    });
    brandVisualPrompt = {
      source: "project-look",
      compiled,
    };
  }

  const requestId = randomUUID();
  const idempotencyKey = `broll-window:${sourceJob.id}:scene:${input.sceneIndex}:request:${requestId}`;
  const kenBurnsDurationSec = planHeroAiWindowGeneration(
    [`scene-${input.sceneIndex}`],
    [Math.min(600, Math.max(1, input.durationSec))],
  )[0].kenBurnsDurationSec;

  const stocksDir = path.join(process.cwd(), "stocks");
  fs.mkdirSync(stocksDir, { recursive: true });
  const stamp = `${Date.now()}-${randomUUID()}`;
  const outFile = `broll-ai-${stamp}.mp4`;
  const outPath = path.join(stocksDir, outFile);
  const tmpImagePath = path.join(os.tmpdir(), `broll-hero-src-${stamp}.png`);
  let generated: Awaited<ReturnType<typeof generateHeroImageForBrollWindow>> | null = null;
  let registeredDerivativeSrc: string | null = null;

  try {
    generated = await generateHeroImageForBrollWindow({
      userId: user.id,
      plan: user.plan,
      prompt: input.prompt?.trim() || `Scene reroll ${input.sceneIndex + 1}`,
      idempotencyKey,
      videoJobId: sourceJob.id,
      sceneIndex: input.sceneIndex,
      sceneTitle: `B-roll scene ${input.sceneIndex + 1}`,
      brandVisualPrompt,
      deferVisualBeatLink: true,
      ...(acceptance ? { brandVisualAcceptance: acceptance } : {}),
      productSurface: "scene_reroll",
    });
    const aspectRatio = await resolveVideoHeroAspectRatio({
      userId: user.id,
      videoJobId: sourceJob.id,
    });
    await copyOwnedHeroImage(generated.outputUrl, tmpImagePath);
    await applyKenBurns(tmpImagePath, outPath, kenBurnsDurationSec, { aspectRatio });
    if (!isValidMp4Path(outPath)) throw new Error("Hero Ken Burns produced no usable output");
    try { fs.writeFileSync(normalizedMarkerPath(outPath), ""); } catch {}
    const derivativeSrc = `/api/stocks/${outFile}`;
    await prisma.sceneRerollDerivative.create({
      data: {
        userId: user.id,
        imageJobId: generated.jobId,
        sourceVideoJobId: sourceJob.id,
        sceneIndex: input.sceneIndex,
        src: derivativeSrc,
      },
    });
    registeredDerivativeSrc = derivativeSrc;
    return {
      ok: true,
      src: derivativeSrc,
      imageJobId: generated.jobId,
      clipDuration: kenBurnsDurationSec,
      creditsSpent: generated.fundingSource === "credits" ? generated.creditCost : 0,
    };
  } catch (error) {
    safeUnlink(outPath);
    safeUnlink(normalizedMarkerPath(outPath));
    if (registeredDerivativeSrc) {
      await prisma.sceneRerollDerivative.deleteMany({
        where: { userId: user.id, src: registeredDerivativeSrc, status: "ready" },
      }).catch(() => {});
    }
    if (generated) {
      await refundSettledVideoImageJob({
        userId: user.id,
        jobId: generated.jobId,
        reason: "broll_window_post_processing_failed",
      }).catch(() => {});
    }
    if (error instanceof HeroImageGenerationError) {
      if (error.code === "INSUFFICIENT_CREDITS") {
        const balance = (await getBalance(user.id)).total;
        return {
          ok: false,
          code: "insufficient_credits",
          message: `เครดิตไม่พอสำหรับสร้างภาพ Hero AI Image (ต้องใช้ ${HERO_AI_IMAGE_CREDITS} เครดิต มี ${balance} เครดิต)`,
          next: "เติมเครดิตที่หน้า /pricing หรือเปลี่ยนช่วงนี้ด้วย url / uploadId แทน",
        };
      }
      if (error.code === "ALLOWANCE_EXHAUSTED") {
        return {
          ok: false,
          code: "allowance_exhausted",
          message: error.message,
          next: "อัปเกรดแพ็กเกจที่ /pricing หรือส่ง url / uploadId แทน",
        };
      }
      return {
        ok: false,
        code: error.code.toLowerCase(),
        message: error.message || "สร้างภาพ Hero AI Image ไม่สำเร็จ",
        next: "ลองเรียก replace_broll_window อีกครั้ง หรือส่ง url / uploadId แทน",
      };
    }
    return {
      ok: false,
      code: "generation_failed",
      message: "สร้างภาพ Hero AI Image ไม่สำเร็จ ระบบคืนเครดิตแล้ว กรุณาลองใหม่อีกครั้ง",
      next: "ลองเรียก replace_broll_window อีกครั้ง หรือส่ง url / uploadId แทน",
    };
  } finally {
    safeUnlink(tmpImagePath);
  }
}
