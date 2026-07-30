import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { canCreateBrandProfile, serializeBannedWords, toBrandProfileDTO } from "@/lib/hero-script.server";

// GET /api/brand-profiles - list the current user's brand profiles
export async function GET() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
    const bannedWords = Array.isArray(body?.bannedWords) ? body.bannedWords : [];

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
        sampleText: typeof body?.sampleText === "string" ? body.sampleText : null,
        sampleUrl: typeof body?.sampleUrl === "string" ? body.sampleUrl : null,
        analysisNotes: typeof body?.analysisNotes === "string" ? body.analysisNotes : null,
      },
    });

    return NextResponse.json(toBrandProfileDTO(profile), { status: 201 });
  } catch (error) {
    return apiError({ route: "POST /api/brand-profiles", error });
  }
}
