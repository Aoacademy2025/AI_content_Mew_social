import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

// POST /api/videos/webhook - Receive video completion from n8n
export async function POST(req: Request) {
  try {
    const {
      videoId,
      status,
      video_url,
      thumbnail_url,
      error,
    } = await req.json();

    if (!videoId) {
      return NextResponse.json(
        { error: "Video ID is required" },
        { status: 400 }
      );
    }

    // Find video
    const video = await prisma.video.findUnique({
      where: { id: videoId },
    });

    if (!video) {
      return NextResponse.json({ error: "Video not found" }, { status: 404 });
    }

    // Update video based on status
    if (status === "completed" && video_url) {
      await prisma.video.update({
        where: { id: videoId },
        data: {
          status: "COMPLETED",
          videoUrl: video_url,
          thumbnail: thumbnail_url || null,
        },
      });

      return NextResponse.json(
        { message: "Video updated successfully" },
        { status: 200 }
      );
    } else if (status === "failed" || error) {
      await prisma.video.update({
        where: { id: videoId },
        data: {
          status: "FAILED",
        },
      });

      return NextResponse.json(
        { message: "Video marked as failed" },
        { status: 200 }
      );
    } else if (status === "processing") {
      await prisma.video.update({
        where: { id: videoId },
        data: {
          status: "PROCESSING",
        },
      });

      return NextResponse.json(
        { message: "Video status updated" },
        { status: 200 }
      );
    }

    return NextResponse.json(
      { error: "Invalid status or missing video_url" },
      { status: 400 }
    );
  } catch (error) {
    return apiError({ route: "videos/webhook", error });
  }
}
