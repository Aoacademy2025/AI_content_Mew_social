import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import {
  isValidCtaStyleKey,
  isValidHookFormulaKey,
  isValidStoryStructureKey,
} from "@/lib/viral-frameworks";
import {
  getQuickStylePreset,
  isValidQuickStylePresetKey,
  quickStylePresetToBrandProfile,
} from "@/lib/hero-script-presets";
import {
  buildCompactScriptPrompt,
  buildGeneratePrompt,
  buildQuickGeneratePrompt,
  type BrandProfileForPrompt,
} from "@/lib/prompts/hero-script";
import {
  compactScriptIfOverBudget,
  generateValidatedJson,
  generateWithBannedWordGuard,
  heroScriptLlmErrorResponse,
  isValidDurationSec,
  repairQuickGenerateResponse,
  requireHeroScriptUser,
  reserveScriptGeneration,
  resolveHeroScriptBrandProfile,
  resolveLlmTriad,
  settleScriptGeneration,
  stripEchoedHook,
  validateCompactResponse,
  validateGenerateResponse,
  validateTopic,
  wordBudgetForDuration,
  PRO_TIER_TEXT_CALL_COST,
  type GenerateScriptResult,
  type GuardedGeneration,
  type QuickGenerateScriptResult,
} from "@/lib/hero-script.server";

// POST /api/scripts/generate
// Supports two modes:
//   1. Step-by-step (default / mode: "hook"): { topic, hookText, hookFormula?,
//      brandProfileId?, stylePreset?, durationSec, structure?, ctaStyle? }
//      → { structure, bodyText, ctaText, compacted?, warning? }
//   2. 1-click fast path (mode: "quick"): { mode: "quick", topic,
//      brandProfileId?, stylePreset?, durationSec, structure?, ctaStyle? }
//      → { hookFormula, hookText, alternativeHooks, structure, bodyText, ctaText,
//          compacted?, warning? }
// Both modes run on PRO tier with banned-word guard + fail-open >25% word-budget
// auto-compact pass (max 1 pass).
export async function POST(req: Request) {
  let reservedUserId: string | null = null;
  let reservationId: string | null = null;
  async function settle(succeeded: boolean) {
    if (!reservedUserId || !reservationId) return;
    const id = reservationId;
    if (succeeded) {
      await settleScriptGeneration(reservedUserId, id, true);
      reservationId = null;
      return;
    }
    reservationId = null;
    await settleScriptGeneration(reservedUserId, id, false).catch((error) => {
      console.error("[hero-script] failed to release generation reservation", error);
    });
  }

  try {
    const access = await requireHeroScriptUser();
    if (!access.ok) return access.response;
    const authUser = access.user;

    const body = await req.json().catch(() => null);

    const topicCheck = validateTopic(body?.topic);
    if (!topicCheck.ok) return NextResponse.json({ error: topicCheck.message }, { status: 400 });

    if (!isValidDurationSec(body?.durationSec)) {
      return NextResponse.json({ error: "กรุณาระบุความยาววิดีโอ (30, 60 หรือ 90 วินาที)" }, { status: 400 });
    }
    const durationSec = body.durationSec as 30 | 60 | 90;

    const rawMode = typeof body?.mode === "string" ? body.mode.trim() : "";
    if (rawMode && rawMode !== "quick" && rawMode !== "hook") {
      return NextResponse.json({ error: "โหมดการสร้างสคริปต์ไม่ถูกต้อง" }, { status: 400 });
    }
    const isQuickMode = rawMode === "quick";

    const hookText = typeof body?.hookText === "string" ? body.hookText.trim() : "";
    if (!isQuickMode && !hookText) {
      return NextResponse.json({ error: "กรุณาเลือก hook ก่อนสร้างสคริปต์เต็ม" }, { status: 400 });
    }
    const hookFormula = typeof body?.hookFormula === "string" ? body.hookFormula.trim() : "";
    if (!isQuickMode && hookFormula && !isValidHookFormulaKey(hookFormula)) {
      return NextResponse.json({ error: "สูตร hook ไม่ถูกต้อง" }, { status: 400 });
    }

    const preferredStructure = typeof body?.structure === "string" && body.structure.trim()
      ? body.structure.trim()
      : null;
    if (preferredStructure && !isValidStoryStructureKey(preferredStructure)) {
      return NextResponse.json({ error: "โครงเรื่องไม่ถูกต้อง" }, { status: 400 });
    }

    const ctaOverride = typeof body?.ctaStyle === "string" && body.ctaStyle.trim()
      ? body.ctaStyle.trim()
      : null;
    if (ctaOverride && !isValidCtaStyleKey(ctaOverride)) {
      return NextResponse.json({ error: "สไตล์ CTA ไม่ถูกต้อง" }, { status: 400 });
    }

    const stylePresetKey = typeof body?.stylePreset === "string" && body.stylePreset.trim()
      ? body.stylePreset.trim()
      : null;
    if (stylePresetKey && !isValidQuickStylePresetKey(stylePresetKey)) {
      return NextResponse.json({ error: "สไตล์เริ่มต้นไม่ถูกต้อง" }, { status: 400 });
    }

    const brandProfileId =
      typeof body?.brandProfileId === "string" && body.brandProfileId.trim()
        ? body.brandProfileId.trim()
        : null;

    let profile: BrandProfileForPrompt | null = null;
    let bannedWords: string[] = [];
    let ctaStyle = "follow";
    if (brandProfileId) {
      const resolved = await resolveHeroScriptBrandProfile(authUser.id, brandProfileId);
      if (!resolved.ok) {
        return NextResponse.json(
          { code: resolved.code === "UNAVAILABLE" ? "BRAND_PROFILE_UNAVAILABLE" : undefined, error: resolved.message },
          { status: resolved.code === "NOT_FOUND" ? 404 : 403 },
        );
      }
      profile = resolved.profile;
      bannedWords = resolved.bannedWords;
      ctaStyle = resolved.ctaStyle;
    } else if (stylePresetKey) {
      profile = quickStylePresetToBrandProfile(stylePresetKey);
      const preset = getQuickStylePreset(stylePresetKey);
      if (preset) ctaStyle = preset.defaultCtaStyle;
    }
    if (ctaOverride) ctaStyle = ctaOverride;

    const generationReserve = await reserveScriptGeneration(authUser.id, access.access.cohort);
    if (!generationReserve.allowed) {
      return NextResponse.json(
        { code: "SCRIPT_LIMIT", error: generationReserve.message },
        { status: 403 },
      );
    }
    reservedUserId = authUser.id;
    reservationId = generationReserve.reservationId;

    const triad = await resolveLlmTriad(
      authUser.id,
      { script: isQuickMode ? topicCheck.topic : `${topicCheck.topic}\n${hookText}` },
      { count: PRO_TIER_TEXT_CALL_COST },
    );
    if (!triad.ok) {
      await settle(false);
      return NextResponse.json(triad.body, { status: triad.status });
    }
    const { apiKey } = triad;
    const wordBudget = wordBudgetForDuration(durationSec);

    if (isQuickMode) {
      const prompt = buildQuickGeneratePrompt({
        topic: topicCheck.topic,
        durationSec,
        wordBudget,
        ctaStyle,
        preferredStructure,
        profile,
      });

      let guarded: GuardedGeneration<QuickGenerateScriptResult> | null;
      try {
        guarded = await generateWithBannedWordGuard<QuickGenerateScriptResult>({
          bannedWords,
          extractText: (r) => `${r.hookText}\n${r.bodyText}\n${r.ctaText}`,
          generate: (sternNote) =>
            generateValidatedJson({
              apiKey,
              prompt: `${prompt}${sternNote}`,
              maxOutputTokens: 4096,
              tier: "pro",
              validate: repairQuickGenerateResponse,
            }),
        });
      } catch (error) {
        const llmError = heroScriptLlmErrorResponse(error, {
          route: "POST /api/scripts/generate",
          tier: "pro",
        });
        if (llmError) {
          await settle(false);
          return llmError;
        }
        throw error;
      }
      if (!guarded) {
        await settle(false);
        return NextResponse.json({ error: "AI ตอบผิดรูปแบบ ลองใหม่อีกครั้ง" }, { status: 502 });
      }

      const initialBody = stripEchoedHook(guarded.result.bodyText, guarded.result.hookText);
      const lengthGuarded = await compactScriptIfOverBudget({
        script: {
          hookText: guarded.result.hookText,
          bodyText: initialBody,
          ctaText: guarded.result.ctaText,
        },
        durationSec,
        bannedWords,
        runCompact: () => generateValidatedJson({
          apiKey,
          prompt: buildCompactScriptPrompt({
            topic: topicCheck.topic,
            durationSec,
            wordBudget,
            current: {
              hookText: guarded!.result.hookText,
              bodyText: initialBody,
              ctaText: guarded!.result.ctaText,
            },
            ctaStyle,
            profile,
          }),
          maxOutputTokens: 3072,
          tier: "pro",
          validate: validateCompactResponse,
        }),
      });

      await settle(true);
      return NextResponse.json({
        hookFormula: guarded.result.hookFormula,
        hookText: guarded.result.hookText,
        alternativeHooks: guarded.result.alternativeHooks,
        structure: guarded.result.structure,
        bodyText: lengthGuarded.bodyText,
        ctaText: lengthGuarded.ctaText,
        ...(lengthGuarded.compacted ? { compacted: true } : {}),
        ...(guarded.warning ? { warning: guarded.warning } : {}),
      });
    }

    const prompt = buildGeneratePrompt({
      topic: topicCheck.topic,
      durationSec,
      wordBudget,
      hookText,
      ctaStyle,
      preferredStructure,
      profile,
    });

    let guarded: GuardedGeneration<GenerateScriptResult> | null;
    try {
      guarded = await generateWithBannedWordGuard<GenerateScriptResult>({
        bannedWords,
        extractText: (r) => `${r.bodyText}\n${r.ctaText}`,
        generate: (sternNote) =>
          generateValidatedJson({
            apiKey,
            prompt: `${prompt}${sternNote}`,
            maxOutputTokens: 4096,
            tier: "pro",
            validate: validateGenerateResponse,
          }),
      });
    } catch (error) {
      const llmError = heroScriptLlmErrorResponse(error, {
        route: "POST /api/scripts/generate",
        tier: "pro",
      });
      if (llmError) {
        await settle(false);
        return llmError;
      }
      throw error;
    }
    if (!guarded) {
      await settle(false);
      return NextResponse.json({ error: "AI ตอบผิดรูปแบบ ลองใหม่อีกครั้ง" }, { status: 502 });
    }

    const initialBody = stripEchoedHook(guarded.result.bodyText, hookText);
    const lengthGuarded = await compactScriptIfOverBudget({
      script: {
        hookText,
        bodyText: initialBody,
        ctaText: guarded.result.ctaText,
      },
      durationSec,
      bannedWords,
      runCompact: () => generateValidatedJson({
        apiKey,
        prompt: buildCompactScriptPrompt({
          topic: topicCheck.topic,
          durationSec,
          wordBudget,
          current: {
            hookText,
            bodyText: initialBody,
            ctaText: guarded!.result.ctaText,
          },
          ctaStyle,
          profile,
        }),
        maxOutputTokens: 3072,
        tier: "pro",
        validate: validateCompactResponse,
      }),
    });

    await settle(true);
    return NextResponse.json({
      structure: guarded.result.structure,
      bodyText: lengthGuarded.bodyText,
      ctaText: lengthGuarded.ctaText,
      ...(lengthGuarded.compacted ? { compacted: true } : {}),
      ...(guarded.warning ? { warning: guarded.warning } : {}),
    });
  } catch (error) {
    await settle(false);
    return apiError({ route: "POST /api/scripts/generate", error });
  }
}
