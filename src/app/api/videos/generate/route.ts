import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import axios from "axios";
import { apiError } from "@/lib/api-error";

// POST /api/videos/generate - Generate avatar video via n8n webhook
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check user plan
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { plan: true, heygenKey: true, elevenlabsKey: true },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    if (user.plan !== "PRO") {
      return NextResponse.json(
        { error: "Video generation is only available for Pro users" },
        { status: 403 }
      );
    }

    // Check API keys
    if (!user.heygenKey || !user.elevenlabsKey) {
      return NextResponse.json(
        {
          error:
            "Please add your HeyGen and ElevenLabs API keys in Settings",
        },
        { status: 400 }
      );
    }

    const {
      contentId,
      avatarModel,
      voiceModel,
      sceneCount,
      customScript,
    } = await req.json();

    if (!avatarModel || !voiceModel || !sceneCount) {
      return NextResponse.json(
        { error: "Avatar model, voice model, and scene count are required" },
        { status: 400 }
      );
    }

    // Get content if contentId provided
    let content = null;
    if (contentId) {
      content = await prisma.content.findFirst({
        where: {
          id: contentId,
          userId: session.user.id,
        },
      });

      if (!content) {
        return NextResponse.json(
          { error: "Content not found" },
          { status: 404 }
        );
      }
    }

    // Generate script from content or use custom script
    const script =
      customScript ||
      (content
        ? `${content.headline}\n\n${content.subheadline}\n\n${content.body}`
        : "");

    if (!script || script.trim().length < 10) {
      return NextResponse.json(
        { error: "Script is too short. Please provide more content." },
        { status: 400 }
      );
    }

    // Create video record with PENDING status
    const video = await prisma.video.create({
      data: {
        contentId: contentId || null,
        avatarModel,
        voiceModel,
        sceneCount,
        script,
        status: "PENDING",
        userId: session.user.id,
      },
      include: {
        content: {
          select: {
            headline: true,
          },
        },
      },
    });

    // Send to n8n webhook in background
    const webhookUrl = process.env.N8N_WEBHOOK_URL;

    if (webhookUrl) {
      // Fire and forget - n8n will process asynchronously
      axios
        .post(
          webhookUrl,
          {
            chatInput: script,
            videoId: video.id,
            userId: session.user.id,
            avatarModel,
            voiceModel,
            sceneCount,
          },
          {
            timeout: 5000,
          }
        )
        .then(async (response) => {
          // Update video status to PROCESSING
          await prisma.video.update({
            where: { id: video.id },
            data: { status: "PROCESSING" },
          });
        })
        .catch(async (error) => {
          console.error("n8n webhook error:", error);
          // Mark as failed
          await prisma.video.update({
            where: { id: video.id },
            data: { status: "FAILED" },
          });
        });
    } else {
      // No webhook configured - use mock data
      setTimeout(async () => {
        try {
          await prisma.video.update({
            where: { id: video.id },
            data: {
              status: "COMPLETED",
              videoUrl: "https://example.com/videos/demo-video.mp4",
              thumbnail: "https://example.com/thumbnails/demo-thumb.jpg",
            },
          });
        } catch (error) {
          console.error("Failed to update video status:", error);
        }
      }, 5000);
    }

    return NextResponse.json(video, { status: 201 });
  } catch (error) {
    return apiError({ route: "videos/generate", error });
  }
}