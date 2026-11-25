import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { isValidCtaStyleKey } from "@/lib/viral-frameworks";
import {
  getQuickStylePreset,
  isValidQuickStylePresetKey,
  quickStylePresetToBrandProfile,
} from "@/lib/hero-script-presets";
import {
  buildCompactScriptPrompt,
  type BrandProfileForPrompt,
} from "@/lib/prompts/hero-script";
import {
  assembleScript,
  generateValidatedJson,
  generateWithBannedWordGuard,
  heroScriptLlmErrorResponse,
  isValidDurationSec,
  requireHeroScriptUser,
  resolveHeroScriptBrandProfile,
  resolveLlmTriad,
  stripEchoedHook,
  validateCompactResponse,
  validateTopic,
  wordBudgetForDuration,
  PRO_TIER_TEXT_CALL_COST,
  type CompactScriptResult,
  type GuardedGeneration,
} from "@/lib/hero-script.server";

// POST /api/scripts/compact — tighten body + CTA to fit `durationSec` word
// budget while preserving the user's Hook verbatim.
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

    const rawCurrent = body?.current;
    const current = {
      hookText: typeof rawCurrent?.hookText === "string" ? rawCurrent.hookText.trim() : "",
      bodyText: typeof rawCurrent?.bodyText === "string" ? rawCurrent.bodyText.trim() : "",
      ctaText: typeof rawCurrent?.ctaText === "string" ? rawCurrent.ctaText.trim() : "",
    };
    if (!current.hookText || (!current.bodyText && !current.ctaText)) {
      return NextResponse.json({ error: "ยังไม่มีเนื้อหาสคริปต์ให้กระชับ" }, { status: 400 });
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

    const triad = await resolveLlmTriad(
      authUser.id,
      { script: assembleScript(current) },
      { count: PRO_TIER_TEXT_CALL_COST },
    );
    if (!triad.ok) return NextResponse.json(triad.body, { status: triad.status });
    const { apiKey } = triad;

    const prompt = buildCompactScriptPrompt({
      topic: topicCheck.topic,
      durationSec,
      wordBudget: wordBudgetForDuration(durationSec),
      current,
      ctaStyle,
      profile,
    });

    let guarded: GuardedGeneration<CompactScriptResult> | null;
    try {
      guarded = await generateWithBannedWordGuard<CompactScriptResult>({
        bannedWords,
        extractText: (r) => `${r.bodyText}\n${r.ctaText}`,
        generate: (sternNote) =>
          generateValidatedJson({
            apiKey,
            prompt: `${prompt}${sternNote}`,
            maxOutputTokens: 3072,
            tier: "pro",
            validate: validateCompactResponse,
          }),
      });
    } catch (error) {
      const llmError = heroScriptLlmErrorResponse(error, {
        route: "POST /api/scripts/compact",
        tier: "pro",
      });
      if (llmError) return llmError;
      throw error;
    }
    if (!guarded) {
      return NextResponse.json({ error: "AI ตอบผิดรูปแบบ ลองใหม่อีกครั้ง" }, { status: 502 });
    }

    return NextResponse.json({
      bodyText: stripEchoedHook(guarded.result.bodyText, current.hookText),
      ctaText: guarded.result.ctaText,
      ...(guarded.warning ? { warning: guarded.warning } : {}),
    });
  } catch (error) {
    return apiError({ route: "POST /api/scripts/compact", error });
  }
}
