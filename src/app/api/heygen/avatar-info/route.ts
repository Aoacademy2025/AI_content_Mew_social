import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { getHeyGenAvatarDetails, HeyGenAuthError } from "@/lib/heygen-avatars";

export const maxDuration = 30;
export const runtime = "nodejs";

// GET /api/heygen/avatar-info?avatarId=xxx
// Returns: { previewImageUrl, previewVideoUrl, name }
//
// Looks up the SINGLE avatar by ID via `/v2/avatar/{id}/details` (~0.8s) instead of fetching the
// whole `/v2/avatars` list (intermittently 30-100s+). So the preview shows fast when the user types
// an avatar ID — even while HeyGen's full-list endpoint is slow. A not-found ID still degrades to
// "unverified — can still render" (generation uses the ID directly; it never hard-blocks).
export async function GET(req: Request) {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const avatarId = searchParams.get("avatarId");
  if (!avatarId) return NextResponse.json({ error: "avatarId required" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: authUser.id }, select: { heygenKey: true } });
  if (!user?.heygenKey) return NextResponse.json({ error: "HeyGen key not set", missingKey: "heygen" }, { status: 400 });
  const heygenKey = Buffer.from(user.heygenKey, "base64").toString("utf-8");

  let details;
  try {
    details = await getHeyGenAvatarDetails(avatarId, heygenKey);
  } catch (err) {
    if (err instanceof HeyGenAuthError) {
      console.warn(`[avatar-info] HeyGen ${err.status} — key len=${heygenKey.length}`);
      return NextResponse.json({ error: "HeyGen key ไม่ถูกต้อง/หมดสิทธิ์", missingKey: "heygen" }, { status: err.status });
    }
    console.error("[avatar-info] details fetch failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({
      previewImageUrl: "", name: "", unverified: true,
      note: "HeyGen ตอบช้า — ยืนยัน ID ไม่ได้ แต่ลอง render ได้",
    });
  }

  if (details) {
    return NextResponse.json({
      previewImageUrl: details.previewImageUrl,
      previewVideoUrl: details.previewVideoUrl,
      name: details.name,
    });
  }

  // Not found via either avatar/photo endpoint. The ID may still render fine (shared/group avatars,
  // region differences), so DON'T hard-fail — let the UI say "can't confirm, but you can still try".
  return NextResponse.json({
    previewImageUrl: "",
    name: "",
    unverified: true,
    note: "ไม่พบ avatar นี้ — อาจยังใช้ได้ ลอง render ดู",
  });
}
