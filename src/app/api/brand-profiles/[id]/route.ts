import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { serializeBannedWords, toBrandProfileDTO } from "@/lib/hero-script.server";

// PUT /api/brand-profiles/[id] - update a brand profile (full update, same
// required fields as POST — matches the existing /api/styles/[id] convention)
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getCurrentUser();
    const { id } = await params;
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

    const updated = await prisma.brandProfile.updateMany({
      where: { id, userId: authUser.id },
      data: {
        name,
        niche,
        audience,
        tone,
        ctaStyle,
        bannedWords: serializeBannedWords(bannedWords),
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
    const authUser = await getCurrentUser();
    const { id } = await params;
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const deleted = await prisma.brandProfile.deleteMany({ where: { id, userId: authUser.id } });
    if (deleted.count === 0) return NextResponse.json({ error: "ไม่พบโปรไฟล์" }, { status: 404 });

    return NextResponse.json({ message: "ลบโปรไฟล์แล้ว" });
  } catch (error) {
    return apiError({ route: "DELETE /api/brand-profiles/[id]", error });
  }
}
