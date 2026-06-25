import type { User, VideoStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { classifyEntitlement } from "@/lib/entitlements";
import { buildSetupGuide } from "@/lib/mcp/onboarding";

function deriveTitle(v: { content: { headline: string | null } | null; script: string | null }): string {
  const h = v.content?.headline?.trim();
  if (h) return h;
  const s = v.script?.trim();
  if (s) return s.length > 60 ? s.slice(0, 57) + "…" : s;
  return "Untitled";
}

export async function getCurrentUserTool(user: User) {
  const keysConfigured = {
    gemini: !!user.geminiKey || process.env.MANAGED_GEMINI === "1",
    heygen: !!user.heygenKey,
    elevenlabs: !!user.elevenlabsKey,
    pexels: !!user.pexelsKey,
    pixabay: !!user.pixabayKey,
  };
  return {
    email: user.email,
    plan: user.plan,
    effectivePlan: classifyEntitlement(user).effectivePlan,
    usageCount: user.usageCount,
    usageLimit: user.usageLimit,
    keysConfigured,
    // Onboarding hints so the assistant can guide a BYOK user through setup (links + where to paste).
    setup: buildSetupGuide(keysConfigured),
  };
}

export async function listMyVideosTool(userId: string, opts: { limit?: number; status?: VideoStatus } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const videos = await prisma.video.findMany({
    where: { userId, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true, status: true, videoUrl: true, createdAt: true, script: true,
      content: { select: { headline: true, videoDuration: true } },
    },
  });
  return videos.map((v) => ({
    id: v.id,
    title: deriveTitle(v),
    status: v.status,
    durationSec: v.content?.videoDuration ?? null,
    hasDownload: !!v.videoUrl,
    createdAt: v.createdAt.toISOString(),
  }));
}

async function ownedVideo(userId: string, videoId: string) {
  return prisma.video.findFirst({
    where: { id: videoId, userId },
    select: {
      id: true, status: true, videoUrl: true, createdAt: true, updatedAt: true, script: true,
      avatarModel: true, voiceModel: true, sceneCount: true,
      content: { select: { headline: true, videoDuration: true } },
    },
  });
}

export async function getVideoStatusTool(userId: string, videoId: string) {
  const v = await ownedVideo(userId, videoId);
  if (!v) return { found: false as const };
  return {
    found: true as const,
    videoId: v.id,
    status: v.status, // PENDING | PROCESSING | COMPLETED | FAILED
    hasDownload: !!v.videoUrl,
    updatedAt: v.updatedAt.toISOString(),
  };
}

export async function getVideoTool(userId: string, videoId: string) {
  const v = await ownedVideo(userId, videoId);
  if (!v) return { found: false as const };
  return {
    found: true as const,
    videoId: v.id,
    title: deriveTitle(v),
    status: v.status,
    durationSec: v.content?.videoDuration ?? null,
    avatarModel: v.avatarModel,
    voiceModel: v.voiceModel,
    sceneCount: v.sceneCount,
    hasDownload: !!v.videoUrl,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

export async function downloadVideoTool(userId: string, videoId: string) {
  const v = await ownedVideo(userId, videoId);
  if (!v) return { found: false as const };
  if (v.status !== "COMPLETED" || !v.videoUrl) return { found: true as const, ready: false as const, status: v.status };
  return { found: true as const, ready: true as const, url: v.videoUrl };
}
