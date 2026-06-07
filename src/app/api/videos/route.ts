import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { videoExpiryFor } from "@/lib/plan-limits";
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
      include: { content: { select: { headline: true } } },
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

    function deleteFileIfLocal(url: string | null) {
      if (!url || url.startsWith("http://") || url.startsWith("https://")) return;
      try {
        const filePath = url.startsWith("/api/renders/")
          ? path.join(publicDir, "renders", url.slice("/api/renders/".length))
          : path.join(publicDir, url);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch { /* ignore */ }
    }

    // ── Lazy cleanup: delete expired records + their files on read ────────
    const expiredIds: string[] = [];
    const brokenIds: string[] = [];
    const valid: typeof videos = [];

    for (const v of videos) {
      // Expired by retention?
      if (v.expiresAt && v.expiresAt <= now) {
        expiredIds.push(v.id);
        deleteFileIfLocal(v.videoUrl);
        deleteFileIfLocal(v.avatarVideoUrl);
        deleteFileIfLocal(v.audioUrl);
        deleteFileIfLocal(v.thumbnail);
        continue;
      }
      // File missing on disk?
      const hasFile = localFileExists(v.videoUrl) || localFileExists(v.avatarVideoUrl);
      if (!hasFile) {
        brokenIds.push(v.id);
        continue;
      }
      valid.push(v);
    }

    const toDelete = [...expiredIds, ...brokenIds];
    if (toDelete.length > 0) {
      await prisma.video.deleteMany({ where: { id: { in: toDelete } } });
      console.log(`[videos] cleaned up ${expiredIds.length} expired + ${brokenIds.length} broken records`);
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
    } = await req.json();

    // Compute expiresAt based on user's current plan (FREE: 3d, PRO: 7d, BUSINESS: 14d)
    const dbUser = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { plan: true },
    });
    const userPlan = dbUser?.plan ?? "FREE";

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
        userId: authUser.id,
        expiresAt: videoExpiryFor(userPlan),
      },
    });

    return NextResponse.json(video, { status: 201 });
  } catch (error) {
    return apiError({ route: "videos", error });
  }
}
