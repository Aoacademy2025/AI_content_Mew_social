import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { getHeyGenAvatarList, HeyGenAuthError } from "@/lib/heygen-avatars";

export const maxDuration = 30;
export const runtime = "nodejs";

// GET /api/heygen/avatar-info?avatarId=xxx[&refresh=1]
// Returns: { previewImageUrl, previewVideoUrl, name }  ·  refresh=1 bypasses the cache (reload button)
export async function GET(req: Request) {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const avatarId = searchParams.get("avatarId");
  if (!avatarId) return NextResponse.json({ error: "avatarId required" }, { status: 400 });
  const refresh = searchParams.get("refresh") === "1";

  const user = await prisma.user.findUnique({ where: { id: authUser.id }, select: { heygenKey: true } });
  if (!user?.heygenKey) return NextResponse.json({ error: "HeyGen key not set", missingKey: "heygen" }, { status: 400 });
  const heygenKey = Buffer.from(user.heygenKey, "base64").toString("utf-8");

  // Cached per-user list fetch (retry/timeout/backoff live in the helper). Failures are NOT cached,
  // so a reload after a slow HeyGen response re-fetches. Preserve the graceful "unverified" UX on a
  // slow HeyGen, and the explicit key-error on 401/403.
  let avatars: any[];
  let talkingPhotos: any[];
  try {
    const list = await getHeyGenAvatarList(authUser.id, heygenKey, { refresh });
    avatars = list.avatars;
    talkingPhotos = list.talkingPhotos;
  } catch (err) {
    if (err instanceof HeyGenAuthError) {
      console.warn(`[avatar-info] HeyGen ${err.status} — key len=${heygenKey.length}`);
      return NextResponse.json({ error: "HeyGen key ไม่ถูกต้อง/หมดสิทธิ์", missingKey: "heygen" }, { status: err.status });
    }
    console.error("[avatar-info] list fetch failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({
      previewImageUrl: "", name: "", unverified: true,
      note: "HeyGen ตอบช้า — ยืนยัน ID ไม่ได้ แต่ลอง render ได้",
    });
  }

  const found = avatars.find((a) => a.avatar_id === avatarId);
  if (found) {
    return NextResponse.json({
      previewImageUrl: found.preview_image_url,
      previewVideoUrl: found.preview_video_url,
      name: found.avatar_name,
    });
  }
  const photo = talkingPhotos.find((t) => t.talking_photo_id === avatarId);
  if (photo) {
    return NextResponse.json({
      previewImageUrl: photo.preview_image_url ?? "",
      previewVideoUrl: "",
      name: photo.talking_photo_name ?? "Photo Avatar",
    });
  }

  // Not in either list. HeyGen's listing is not always exhaustive (shared/group
  // avatars, region differences), and this ID may still render fine — so DON'T
  // hard-fail. Return 200 with unverified:true so the UI can say "can't confirm,
  // but you can still try" instead of falsely blocking a usable avatar.
  const totalListed = avatars.length + talkingPhotos.length;
  return NextResponse.json({
    previewImageUrl: "",
    name: "",
    unverified: true,
    note: `ไม่พบใน list (${totalListed} avatars) — อาจยังใช้ได้ ลอง render ดู`,
  });
}
