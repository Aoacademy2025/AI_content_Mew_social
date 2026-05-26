import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

// GET /api/videos/[id] - Get single video
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getCurrentUser();
    const { id } = await params;

    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const video = await prisma.video.findFirst({
      where: {
        id,
        userId: authUser.id,
      },
      include: {
        content: true,
      },
    });

    if (!video) {
      return NextResponse.json({ error: "Video not found" }, { status: 404 });
    }

    return NextResponse.json(video);
  } catch (error) {
    return apiError({ route: "videos/[id]", error });
  }
}

// PATCH /api/videos/[id] - Partial update (used by video-editor auto-save)
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getCurrentUser();
    const { id } = await params;
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const data: Record<string, unknown> = {};

    // Whitelist updatable fields
    if (body.status !== undefined) data.status = body.status;
    if (body.videoUrl !== undefined) data.videoUrl = body.videoUrl;
    if (body.audioUrl !== undefined) data.audioUrl = body.audioUrl;
    if (body.avatarVideoUrl !== undefined) data.avatarVideoUrl = body.avatarVideoUrl;
    if (body.thumbnail !== undefined) data.thumbnail = body.thumbnail;
    if (body.script !== undefined) data.script = body.script;
    if (body.avatarModel !== undefined) data.avatarModel = body.avatarModel;
    if (body.voiceModel !== undefined) data.voiceModel = body.voiceModel;
    if (body.sceneCount !== undefined) data.sceneCount = body.sceneCount;
    if (body.renderConfig !== undefined) {
      data.renderConfig = typeof body.renderConfig === "string"
        ? body.renderConfig
        : JSON.stringify(body.renderConfig);
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    const updated = await prisma.video.updateMany({
      where: { id, userId: authUser.id },
      data,
    });
    if (updated.count === 0) return NextResponse.json({ error: "Video not found" }, { status: 404 });

    const video = await prisma.video.findUnique({ where: { id } });
    return NextResponse.json(video);
  } catch (error) {
    return apiError({ route: "PATCH videos/[id]", error });
  }
}

// PUT /api/videos/[id] - Update video
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getCurrentUser();
    const { id } = await params;

    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { status, videoUrl, audioUrl, avatarVideoUrl, thumbnail } =
      await req.json();

    const updated = await prisma.video.updateMany({
      where: {
        id,
        userId: authUser.id,
      },
      data: {
        status,
        videoUrl,
        audioUrl,
        avatarVideoUrl,
        thumbnail,
      },
    });

    if (updated.count === 0) {
      return NextResponse.json({ error: "Video not found" }, { status: 404 });
    }

    const video = await prisma.video.findUnique({
      where: { id },
    });

    return NextResponse.json(video);
  } catch (error) {
    return apiError({ route: "videos/[id]", error });
  }
}

// DELETE /api/videos/[id] - Delete video
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getCurrentUser();
    const { id } = await params;

    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const deleted = await prisma.video.deleteMany({
      where: {
        id,
        userId: authUser.id,
      },
    });

    if (deleted.count === 0) {
      return NextResponse.json({ error: "Video not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Video deleted successfully" });
  } catch (error) {
    return apiError({ route: "videos/[id]", error });
  }
}