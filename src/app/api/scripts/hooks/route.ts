import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { buildHooksPrompt, type BrandProfileForPrompt } from "@/lib/prompts/hero-script";
import {
  generateValidatedJson,
  heroScriptLlmErrorResponse,
  isValidDurationSec,
  requireHeroScriptUser,
  resolveHeroScriptBrandProfile,
  resolveLlmTriad,
  validateHooksResponse,
  validateTopic,
} from "@/lib/hero-script.server";

// POST /api/scripts/hooks - {topic, brandProfileId?, durationSec} →
// {hooks: [{formula, text}] x 5} — 5 DISTINCT valid HOOK_FORMULAS keys, each ≤ 20 คำ.
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

    const brandProfileId =
      typeof body?.brandProfileId === "string" && body.brandProfileId.trim()
        ? body.brandProfileId.trim()
        : null;

    let profile: BrandProfileForPrompt | null = null;
    if (brandProfileId) {
      const resolved = await resolveHeroScriptBrandProfile(authUser.id, brandProfileId);
      if (!resolved.ok) {
        return NextResponse.json(
          { code: resolved.code === "UNAVAILABLE" ? "BRAND_PROFILE_UNAVAILABLE" : undefined, error: resolved.message },
          { status: resolved.code === "NOT_FOUND" ? 404 : 403 },
        );
      }
      profile = resolved.profile;
    }

    const triad = await resolveLlmTriad(authUser.id, { script: topicCheck.topic });
    if (!triad.ok) return NextResponse.json(triad.body, { status: triad.status });
    const { apiKey } = triad;

    const prompt = buildHooksPrompt({ topic: topicCheck.topic, durationSec, profile });
    const result = await generateValidatedJson({
      apiKey,
      prompt,
      maxOutputTokens: 2000,
      validate: validateHooksResponse,
    });
    if (!result) {
      return NextResponse.json({ error: "AI ตอบผิดรูปแบบ ลองใหม่อีกครั้ง" }, { status: 502 });
    }

    return NextResponse.json(result);
  } catch (error) {
    // Model gone / provider credit spent → an honest 503 with Thai copy, never
    // a generic 500 and never a fallback to another model (ADR 0004).
    const llmError = heroScriptLlmErrorResponse(error, { route: "POST /api/scripts/hooks", tier: "fast" });
    if (llmError) return llmError;
    return apiError({ route: "POST /api/scripts/hooks", error });
  }
}
