import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

// GET /api/videos/[id] - Get single video
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    const { id } = await params;

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const video = await prisma.video.findFirst({
      where: {
        id,
        userId: session.user.id,
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

// PUT /api/videos/[id] - Update video
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    const { id } = await params;

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { status, videoUrl, audioUrl, avatarVideoUrl, thumbnail } =
      await req.json();

    const updated = await prisma.video.updateMany({
      where: {
        id,
        userId: session.user.id,
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
    const session = await getServerSession(authOptions);
    const { id } = await params;

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const deleted = await prisma.video.deleteMany({
      where: {
        id,
        userId: session.user.id,
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