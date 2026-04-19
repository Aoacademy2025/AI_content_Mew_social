import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import fs from "fs";
import path from "path";

// GET /api/videos - Get all videos for current user
export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const videos = await prisma.video.findMany({
      where: { userId: session.user.id },
      include: { content: { select: { headline: true } } },
      orderBy: { createdAt: "desc" },
    });

    const publicDir = path.join(process.cwd(), "public");

    function localFileExists(url: string | null): boolean {
      if (!url) return false;
      if (url.startsWith("http://") || url.startsWith("https://")) return true;
      return fs.existsSync(path.join(publicDir, url));
    }

    // Auto-delete records where all video files are missing
    const brokenIds: string[] = [];
    const valid = videos.filter(v => {
      const hasFile = localFileExists(v.videoUrl) || localFileExists(v.avatarVideoUrl);
      if (!hasFile) brokenIds.push(v.id);
      return hasFile;
    });

    if (brokenIds.length > 0) {
      await prisma.video.deleteMany({ where: { id: { in: brokenIds } } });
      console.log(`[videos] auto-deleted ${brokenIds.length} broken records`);
    }

    return NextResponse.json(valid);
  } catch (error) {
    return apiError({ route: "videos", error });
  }
}

// POST /api/videos - Create new video
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const {
      contentId,
      avatarModel,
      voiceModel,
      imageModel,
      sceneCount,
      script,
      sceneMapping,
      videoUrl,
      audioUrl,
      avatarVideoUrl,
      status,
      renderConfig,
    } = await req.json();

    const video = await prisma.video.create({
      data: {
        contentId: contentId ?? null,
        avatarModel: avatarModel ?? "unknown",
        voiceModel: voiceModel ?? "unknown",
        imageModel: imageModel ?? null,
        sceneCount: sceneCount ?? 1,
        script: script ?? null,
        sceneMapping: sceneMapping ?? null,
        videoUrl: videoUrl ?? null,
        audioUrl: audioUrl ?? null,
        avatarVideoUrl: avatarVideoUrl ?? null,
        renderConfig: renderConfig ? (typeof renderConfig === "string" ? renderConfig : JSON.stringify(renderConfig)) : null,
        status: status ?? "COMPLETED",
        userId: session.user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    return NextResponse.json(video, { status: 201 });
  } catch (error) {
    return apiError({ route: "videos", error });
  }
}