import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { isValidHookFormulaKey } from "@/lib/viral-frameworks";
import {
  buildRegenPrompt,
  type BrandProfileForPrompt,
} from "@/lib/prompts/hero-script";
import {
  assembleScript,
  generateValidatedJson,
  generateWithBannedWordGuard,
  heroScriptLlmErrorResponse,
  isValidDurationSec,
  isValidRegenTarget,
  requireHeroScriptUser,
  resolveHeroScriptBrandProfile,
  resolveLlmTriad,
  validateRegenResponse,
  validateTopic,
  wordBudgetForDuration,
  PRO_TIER_TEXT_CALL_COST,
  type GuardedGeneration,
  type RegenSectionResult,
} from "@/lib/hero-script.server";

// POST /api/scripts/regen-section — {target: "hook"|"body"|"cta", topic,
// durationSec, brandProfileId?, current: {hookText, bodyText, ctaText}} →
// {text} (+ {formula} when target="hook", + optional `warning`).
//
// PRO model. Only the targeted section is returned; the client leaves the
// other two untouched. For target="hook" the caller also sends the CURRENT
// `hookFormula` so the prompt can ask for another formula and the server can
// verify the answer really is a different (and real) HOOK_FORMULAS key.
export async function POST(req: Request) {
  try {
    const access = await requireHeroScriptUser();
    if (!access.ok) return access.response;
    const authUser = access.user;

    const body = await req.json().catch(() => null);

    if (!isValidRegenTarget(body?.target)) {
      return NextResponse.json({ error: "ระบุส่วนที่จะเขียนใหม่ไม่ถูกต้อง" }, { status: 400 });
    }
    const target = body.target;

    const topicCheck = validateTopic(body?.topic);
    if (!topicCheck.ok) return NextResponse.json({ error: topicCheck.message }, { status: 400 });

    if (!isValidDurationSec(body?.durationSec)) {
      return NextResponse.json({ error: "กรุณาระบุความยาววิดีโอ (30, 60 หรือ 90 วินาที)" }, { status: 400 });
    }
    const durationSec = body.durationSec as 30 | 60 | 90;

    const rawCurrent = body?.current;
    const current = {
      hookText: typeof rawCurrent?.hookText === "string" ? rawCurrent.hookText.trim() : "",
      bodyText: typeof rawCurrent?.bodyText === "string" ? rawCurrent.bodyText.trim() : "",
      ctaText: typeof rawCurrent?.ctaText === "string" ? rawCurrent.ctaText.trim() : "",
    };
    if (!current.hookText && !current.bodyText && !current.ctaText) {
      return NextResponse.json({ error: "ยังไม่มีสคริปต์ให้เขียนใหม่" }, { status: 400 });
    }

    const currentFormula = typeof body?.hookFormula === "string" ? body.hookFormula.trim() : "";
    if (currentFormula && !isValidHookFormulaKey(currentFormula)) {
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

    // count: PRO tier — one request can be up to 4 model round-trips on the
    // expensive model (see resolveLlmTriad).
    const triad = await resolveLlmTriad(
      authUser.id,
      { script: assembleScript(current) },
      { count: PRO_TIER_TEXT_CALL_COST }
    );
    if (!triad.ok) return NextResponse.json(triad.body, { status: triad.status });
    const { apiKey } = triad;

    const prompt = buildRegenPrompt({
      target,
      topic: topicCheck.topic,
      durationSec,
      wordBudget: wordBudgetForDuration(durationSec),
      current,
      ctaStyle,
      currentFormula: currentFormula || null,
      profile,
    });

    let guarded: GuardedGeneration<RegenSectionResult> | null;
    try {
      guarded = await generateWithBannedWordGuard<RegenSectionResult>({
        bannedWords,
        extractText: (r) => r.text,
        generate: (sternNote) =>
          generateValidatedJson({
            apiKey,
            prompt: `${prompt}${sternNote}`,
            maxOutputTokens: target === "body" ? 4096 : 2048,
            tier: "pro",
            validate: (data) => validateRegenResponse(data, { target, currentFormula: currentFormula || null }),
          }),
      });
    } catch (error) {
      // The pro model id is gone/unusable, or the provider's credit is spent →
      // say so (503), never fall back to the fast model or the other provider
      // (ADR 0004). Everything else keeps its own path.
      const llmError = heroScriptLlmErrorResponse(error, {
        route: "POST /api/scripts/regen-section",
        tier: "pro",
      });
      if (llmError) return llmError;
      throw error;
    }
    if (!guarded) {
      return NextResponse.json({ error: "AI ตอบผิดรูปแบบ ลองใหม่อีกครั้ง" }, { status: 502 });
    }

    const { text, formula } = guarded.result;
    return NextResponse.json({
      text,
      ...(formula ? { formula } : {}),
      ...(guarded.warning ? { warning: guarded.warning } : {}),
    });
  } catch (error) {
    return apiError({ route: "POST /api/scripts/regen-section", error });
  }
}
