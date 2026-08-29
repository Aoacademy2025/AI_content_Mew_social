import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { videoExpiryFor } from "@/lib/plan-limits";
import { assertEditorProjectOwner } from "@/lib/editor-projects";
import { isGalleryClipFileMissing } from "@/lib/gallery-clip-cleanup";
import { enqueueLowResPreview } from "@/lib/low-res-preview";
import { persistExportGalleryVideo } from "@/lib/export-gallery";
import { resolveServiceVideoJobId } from "@/lib/mcp/service-actor";
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
        project: { select: { title: true } },
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

    // GET is deliberately read-only. Hide expired/missing entries, but leave
    // ownership rows and files for the reviewed graph/quarantine lifecycle.
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
      const previewStatus: "ready" | "unavailable" = previewVideoUrl ? "ready" : "unavailable";
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
      parentJobId: rawParentJobId,
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
    const serviceVideoJobId = await resolveServiceVideoJobId(authUser.id);
    const parentVideoJobId = typeof rawParentJobId === "string"
      && rawParentJobId
      && serviceVideoJobId === rawParentJobId
      ? rawParentJobId
      : undefined;

    const persisted = await persistExportGalleryVideo({
      userId: authUser.id,
      parentVideoJobId,
      projectId,
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
      expiresAt: videoExpiryFor(userPlan),
    });
    const video = persisted.video;

    const primaryVideoUrl = video.videoUrl || video.avatarVideoUrl;
    const previewQueue = persisted.created
      ? enqueueLowResPreview(primaryVideoUrl, {
          userId: authUser.id,
          videoId: video.id,
          reason: "video_created",
        })
      : { status: "skipped" as const };

    const previewVideoUrl = existingLowResPreviewUrlForVideoUrl(primaryVideoUrl);
    const previewFallbackVideoUrl = existingLowResPreviewFallbackUrlForVideoUrl(primaryVideoUrl);
    return NextResponse.json({
      ...video,
      previewVideoUrl,
      previewFallbackVideoUrl,
      previewStatus: previewVideoUrl ? "ready" : previewQueue.status === "queued" ? "queued" : "unavailable",
    }, { status: persisted.created ? 201 : 200 });
  } catch (error) {
    if ((error as { code?: string })?.code === "project_not_found") {
      return NextResponse.json({ error: "project_not_found" }, { status: 404 });
    }
    return apiError({ route: "videos", error });
  }
}
