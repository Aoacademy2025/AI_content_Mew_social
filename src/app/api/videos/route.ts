import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

// GET /api/videos - Get all videos for current user
export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const videos = await prisma.video.findMany({
      where: {
        userId: session.user.id,
      },
      include: {
        content: {
          select: {
            headline: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json(videos);
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

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
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
        expiresAt,
      },
    });

    return NextResponse.json(video, { status: 201 });
  } catch (error) {
    return apiError({ route: "videos", error });
  }
}