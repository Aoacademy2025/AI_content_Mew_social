import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const maxDuration = 30;
export const runtime = "nodejs";

// GET /api/heygen/avatar-info?avatarId=xxx
// Returns: { previewImageUrl, previewVideoUrl, name }
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const avatarId = searchParams.get("avatarId");
  if (!avatarId) return NextResponse.json({ error: "avatarId required" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { heygenKey: true } });
  if (!user?.heygenKey) return NextResponse.json({ error: "HeyGen key not set", missingKey: "heygen" }, { status: 400 });
  const heygenKey = Buffer.from(user.heygenKey, "base64").toString("utf-8");

  const res = await fetch("https://api.heygen.com/v2/avatars", {
    headers: { "X-Api-Key": heygenKey },
  });
  if (!res.ok) return NextResponse.json({ error: "HeyGen API failed" }, { status: 500 });

  const data = await res.json();
  const avatars: Array<{
    avatar_id: string;
    avatar_name: string;
    preview_image_url: string;
    preview_video_url: string;
  }> = data.data?.avatars ?? [];

  const found = avatars.find((a) => a.avatar_id === avatarId);
  if (!found) return NextResponse.json({ error: "Avatar not found" }, { status: 404 });

  return NextResponse.json({
    previewImageUrl: found.preview_image_url,
    previewVideoUrl: found.preview_video_url,
    name: found.avatar_name,
  });
}
