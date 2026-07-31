import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { buildNicheDrilldownPrompt } from "@/lib/prompts/hero-script";
import {
  generateValidatedJson,
  heroScriptLlmErrorResponse,
  requireHeroScriptUser,
  resolveLlmTriad,
  validateNicheIdeasResponse,
  validateNicheSeed,
} from "@/lib/hero-script.server";

// POST /api/brand-profiles/niche-ideas - {seed} → {niches: [...] x 7}
// (ใช้ endpoint เดียวกันขุดซ้ำได้: ส่งนิชที่เพิ่งเลือกกลับมาเป็น seed เพื่อลงลึกอีกชั้น)
export async function POST(req: Request) {
  try {
    const access = await requireHeroScriptUser();
    if (!access.ok) return access.response;
    const authUser = access.user;

    const body = await req.json().catch(() => null);
    const seedCheck = validateNicheSeed(body?.seed);
    if (!seedCheck.ok) return NextResponse.json({ error: seedCheck.message }, { status: 400 });

    const triad = await resolveLlmTriad(authUser.id, { script: seedCheck.seed });
    if (!triad.ok) return NextResponse.json(triad.body, { status: triad.status });
    const { apiKey } = triad;

    const prompt = buildNicheDrilldownPrompt(seedCheck.seed);
    const result = await generateValidatedJson({
      apiKey,
      prompt,
      maxOutputTokens: 2500,
      validate: validateNicheIdeasResponse,
    });
    if (!result) {
      return NextResponse.json({ error: "AI ตอบผิดรูปแบบ ลองใหม่อีกครั้ง" }, { status: 502 });
    }

    return NextResponse.json(result);
  } catch (error) {
    // Model gone / provider credit spent → an honest 503 with Thai copy, never
    // a generic 500 and never a fallback to another model (ADR 0004).
    const llmError = heroScriptLlmErrorResponse(error, {
      route: "POST /api/brand-profiles/niche-ideas",
      tier: "fast",
    });
    if (llmError) return llmError;
    return apiError({ route: "POST /api/brand-profiles/niche-ideas", error });
  }
}
