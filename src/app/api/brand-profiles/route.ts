import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import {
  canCreateBrandProfile,
  requireHeroScriptUser,
  serializeBannedWords,
  toBrandProfileDTO,
} from "@/lib/hero-script.server";
import { checkBrandProfileFieldLimits } from "@/lib/brand-profile-limits";
import { isValidCtaStyleKey } from "@/lib/viral-frameworks";

// GET /api/brand-profiles - list the current user's brand profiles
export async function GET() {
  try {
    const access = await requireHeroScriptUser();
    if (!access.ok) return access.response;
    const authUser = access.user;

    const profiles = await prisma.brandProfile.findMany({
      where: { userId: authUser.id },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(profiles.map(toBrandProfileDTO));
  } catch (error) {
    return apiError({ route: "GET /api/brand-profiles", error });
  }
}

// POST /api/brand-profiles - create a brand profile (enforces the plan cap)
export async function POST(req: Request) {
  try {
    const access = await requireHeroScriptUser();
    if (!access.ok) return access.response;
    const authUser = access.user;

    const body = await req.json().catch(() => null);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const niche = typeof body?.niche === "string" ? body.niche.trim() : "";
    const audience = typeof body?.audience === "string" ? body.audience.trim() : "";
    const tone = typeof body?.tone === "string" ? body.tone.trim() : "";
    if (!name || !niche || !audience || !tone) {
      return NextResponse.json(
        { error: "กรุณากรอกชื่อ, นิช, กลุ่มเป้าหมาย และโทนเสียงให้ครบ" },
        { status: 400 }
      );
    }
    const ctaStyle = typeof body?.ctaStyle === "string" && body.ctaStyle.trim() ? body.ctaStyle.trim() : "follow";
    if (!isValidCtaStyleKey(ctaStyle)) {
      return NextResponse.json({ error: "กรุณาระบุสไตล์ CTA ให้ถูกต้อง" }, { status: 400 });
    }
    const bannedWords = Array.isArray(body?.bannedWords) ? body.bannedWords : [];
    // Analyze-derived columns (optional): a blank value is stored as NULL, the
    // same shape PUT /api/brand-profiles/[id] writes.
    const sampleText = typeof body?.sampleText === "string" ? body.sampleText.trim() || null : null;
    const sampleUrl = typeof body?.sampleUrl === "string" ? body.sampleUrl.trim() || null : null;
    const analysisNotes = typeof body?.analysisNotes === "string" ? body.analysisNotes.trim() || null : null;

    // Length caps: these fields land in buildBrandBlock on EVERY later LLM call
    // but never pass through checkAiInputCaps — see brand-profile-limits.ts.
    const limits = checkBrandProfileFieldLimits({
      name, niche, audience, tone, analysisNotes, sampleText, sampleUrl, bannedWords,
    });
    if (!limits.ok) return NextResponse.json({ error: limits.message }, { status: 400 });

    const user = await prisma.user.findUnique({ where: { id: authUser.id }, select: { plan: true } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const count = await prisma.brandProfile.count({ where: { userId: authUser.id } });
    const capCheck = canCreateBrandProfile(user.plan, count);
    if (!capCheck.allowed) {
      return NextResponse.json({ code: "PROFILE_LIMIT", error: capCheck.message }, { status: 403 });
    }

    const profile = await prisma.brandProfile.create({
      data: {
        userId: authUser.id,
        name,
        niche,
        audience,
        tone,
        ctaStyle,
        bannedWords: serializeBannedWords(bannedWords),
        language: typeof body?.language === "string" && body.language.trim() ? body.language.trim() : "th",
        sampleText,
        sampleUrl,
        analysisNotes,
      },
    });

    return NextResponse.json(toBrandProfileDTO(profile), { status: 201 });
  } catch (error) {
    return apiError({ route: "POST /api/brand-profiles", error });
  }
}
