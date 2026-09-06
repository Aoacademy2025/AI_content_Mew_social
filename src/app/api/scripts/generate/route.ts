import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { isValidHookFormulaKey } from "@/lib/viral-frameworks";
import {
  buildGeneratePrompt,
  type BrandProfileForPrompt,
  buildScriptCorrectionOptionsNote,
} from "@/lib/prompts/hero-script";
import {
  generateValidatedJson,
  generateWithScriptGuard,
  validateScriptCorrectionOptions,
  heroScriptLlmErrorResponse,
  isValidDurationSec,
  requireHeroScriptUser,
  reserveScriptGeneration,
  resolveHeroScriptBrandProfile,
  resolveLlmTriad,
  settleScriptGeneration,
  stripEchoedHook,
  validateGenerateResponse,
  validateTopic,
  wordBudgetForDuration,
  PRO_TIER_TEXT_CALL_COST,
  type GenerateScriptResult,
  type GuardedGeneration,
} from "@/lib/hero-script.server";

// POST /api/scripts/generate — {topic, hookText, hookFormula, brandProfileId?,
// durationSec} → {structure, bodyText, ctaText} (+ optional `warning`).
//
// PRO model (spec Global Constraints: full script + section regenerate run on
// HERO_SCRIPT_MODEL_PRO). The chosen hook is NEVER round-tripped through the
// model: it goes into the prompt verbatim as fixed context, the response
// contract has no hook field, and the client keeps its own copy as line 1 — so
// a model that paraphrases the hook can't overwrite the user's wording. If the
// model echoes the hook as the first body line we drop that line instead
// (stripEchoedHook), otherwise the assembled script would say it twice.
export async function POST(req: Request) {
  let reservedUserId: string | null = null;
  let reservationId: string | null = null;
  async function settle(succeeded: boolean) {
    if (!reservedUserId || !reservationId) return;
    const id = reservationId;
    if (succeeded) {
      // A successful output must not be returned unless its durable quota row
      // is committed. If this throws, the outer catch releases the reservation
      // and returns an error instead of silently creating a quota bypass.
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

    const hookText = typeof body?.hookText === "string" ? body.hookText.trim() : "";
    if (!hookText) {
      return NextResponse.json({ error: "กรุณาเลือก hook ก่อนสร้างสคริปต์เต็ม" }, { status: 400 });
    }
    // hookFormula travels with the hook so the client can save it on the Script
    // row; the GENERATE prompt itself doesn't need it (the hook text is fixed).
    const hookFormula = typeof body?.hookFormula === "string" ? body.hookFormula.trim() : "";
    if (hookFormula && !isValidHookFormulaKey(hookFormula)) {
      return NextResponse.json({ error: "สูตร hook ไม่ถูกต้อง" }, { status: 400 });
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
    }

    // Product entitlement is reserved BEFORE the provider call. This closes
    // the old hole where FREE users received the full output and only hit the
    // 3-script wall later during autosave (or deleted rows to restore slots).
    const generationReserve = await reserveScriptGeneration(authUser.id, access.access.cohort);
    if (!generationReserve.allowed) {
      return NextResponse.json(
        { code: "SCRIPT_LIMIT", error: generationReserve.message },
        { status: 403 },
      );
    }
    reservedUserId = authUser.id;
    reservationId = generationReserve.reservationId;

    // count: PRO tier — one request can be up to 4 model round-trips on the
    // expensive model (see resolveLlmTriad).
    const triad = await resolveLlmTriad(
      authUser.id,
      { script: `${topicCheck.topic}\n${hookText}` },
      { count: PRO_TIER_TEXT_CALL_COST }
    );
    if (!triad.ok) {
      await settle(false);
      return NextResponse.json(triad.body, { status: triad.status });
    }
    const { apiKey } = triad;

    const prompt = buildGeneratePrompt({
      topic: topicCheck.topic,
      durationSec,
      wordBudget: wordBudgetForDuration(durationSec),
      hookText,
      ctaStyle,
      profile,
    });

    // Duration and banned words share one bounded text correction.
    let guarded: GuardedGeneration<GenerateScriptResult> | null;
    try {
      guarded = await generateWithScriptGuard<GenerateScriptResult>({
        bannedWords,
        extractText: (r) => `${stripEchoedHook(r.bodyText, hookText)}\n${r.ctaText}`,
        duration: {
          seconds: durationSec,
          assemble: (r) => `${hookText}\n${stripEchoedHook(r.bodyText, hookText)}\n${r.ctaText}`,
        },
        correct: (note) => generateValidatedJson({
          apiKey,
          prompt: `${prompt}${note}${buildScriptCorrectionOptionsNote(wordBudgetForDuration(durationSec))}`,
          maxOutputTokens: durationSec === 30 ? 4096 : 8192,
          tier: "pro",
          validate: (data) => validateScriptCorrectionOptions(data, validateGenerateResponse),
        }),
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
      // The pro model id is gone/unusable, or the provider's credit is spent →
      // say so (503), never fall back to the fast model or the other provider
      // (ADR 0004). Everything else keeps its own path.
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

    const { structure, bodyText, ctaText } = guarded.result;
    await settle(true);
    return NextResponse.json({
      structure,
      bodyText: stripEchoedHook(bodyText, hookText),
      ctaText,
      ...(guarded.warning ? { warning: guarded.warning } : {}),
    });
  } catch (error) {
    await settle(false);
    return apiError({ route: "POST /api/scripts/generate", error });
  }
}
