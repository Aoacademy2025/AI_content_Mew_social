import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { requireHeroScriptUser, serializeBannedWords, toBrandProfileDTO } from "@/lib/hero-script.server";
import { checkBrandProfileFieldLimits } from "@/lib/brand-profile-limits";
import { isValidCtaStyleKey } from "@/lib/viral-frameworks";

// PUT /api/brand-profiles/[id] - update a brand profile (full update, same
// required fields as POST — matches the existing /api/styles/[id] convention)
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const access = await requireHeroScriptUser();
    if (!access.ok) return access.response;
    const authUser = access.user;
    const { id } = await params;

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
    // Skip-if-absent (matches `language` below) — omitting a key from the PUT
    // body must NOT reset the stored value. ctaStyle was fixed in the Task 2
    // review; bannedWords had the same bug (an omitted key wiped the list back
    // to []) and the three analyze-derived columns were not patchable at all.
    const ctaStyle = typeof body?.ctaStyle === "string" && body.ctaStyle.trim() ? body.ctaStyle.trim() : undefined;
    if (ctaStyle !== undefined && !isValidCtaStyleKey(ctaStyle)) {
      return NextResponse.json({ error: "กรุณาระบุสไตล์ CTA ให้ถูกต้อง" }, { status: 400 });
    }
    // An explicit [] still clears the list; only an absent/non-array key skips.
    const bannedWords = Array.isArray(body?.bannedWords) ? body.bannedWords : undefined;
    // A blank string clears the column; anything non-string leaves it as stored.
    const analysisNotes = typeof body?.analysisNotes === "string" ? body.analysisNotes.trim() || null : undefined;
    const sampleText = typeof body?.sampleText === "string" ? body.sampleText.trim() || null : undefined;
    const sampleUrl = typeof body?.sampleUrl === "string" ? body.sampleUrl.trim() || null : undefined;

    // Length caps: these fields land in buildBrandBlock on EVERY later LLM call
    // but never pass through checkAiInputCaps — see brand-profile-limits.ts.
    const limits = checkBrandProfileFieldLimits({
      name, niche, audience, tone, analysisNotes, sampleText, sampleUrl, bannedWords,
    });
    if (!limits.ok) return NextResponse.json({ error: limits.message }, { status: 400 });

    const updated = await prisma.brandProfile.updateMany({
      where: { id, userId: authUser.id },
      data: {
        name,
        niche,
        audience,
        tone,
        ctaStyle,
        bannedWords: bannedWords ? serializeBannedWords(bannedWords) : undefined,
        analysisNotes,
        sampleText,
        sampleUrl,
        language: typeof body?.language === "string" && body.language.trim() ? body.language.trim() : undefined,
      },
    });
    if (updated.count === 0) return NextResponse.json({ error: "ไม่พบโปรไฟล์" }, { status: 404 });

    const row = await prisma.brandProfile.findUnique({ where: { id } });
    return NextResponse.json(row ? toBrandProfileDTO(row) : null);
  } catch (error) {
    return apiError({ route: "PUT /api/brand-profiles/[id]", error });
  }
}

// DELETE /api/brand-profiles/[id]
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const access = await requireHeroScriptUser();
    if (!access.ok) return access.response;
    const authUser = access.user;
    const { id } = await params;

    const deleted = await prisma.brandProfile.deleteMany({ where: { id, userId: authUser.id } });
    if (deleted.count === 0) return NextResponse.json({ error: "ไม่พบโปรไฟล์" }, { status: 404 });

    return NextResponse.json({ message: "ลบโปรไฟล์แล้ว" });
  } catch (error) {
    return apiError({ route: "DELETE /api/brand-profiles/[id]", error });
  }
}
