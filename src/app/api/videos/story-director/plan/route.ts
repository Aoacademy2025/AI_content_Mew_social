import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import {
  STORY_DIRECTOR_FLASH_CREDITS,
  STORY_DIRECTOR_NEON_CREDITS,
} from "@/lib/credit-costs";
import { refundCredits, spendCredits } from "@/lib/credits";
import { KeyRequiredError, resolveGeminiKey } from "@/lib/gemini-key";
import { prisma } from "@/lib/prisma";
import {
  analyzeUploadedFootageItems,
  materializeSmoothSlowMoSegments,
  planStoryDirectorWithVisionModel,
} from "@/lib/story-director-analyzer.server";
import {
  buildStoryDirectorPlan,
  isStoryDirectorModelTier,
  isStoryVoiceMode,
  type StoryDirectorModelTier,
  type StoryVoiceMode,
} from "@/lib/story-director-planner";
import path from "node:path";

/**
 * POST /api/videos/story-director/plan
 *
 * Web AI Story Director Vision Planner:
 *   1. Verifies caller ownership of uploaded `MediaImport` clips/photos
 *   2. Extracts 1fps Timestamped Contact Sheets + short Thai speech transcripts (`gemini-3.5-transcribe`)
 *   3. Runs `Gemini 4 Neon` (default, 19 credits) or `Gemini 3.8 Flash` (6 credits) with Thinking
 *      to pick exact `inSec..outSec` action shots, protagonist-verified frames, and reaction captions
 *   4. Pre-renders any slow-mo shot with optical-flow `minterpolate` @ 30fps so motion never stutters
 *   5. Refunds credits automatically if the upstream AI call fails!
 */
export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(req: Request) {
  const authUser = await getCurrentUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  }

  const rawClips = Array.isArray(body.clips) ? body.clips.slice(0, 16) : [];
  if (rawClips.length === 0) {
    return NextResponse.json(
      { error: "clips_required", message: "กรุณาอัปโหลดคลิปหรือรูปอย่างน้อย 1 ไฟล์ก่อนวางโครงเรื่อง" },
      { status: 400 },
    );
  }

  const requestedSrcs = rawClips
    .map((c) => (c && typeof c === "object" && typeof (c as { src?: unknown }).src === "string"
      ? ((c as { src: string }).src.trim())
      : ""))
    .filter(Boolean);

  if (requestedSrcs.length === 0) {
    return NextResponse.json(
      { error: "clips_required", message: "ไม่พบไฟล์ฟุตเทจที่ใช้งานได้" },
      { status: 400 },
    );
  }

  const [dbUser, ownedRows] = await Promise.all([
    prisma.user.findUnique({
      where: { id: authUser.id },
      select: { id: true, geminiKey: true, plan: true },
    }),
    prisma.mediaImport.findMany({
      where: {
        userId: authUser.id,
        status: "ready",
        resultSrc: { in: requestedSrcs },
      },
      select: { id: true, resultSrc: true, purpose: true, durationMs: true },
    }),
  ]);

  if (!dbUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const ownedBySrc = new Map(ownedRows.map((r) => [r.resultSrc ?? "", r]));
  const verifiedItems = rawClips.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const src = typeof item.src === "string" ? item.src.trim() : "";
    const owned = ownedBySrc.get(src);
    if (!owned) return [];
    return [{
      id: owned.id,
      src,
      filename: typeof item.filename === "string" ? item.filename.slice(0, 120) : undefined,
      stillImage: owned.purpose === "broll_image" || item.stillImage === true,
      durationSec: owned.durationMs ? owned.durationMs / 1000 : (typeof item.durationSec === "number" ? item.durationSec : 5),
      hasAudio: typeof item.hasAudio === "boolean" ? item.hasAudio : undefined,
      isLivePhotoCadence: typeof item.isLivePhotoCadence === "boolean" ? item.isLivePhotoCadence : undefined,
    }];
  });

  if (verifiedItems.length === 0) {
    return NextResponse.json(
      { error: "forbidden_media", message: "ไม่พบสิทธิ์ใช้งานไฟล์ที่อัปโหลด กรุณาอัปโหลดใหม่อีกครั้ง" },
      { status: 403 },
    );
  }

  const modelTier: StoryDirectorModelTier = isStoryDirectorModelTier(body.modelTier)
    ? body.modelTier
    : "neon";
  const voiceMode: StoryVoiceMode = isStoryVoiceMode(body.voiceMode)
    ? body.voiceMode
    : "real-moments";
  const brief = typeof body.brief === "string" ? body.brief.slice(0, 1000) : "";
  const templateId = typeof body.templateId === "string" ? body.templateId : null;
  const targetDurationSec = typeof body.targetDurationSec === "number" ? body.targetDurationSec : undefined;

  let apiKey: string | null = null;
  let geminiMode: "managed" | "byok" = "managed";
  try {
    const resolved = resolveGeminiKey(dbUser);
    apiKey = resolved.key;
    geminiMode = resolved.mode;
  } catch (e) {
    if (!(e instanceof KeyRequiredError)) throw e;
  }

  const creditAction = modelTier === "neon" ? "story-director-neon" : "story-director-flash";
  const creditCost = modelTier === "neon" ? STORY_DIRECTOR_NEON_CREDITS : STORY_DIRECTOR_FLASH_CREDITS;
  const shouldChargeCredits = Boolean(
    apiKey && geminiMode === "managed" && process.env.CREDITS_LIVE === "1",
  );

  let spent:
    | { fromGranted: number; fromPurchased: number; promotionalDebits: { grantId: string; amount: number }[] }
    | null = null;

  if (shouldChargeCredits) {
    const spendRes = await spendCredits(authUser.id, creditCost, creditAction);
    if (!spendRes.ok) {
      return NextResponse.json(
        {
          error: "insufficient_credits",
          code: "insufficient_credits",
          requiredCredits: creditCost,
          availableCredits: spendRes.balanceAfter,
          message: `เครดิตไม่เพียงพอสำหรับโหมดผู้กำกับ AI (${creditCost} เครดิต · คงเหลือ ${spendRes.balanceAfter} เครดิต)`,
        },
        { status: 402 },
      );
    }
    spent = {
      fromGranted: spendRes.fromGranted,
      fromPurchased: spendRes.fromPurchased,
      promotionalDebits: spendRes.promotionalDebits,
    };
  }

  try {
    const analyzedWithSheets = await analyzeUploadedFootageItems(verifiedItems, {
      includeContactSheets: Boolean(apiKey),
      apiKey,
    });

    let plan = apiKey
      ? await planStoryDirectorWithVisionModel({
          apiKey,
          modelTier,
          voiceMode,
          brief,
          templateId,
          targetDurationSec,
          clips: analyzedWithSheets,
          creditsCharged: spent ? creditCost : 0,
        })
      : buildStoryDirectorPlan({
          brief,
          voiceMode,
          templateId,
          clips: analyzedWithSheets,
          targetDurationSec,
        });

    // Materialize smooth optical-flow 30fps slow-mo segments in `<repo>/stocks` and register owned MediaImport rows
    // so `/api/videos/jobs` ownership check accepts the generated slow-mo clip seamlessly!
    const stocksDir = path.join(process.cwd(), "stocks");
    const smoothedBgVideos = await materializeSmoothSlowMoSegments(plan.bgVideos, {
      outDir: stocksDir,
      urlPrefix: "/api/stocks",
    });

    for (let i = 0; i < smoothedBgVideos.length; i++) {
      const afterSeg = smoothedBgVideos[i]!;
      const beforeSeg = plan.bgVideos[i];
      if (beforeSeg && afterSeg.src !== beforeSeg.src) {
        await prisma.mediaImport.create({
          data: {
            userId: authUser.id,
            source: "upload",
            purpose: "broll_video",
            status: "ready",
            resultSrc: afterSeg.src,
            durationMs: Math.round((afterSeg.clipDuration ?? 3) * 1000),
            bytes: 0,
            deadlineAt: new Date(Date.now() + 24 * 60 * 60_000),
          },
        });
      }
    }

    plan = {
      ...plan,
      bgVideos: smoothedBgVideos,
    };

    // Strip base64 JPEGs before returning JSON to the browser
    const analyzedClips = analyzedWithSheets.map(
      ({ contactSheetBase64: _b64, contactSheetMimeType: _mime, ...rest }) => rest,
    );

    return NextResponse.json({
      ok: true,
      creditsCharged: spent ? creditCost : 0,
      modelUsed: plan.modelUsed ?? "deterministic",
      analyzedClips,
      plan,
    });
  } catch (error) {
    if (spent) {
      await refundCredits(
        authUser.id,
        spent.fromGranted,
        spent.fromPurchased,
        `${creditAction}:refund`,
        spent.promotionalDebits,
      ).catch(() => {});
    }
    return NextResponse.json(
      {
        error: "story_director_failed",
        message: error instanceof Error ? error.message : "วิเคราะห์ฟุตเทจไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
      },
      { status: 502 },
    );
  }
}
