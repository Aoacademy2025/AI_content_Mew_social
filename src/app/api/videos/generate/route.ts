import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import axios from "axios";
import { apiError } from "@/lib/api-error";
import { isPaid, videoExpiryFor } from "@/lib/plan-limits";
import { refundClipUsage, reserveClipUsage } from "@/lib/usage-limits";
import { minutesFromSeconds, refundMinutes, reserveMinutes } from "@/lib/minute-limits";

// Avatar/narration duration is not known in this route (n8n renders downstream and
// this handler returns immediately with a PENDING video). When MINUTE_QUOTA is on we
// must still reserve SOME minutes up front, so we estimate the narration length from
// the script text: Thai speech runs ~13-16 chars/sec (see tts-timing.ts) — use 14 as a
// middle estimate. minutesFromSeconds rounds to nearest whole minute (min 1).
const EST_CHARS_PER_SEC = 14;
function estimateScriptMinutes(script: string): number {
  const chars = (script ?? "").replace(/\s+/g, "").length;
  return minutesFromSeconds(chars > 0 ? chars / EST_CHARS_PER_SEC : 60);
}

// POST /api/videos/generate - Generate avatar video via n8n webhook
export async function POST(req: Request) {
  // Minute-quota flag (default OFF → byte-identical clip-cap behavior). When ON, the
  // unit reserved/refunded is whole minutes estimated from the narration (script) length.
  const useMinuteQuota = process.env.MINUTE_QUOTA === "1";
  let quotaReserved = false;
  let reservedUserId: string | null = null;
  // Minutes reserved (only meaningful when useMinuteQuota); kept in scope for refund.
  let reservedMinutes = 0;
  try {
    const authUser = await getCurrentUser();

    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check user plan
    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { plan: true, heygenKey: true, elevenlabsKey: true },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    if (!isPaid(user.plan)) {
      return NextResponse.json(
        { error: "Video generation is only available for Pro and Business users" },
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
          userId: authUser.id,
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

    if (useMinuteQuota) {
      // Avatar length ≈ narration length; estimate minutes from the script text.
      reservedMinutes = estimateScriptMinutes(script);
      const quota = await reserveMinutes(authUser.id, reservedMinutes);
      if (!quota.allowed) return NextResponse.json({ error: quota.message }, { status: 403 });
      quotaReserved = true;
      reservedUserId = authUser.id;
    } else {
      const quota = await reserveClipUsage(authUser.id);
      if (!quota) return NextResponse.json({ error: "User not found" }, { status: 404 });
      if (!quota.allowed) return NextResponse.json({ error: quota.message }, { status: 403 });
      quotaReserved = true;
      reservedUserId = authUser.id;
    }

    // Create video record with PENDING status (expiresAt set by user's plan)
    const video = await prisma.video.create({
      data: {
        contentId: contentId || null,
        avatarModel,
        voiceModel,
        sceneCount,
        script,
        status: "PENDING",
        userId: authUser.id,
        expiresAt: videoExpiryFor(user.plan),
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
            userId: authUser.id,
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
          if (useMinuteQuota) {
            await refundMinutes(authUser.id, reservedMinutes).catch(() => {});
          } else {
            await refundClipUsage(authUser.id).catch(() => {});
          }
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
    if (quotaReserved && reservedUserId) {
      if (useMinuteQuota) {
        await refundMinutes(reservedUserId, reservedMinutes).catch(() => {});
      } else {
        await refundClipUsage(reservedUserId).catch(() => {});
      }
    }
    return apiError({ route: "videos/generate", error });
  }
}
