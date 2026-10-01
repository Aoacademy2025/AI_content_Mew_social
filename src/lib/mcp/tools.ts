import type { User, VideoStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { classifyEntitlement } from "@/lib/entitlements";
import { buildSetupGuide } from "@/lib/mcp/onboarding";
import { parseVideoJobOutput, toPublicVideoJobStatus, deriveFailedJobFields } from "@/lib/mcp/video-job";
import {
  enqueueMcpChainExportSafely,
  resolveMcpChain,
  type McpChain,
  type McpChainRow,
} from "@/lib/mcp/chain-export";

const DEFAULT_MCP_PUBLIC_ORIGIN = "https://studio.heroaiengine.com";

/** The app origin every absolute link MCP hands an agent is built on. */
function mcpPublicOrigin(): string {
  return process.env.MCP_PUBLIC_ORIGIN?.trim()
    || process.env.NEXT_PUBLIC_APP_URL?.trim()
    || DEFAULT_MCP_PUBLIC_ORIGIN;
}

function publicVideoUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, mcpPublicOrigin());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : value;
  } catch {
    return value;
  }
}

/** T8: absolute link that opens an Agent-created Project in the Editor (Post phase). */
export function mcpEditorUrl(projectId: string): string | null {
  try {
    const url = new URL(`/video-editor?projectId=${encodeURIComponent(projectId)}`, mcpPublicOrigin());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
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

/** Preview share of a chain's progress bar; the export fills the rest (R-T8 status mapping). */
const CHAIN_PREVIEW_PROGRESS_SHARE = 85;

function scaledProgress(progress: number, from: number, to: number): number {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(progress) ? progress : 0));
  return from + Math.round((clamped * (to - from)) / 100);
}

/**
 * T8 (ADR 0063): get_video_status for an MCP chain — one job from the agent's point of view,
 * whichever of the two ids it holds. Preview 0–85, export 85–100; failure fields come from
 * the FAILING row with both chain ids (R-T8-2). `jobId` is always the preview id, so a query
 * by the export id returns the identical shape.
 */
async function chainJobStatus(userId: string, resolved: McpChain) {
  let chain = resolved;
  const { preview } = chain;
  if (preview.status === "done" && !chain.exportJob && !chain.conflict) {
    // Lost-enqueue recovery: the same idempotent enqueue the worker runs after the finish.
    await enqueueMcpChainExportSafely({ previewJobId: preview.id, userId });
    chain = (await resolveMcpChain(userId, preview.id)) ?? chain;
  }
  const exportJob = chain.exportJob;
  const chainIds = exportJob ? [preview.id, exportJob.id] : [preview.id];
  const inExportHalf = preview.status === "done";
  const row: McpChainRow = inExportHalf && exportJob ? exportJob : preview;
  const output = parseVideoJobOutput(row.outputJson);

  let status: string;
  let progress: number;
  if (!inExportHalf) {
    status = toPublicVideoJobStatus(preview.status);
    progress = scaledProgress(preview.progress, 0, CHAIN_PREVIEW_PROGRESS_SHARE);
  } else if (chain.conflict) {
    status = "failed";
    progress = CHAIN_PREVIEW_PROGRESS_SHARE;
  } else if (!exportJob) {
    status = "processing";
    progress = CHAIN_PREVIEW_PROGRESS_SHARE;
  } else if (exportJob.status === "done" || exportJob.status === "failed" || exportJob.status === "canceled") {
    status = exportJob.status;
    progress = exportJob.status === "done"
      ? 100
      : scaledProgress(exportJob.progress, CHAIN_PREVIEW_PROGRESS_SHARE, 100);
  } else {
    status = "processing";
    progress = scaledProgress(exportJob.progress, CHAIN_PREVIEW_PROGRESS_SHARE, 100);
  }

  let failure = null;
  if (status === "failed") {
    const failingRow: McpChainRow = chain.conflict
      ? {
          ...preview,
          errorCode: "idempotency_conflict",
          errorMessage: "idempotencyKey นี้ถูกใช้แล้ว",
          errorProvider: null,
          currentStep: null,
        }
      : row;
    failure = await deriveFailedJobFields(failingRow, chainIds, {
      exportMode: inExportHalf,
      avatarSourceInputJson: preview.inputJson,
    });
  }
  const done = status === "done";
  const projectId = preview.projectId ?? exportJob?.projectId ?? null;
  return {
    kind: "job" as const,
    jobId: preview.id,
    status,
    currentStep: chain.conflict ? null : row.currentStep,
    progress,
    videoUrl: done ? publicVideoUrl(output?.videoUrl ?? null) : null,
    error: status === "failed" || status === "canceled"
      ? (chain.conflict ? "idempotencyKey นี้ถูกใช้แล้ว" : row.errorMessage ?? null)
      : null,
    ...(failure ? failure : {}),
    subtitleQa: output?.subtitleQa ?? null,
    billingReceipt: output?.billingReceipt ?? null,
    ...(done
      ? {
          videoId: output?.videoId ?? null,
          editorUrl: projectId ? mcpEditorUrl(projectId) : null,
        }
      : {}),
  };
}

export async function getVideoJobStatusTool(userId: string, jobId: string) {
  // T8: an MCP chain (preview or its chained export) reads as one job. Owner-scoped: another
  // user's id resolves to null here AND below, so it is "not found" either way.
  const chain = await resolveMcpChain(userId, jobId);
  if (chain) return chainJobStatus(userId, chain);
  const job = await prisma.videoJob.findFirst({
    where: { id: jobId, userId },
    select: {
      id: true,
      userId: true,
      status: true,
      currentStep: true,
      progress: true,
      outputJson: true,
      errorMessage: true,
      errorCode: true,
      errorProvider: true,
      reservationRefundPending: true,
      fundingState: true,
      inputJson: true,
    },
  });
  if (!job) return null;
  const output = parseVideoJobOutput(job.outputJson);
  // T6: failure transparency — {errorCode, errorProvider?, message, userAction, refunded,
  // refundPending} per the plan's Global Constraints, only on a FAILED job. `error` (raw
  // errorMessage) stays exactly as-is for backward compatibility (verify-mcp-audit-status.ts
  // keys its isInBandError classification on that field's null/non-null value).
  // Chain = [job.id] only — T6 scope is pre-P1; T8 passes the full preview+export chain.
  const failure = job.status === "failed"
    ? await deriveFailedJobFields(job, [job.id])
    : null;
  return {
    kind: "job" as const,
    jobId: job.id,
    status: toPublicVideoJobStatus(job.status),
    currentStep: job.currentStep,
    progress: job.progress,
    videoUrl: publicVideoUrl(output?.videoUrl ?? null),
    error: job.errorMessage ?? null,
    ...(failure ? failure : {}),
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
