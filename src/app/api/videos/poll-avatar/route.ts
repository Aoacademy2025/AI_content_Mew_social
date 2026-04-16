import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const maxDuration = 30;
export const runtime = "nodejs";

function decrypt(encrypted: string): string {
  return Buffer.from(encrypted, "base64").toString("utf-8");
}

// POST /api/videos/poll-avatar
// Body: { videoId: string }
// Returns: { status: string, videoUrl: string | null, errorMsg: string | null }
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const videoId: string = body?.videoId ?? "";
    if (!videoId) return NextResponse.json({ error: "videoId required" }, { status: 400 });

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { heygenKey: true },
    });

    if (!user?.heygenKey) {
      return NextResponse.json({ error: "HeyGen API key not set", missingKey: "heygen" }, { status: 400 });
    }

    const heygenKey = decrypt(user.heygenKey);

    const res = await fetch(
      `https://api.heygen.com/v1/video_status.get?video_id=${videoId}`,
      { headers: { "X-Api-Key": heygenKey } }
    );

    const data = await res.json();
    console.log("[poll-avatar]", JSON.stringify(data));

    return NextResponse.json({
      status: data.data?.status ?? "unknown",
      videoUrl: data.data?.video_url ?? null,
      thumbnailUrl: data.data?.thumbnail_url ?? null,
      errorMsg: data.data?.error ?? null,
    });
  } catch (error) {
    console.error("poll-avatar error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Poll failed" },
      { status: 500 }
    );
  }
}
