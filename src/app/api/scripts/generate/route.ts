import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { isValidHookFormulaKey } from "@/lib/viral-frameworks";
import {
  buildGeneratePrompt,
  type BrandProfileForPrompt,
} from "@/lib/prompts/hero-script";
import {
  generateValidatedJson,
  generateWithBannedWordGuard,
  heroScriptModel,
  isModelUnavailableError,
  isValidDurationSec,
  parseBannedWords,
  requireHeroScriptUser,
  resolveLlmTriad,
  stripEchoedHook,
  toBrandProfileDTO,
  validateGenerateResponse,
  validateTopic,
  wordBudgetForDuration,
  MODEL_UNAVAILABLE_CODE,
  MODEL_UNAVAILABLE_MESSAGE,
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
      const row = await prisma.brandProfile.findFirst({
        where: { id: brandProfileId, userId: authUser.id },
      });
      if (!row) return NextResponse.json({ error: "ไม่พบโปรไฟล์แบรนด์" }, { status: 404 });
      profile = toBrandProfileDTO(row);
      bannedWords = parseBannedWords(row.bannedWords);
      ctaStyle = row.ctaStyle || "follow";
    }

    // count: PRO tier — one request can be up to 4 model round-trips on the
    // expensive model (see resolveLlmTriad).
    const triad = await resolveLlmTriad(
      authUser.id,
      { script: `${topicCheck.topic}\n${hookText}` },
      { count: PRO_TIER_TEXT_CALL_COST }
    );
    if (!triad.ok) return NextResponse.json(triad.body, { status: triad.status });
    const { apiKey } = triad;

    const prompt = buildGeneratePrompt({
      topic: topicCheck.topic,
      durationSec,
      wordBudget: wordBudgetForDuration(durationSec),
      hookText,
      ctaStyle,
      profile,
    });

    // Banned-words guard: generate → screen → 1 retry with the stern note →
    // still there? return it WITH a warning (never block the user).
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
      // The pro model id itself is gone/unusable → say so (503), never fall
      // back to the fast model (ADR 0004). Everything else keeps its own path.
      if (isModelUnavailableError(error)) {
        // Model id only — the raw provider message can embed the API key, and
        // this path does not go through apiError's scrubber.
        console.error(`[hero-script] pro model unavailable (generate): model=${heroScriptModel("pro")}`);
        return NextResponse.json(
          { code: MODEL_UNAVAILABLE_CODE, error: MODEL_UNAVAILABLE_MESSAGE },
          { status: 503 }
        );
      }
      throw error;
    }
    if (!guarded) {
      return NextResponse.json({ error: "AI ตอบผิดรูปแบบ ลองใหม่อีกครั้ง" }, { status: 502 });
    }

    const { structure, bodyText, ctaText } = guarded.result;
    return NextResponse.json({
      structure,
      bodyText: stripEchoedHook(bodyText, hookText),
      ctaText,
      ...(guarded.warning ? { warning: guarded.warning } : {}),
    });
  } catch (error) {
    return apiError({ route: "POST /api/scripts/generate", error });
  }
}
