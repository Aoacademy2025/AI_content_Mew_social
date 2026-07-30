import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { buildIdeasPrompt, type BrandProfileForPrompt } from "@/lib/prompts/hero-script";
import {
  generateValidatedJson,
  getRecentScriptTopics,
  resolveLlmTriad,
  toBrandProfileDTO,
  validateIdeasResponse,
} from "@/lib/hero-script.server";

// POST /api/scripts/ideas - {brandProfileId?} → {ideas: [{topic, angle}] x 8}
//
// brandProfileId is optional here (the spec's contract table shows it without
// a "?", but the whole Hero Script flow — per BrandProfilePanel's "ไม่ใช้
// โปรไฟล์" option and the shared spec's "Profile optional" step-1 rule — must
// support step 2 (หัวข้อ) with no profile selected; treating it as optional
// keeps that consistent instead of hard-blocking idea generation on a profile
// pick). When provided, the server loads that profile's last 20 Script topics
// (createdAt desc) and injects them into the IDEAS prompt's continuity block;
// when omitted, ideas are generated without brand context or continuity.
export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => null);
    const brandProfileId =
      typeof body?.brandProfileId === "string" && body.brandProfileId.trim()
        ? body.brandProfileId.trim()
        : null;

    let profile: BrandProfileForPrompt | null = null;
    let recentTopics: string[] = [];
    if (brandProfileId) {
      const row = await prisma.brandProfile.findFirst({
        where: { id: brandProfileId, userId: authUser.id },
      });
      if (!row) return NextResponse.json({ error: "ไม่พบโปรไฟล์แบรนด์" }, { status: 404 });
      profile = toBrandProfileDTO(row);
      recentTopics = await getRecentScriptTopics(authUser.id, brandProfileId);
    }

    const triad = await resolveLlmTriad(authUser.id, {});
    if (!triad.ok) return NextResponse.json(triad.body, { status: triad.status });
    const { apiKey } = triad;

    const prompt = buildIdeasPrompt({ profile, recentTopics });
    const result = await generateValidatedJson({
      apiKey,
      prompt,
      maxOutputTokens: 2000,
      validate: validateIdeasResponse,
    });
    if (!result) {
      return NextResponse.json({ error: "AI ตอบผิดรูปแบบ ลองใหม่อีกครั้ง" }, { status: 502 });
    }

    return NextResponse.json(result);
  } catch (error) {
    return apiError({ route: "POST /api/scripts/ideas", error });
  }
}
