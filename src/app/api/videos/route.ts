import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { videoExpiryFor } from "@/lib/plan-limits";
import { assertEditorProjectOwner } from "@/lib/editor-projects";
import { isGalleryClipFileMissing } from "@/lib/gallery-clip-cleanup";
import { enqueueLowResPreview } from "@/lib/low-res-preview";
import {
  existingLowResPreviewFallbackUrlForVideoUrl,
  existingLowResPreviewUrlForVideoUrl,
} from "@/lib/low-res-preview-paths";
import fs from "fs";
import path from "path";

// GET /api/videos - Get all videos for current user
export async function GET() {
  try {
    const authUser = await getCurrentUser();

    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const now = new Date();
    const videos = await prisma.video.findMany({
      where: { userId: authUser.id },
      select: {
        id: true,
        status: true,
        thumbnail: true,
        videoUrl: true,
        avatarVideoUrl: true,
        audioUrl: true,
        script: true,
        createdAt: true,
        expiresAt: true,
        content: { select: { headline: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const publicDir = path.join(process.cwd(), "public");

    function localFileExists(url: string | null): boolean {
      if (!url) return false;
      if (url.startsWith("http://") || url.startsWith("https://")) return true;
      const filePath = url.startsWith("/api/renders/")
        ? path.join(publicDir, "renders", url.slice("/api/renders/".length))
        : path.join(publicDir, url);
      return fs.existsSync(filePath);
    }

    // GET may hide unavailable rows, but automatic deletion belongs exclusively to the
    // media reference graph + quarantine workflow.
    const valid: Array<(typeof videos)[number] & {
      previewVideoUrl: string | null;
      previewFallbackVideoUrl: string | null;
      previewStatus: "ready" | "queued" | "unavailable";
    }> = [];

    for (const v of videos) {
      // Expired by retention?
      if (v.expiresAt && v.expiresAt <= now) {
        continue;
      }
      // Primary playable file missing on disk? (A remote avatarVideoUrl must NOT mask a
      // swept-away local render — see isGalleryClipFileMissing.)
      if (isGalleryClipFileMissing(v, localFileExists)) {
        continue;
      }

      const primaryVideoUrl = v.videoUrl || v.avatarVideoUrl;
      const previewVideoUrl = existingLowResPreviewUrlForVideoUrl(primaryVideoUrl);
      const previewFallbackVideoUrl = existingLowResPreviewFallbackUrlForVideoUrl(primaryVideoUrl);
      let previewStatus: "ready" | "queued" | "unavailable" = previewVideoUrl ? "ready" : "unavailable";
      if (!previewVideoUrl && v.status === "COMPLETED") {
        const queued = enqueueLowResPreview(primaryVideoUrl, {
          userId: authUser.id,
          videoId: v.id,
          reason: "gallery_fetch",
        });
        previewStatus = queued.status === "queued" ? "queued" : "unavailable";
      }
      valid.push({ ...v, previewVideoUrl, previewFallbackVideoUrl, previewStatus });
    }

    return NextResponse.json(valid);
  } catch (error) {
    return apiError({ route: "videos", error });
  }
}

// POST /api/videos - Create new video
export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();

    if (!authUser) {
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
      projectId: rawProjectId,
    } = await req.json();
    const projectId = typeof rawProjectId === "string" && rawProjectId.trim()
      ? await assertEditorProjectOwner(authUser.id, rawProjectId.trim())
      : null;

    // Compute expiresAt based on user's current plan (FREE: 3d, PRO: 7d, BUSINESS: 14d)
    const dbUser = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { plan: true },
    });
    const userPlan = dbUser?.plan ?? "FREE";

    const video = await prisma.video.create({
      data: {
        contentId: contentId ?? null,
        projectId,
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
        userId: authUser.id,
        expiresAt: videoExpiryFor(userPlan),
      },
    });
    if (projectId) {
      await prisma.editorProject.updateMany({
        where: { id: projectId, userId: authUser.id },
        data: {
          latestVideoId: video.id,
          status: video.status === "COMPLETED" ? "exported" : "post",
          lastOpenedAt: new Date(),
        },
      });
    }

    const primaryVideoUrl = video.videoUrl || video.avatarVideoUrl;
    const previewQueue = enqueueLowResPreview(primaryVideoUrl, {
      userId: authUser.id,
      videoId: video.id,
      reason: "video_created",
    });

    const previewVideoUrl = existingLowResPreviewUrlForVideoUrl(primaryVideoUrl);
    const previewFallbackVideoUrl = existingLowResPreviewFallbackUrlForVideoUrl(primaryVideoUrl);
    return NextResponse.json({
      ...video,
      previewVideoUrl,
      previewFallbackVideoUrl,
      previewStatus: previewVideoUrl ? "ready" : previewQueue.status === "queued" ? "queued" : "unavailable",
    }, { status: 201 });
  } catch (error) {
    if ((error as { code?: string })?.code === "project_not_found") {
      return NextResponse.json({ error: "project_not_found" }, { status: 404 });
    }
    return apiError({ route: "videos", error });
  }
}
