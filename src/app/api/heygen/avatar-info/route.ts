import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";

export const maxDuration = 30;
export const runtime = "nodejs";

// GET /api/heygen/avatar-info?avatarId=xxx
// Returns: { previewImageUrl, previewVideoUrl, name }
export async function GET(req: Request) {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const avatarId = searchParams.get("avatarId");
  if (!avatarId) return NextResponse.json({ error: "avatarId required" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: authUser.id }, select: { heygenKey: true } });
  if (!user?.heygenKey) return NextResponse.json({ error: "HeyGen key not set", missingKey: "heygen" }, { status: 400 });
  const heygenKey = Buffer.from(user.heygenKey, "base64").toString("utf-8");

  let res: Response;
  try {
    res = await fetch("https://api.heygen.com/v2/avatars", {
      headers: { "X-Api-Key": heygenKey },
      signal: AbortSignal.timeout(15000), // HeyGen avatar list can be slow; cap at 15s
    });
  } catch {
    return NextResponse.json({ error: "HeyGen ตอบช้า/ไม่ตอบ — ลองใหม่อีกครั้ง" }, { status: 504 });
  }
  if (res.status === 401 || res.status === 403) {
    return NextResponse.json({ error: "HeyGen key ไม่ถูกต้อง/หมดสิทธิ์", missingKey: "heygen" }, { status: res.status });
  }
  if (!res.ok) return NextResponse.json({ error: `HeyGen API error ${res.status}` }, { status: 502 });

  const data = await res.json();
  const avatars: Array<{
    avatar_id: string;
    avatar_name: string;
    preview_image_url: string;
    preview_video_url: string;
  }> = data.data?.avatars ?? [];
  // /v2/avatars also returns "talking_photos" (photo/instant avatars) under a
  // different shape — a valid Avatar ID can live there too. Search both so we
  // don't false-flag a working custom/photo avatar as "not found".
  const talkingPhotos: Array<{
    talking_photo_id: string;
    talking_photo_name?: string;
    preview_image_url?: string;
  }> = data.data?.talking_photos ?? [];

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
