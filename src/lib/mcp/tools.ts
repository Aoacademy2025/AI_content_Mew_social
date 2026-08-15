import type { User, VideoStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { classifyEntitlement } from "@/lib/entitlements";
import { buildSetupGuide } from "@/lib/mcp/onboarding";
import { parseVideoJobOutput, toPublicVideoJobStatus } from "@/lib/mcp/video-job";

const DEFAULT_MCP_PUBLIC_ORIGIN = "https://studio.heroaiengine.com";

function publicVideoUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const origin = process.env.MCP_PUBLIC_ORIGIN?.trim()
      || process.env.NEXT_PUBLIC_APP_URL?.trim()
      || DEFAULT_MCP_PUBLIC_ORIGIN;
    const url = new URL(value, origin);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : value;
  } catch {
    return value;
  }
}

function renderDurationSec(value: string | null | undefined): number | null {
  if (!value) return null;
  try {
    const config = JSON.parse(value) as { durationInFrames?: unknown; fps?: unknown; audioDurationMs?: unknown };
    const audioDurationMs = Number(config.audioDurationMs);
    if (Number.isFinite(audioDurationMs) && audioDurationMs > 0) {
      return Math.round(audioDurationMs / 10) / 100;
    }
    const frames = Number(config.durationInFrames);
    const fps = Number(config.fps) > 0 ? Number(config.fps) : 30;
    if (Number.isFinite(frames) && frames > 0) return Math.round((frames / fps) * 100) / 100;
  } catch {}
  return null;
}

function durationSec(v: { content: { videoDuration: number | null } | null; renderConfig?: string | null }): number | null {
  return v.content?.videoDuration ?? renderDurationSec(v.renderConfig);
}

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
      id: true, status: true, videoUrl: true, createdAt: true, script: true, renderConfig: true,
      content: { select: { headline: true, videoDuration: true } },
    },
  });
  return videos.map((v) => ({
    id: v.id,
    title: deriveTitle(v),
    status: v.status,
    durationSec: durationSec(v),
    hasDownload: !!v.videoUrl,
    downloadUrl: v.status === "COMPLETED" ? publicVideoUrl(v.videoUrl) : null,
    createdAt: v.createdAt.toISOString(),
  }));
}

async function ownedVideo(userId: string, videoId: string) {
  return prisma.video.findFirst({
    where: { id: videoId, userId },
    select: {
      id: true, status: true, videoUrl: true, createdAt: true, updatedAt: true, script: true,
      avatarModel: true, voiceModel: true, sceneCount: true, renderConfig: true,
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

export async function getVideoJobStatusTool(userId: string, jobId: string) {
  const job = await prisma.videoJob.findFirst({
    where: { id: jobId, userId },
    select: {
      id: true,
      status: true,
      currentStep: true,
      progress: true,
      outputJson: true,
      errorMessage: true,
    },
  });
  if (!job) return null;
  const output = parseVideoJobOutput(job.outputJson);
  return {
    kind: "job" as const,
    jobId: job.id,
    status: toPublicVideoJobStatus(job.status),
    currentStep: job.currentStep,
    progress: job.progress,
    videoUrl: publicVideoUrl(output?.videoUrl ?? null),
    error: job.errorMessage ?? null,
    subtitleQa: output?.subtitleQa ?? null,
    billingReceipt: output?.billingReceipt ?? null,
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
    durationSec: durationSec(v),
    avatarModel: v.avatarModel,
    voiceModel: v.voiceModel,
    sceneCount: v.sceneCount,
    hasDownload: !!v.videoUrl,
    downloadUrl: v.status === "COMPLETED" ? publicVideoUrl(v.videoUrl) : null,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

export async function downloadVideoTool(userId: string, videoId: string) {
  const v = await ownedVideo(userId, videoId);
  if (!v) return { found: false as const };
  if (v.status !== "COMPLETED" || !v.videoUrl) return { found: true as const, ready: false as const, status: v.status };
  return {
    found: true as const,
    ready: true as const,
    url: publicVideoUrl(v.videoUrl)!,
    durationSec: durationSec(v),
  };
}
