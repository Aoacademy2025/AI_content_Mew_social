import type { User, VideoStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { classifyEntitlement } from "@/lib/entitlements";
import { buildSetupGuide } from "@/lib/mcp/onboarding";
import { parseVideoJobOutput, toPublicVideoJobStatus, deriveFailedJobFields, deriveSettlementFields } from "@/lib/mcp/video-job";
import {
  currentHeldPreviewRow,
  enqueueMcpChainExportSafely,
  resolveMcpChain,
  type McpAutoChain,
  type McpChainRow,
  type McpHeldChain,
} from "@/lib/mcp/chain-export";
import { VIDEO_JOB_INFLIGHT_STATUSES } from "@/lib/mcp/video-job-status";

const DEFAULT_MCP_PUBLIC_ORIGIN = "https://studio.heroaiengine.com";

/** The app origin every absolute link MCP hands an agent is built on. */
export function mcpPublicOrigin(): string {
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

/** Session-authored (T8 fix round 1, A2) — appended to userAction for an export-half failure. */
const CHAIN_EXPORT_RETRY_USER_ACTION = "งานเรนเดอร์หลักเสร็จแล้ว — เปิดลิงก์ editorUrl เพื่อสั่ง export ใหม่ได้";

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
async function chainJobStatus(userId: string, resolved: McpAutoChain) {
  let chain = resolved;
  const { preview } = chain;
  if (preview.status === "done" && !chain.exportJob && !chain.conflict) {
    // Lost-enqueue recovery: the same idempotent enqueue the worker runs after the finish.
    await enqueueMcpChainExportSafely({ previewJobId: preview.id, userId });
    const reresolved = await resolveMcpChain(userId, preview.id);
    if (reresolved?.kind === "auto") chain = reresolved;
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

  let failure: Awaited<ReturnType<typeof deriveFailedJobFields>> | null = null;
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
  // VideoJob.projectId is onDelete: SetNull, so a non-null id means the Agent-created Project
  // still exists. A2 (fix round 1): the link also rides on an export half that failed or was
  // canceled — the paid preview is on that Project, so the customer can export it from there.
  const projectId = preview.projectId ?? exportJob?.projectId ?? null;
  const exportHalfEnded = inExportHalf && (status === "failed" || status === "canceled");
  const editorUrl = projectId && (done || exportHalfEnded) ? mcpEditorUrl(projectId) : null;
  if (failure && inExportHalf && editorUrl) {
    failure = { ...failure, userAction: `${failure.userAction} ${CHAIN_EXPORT_RETRY_USER_ACTION}` };
  }
  // Fix round 2 (PR-B advisory): a canceled export half had no refunded/refundPending — an
  // agent following T11 could not tell the user whether money came back. `exportJob` is
  // always present here (status "canceled" is only reached via the `exportJob.status ===
  // "canceled"` branch above). Settlement truth spans BOTH chain rows (see
  // `deriveSettlementFields`'s doc comment) — the export row's own fundingState is always
  // "none", so without the preview row a kept base charge would misreport refunded: true.
  const canceledSettlement = status === "canceled" && exportJob
    ? await deriveSettlementFields([preview, exportJob], chainIds)
    : null;
  return {
    kind: "job" as const,
    jobId: preview.id,
    status,
    currentStep: chain.conflict ? null : row.currentStep,
    progress,
    videoUrl: done ? publicVideoUrl(output?.videoUrl ?? null) : null,
    // Fix round 1 (A3): a chain cancel's raw errorMessage is web-tagged/English ("canceled by
    // user (editor v2)") or MCP-internal ("canceled by user (mcp)" — the gap marker). Neither
    // is agent-facing copy, and the two reading differently is confusing. This is the MCP
    // read path only — row.errorMessage itself (what's stored, what web reads) is untouched.
    error: status === "failed"
      ? (chain.conflict ? "idempotencyKey นี้ถูกใช้แล้ว" : row.errorMessage ?? null)
      : status === "canceled"
        ? "งานนี้ถูกยกเลิกแล้ว"
        : null,
    ...(failure ? failure : {}),
    ...(canceledSettlement ? canceledSettlement : {}),
    subtitleQa: output?.subtitleQa ?? null,
    billingReceipt: output?.billingReceipt ?? null,
    ...(done ? { videoId: output?.videoId ?? null, editorUrl } : {}),
    ...(exportHalfEnded && editorUrl ? { editorUrl } : {}),
  };
}

function isInFlightJobStatus(status: string): boolean {
  return (VIDEO_JOB_INFLIGHT_STATUSES as readonly string[]).includes(status);
}

/**
 * T5 (ADR 0064, G8): get_video_status for a Held Preview — one job under the root id, whichever
 * linked id the agent holds. Until the root finishes it reads like the root itself. After
 * that the NEWEST linked job (by createdAt) decides: none or a finished re-render → `held`;
 * a re-render in flight → `rerendering`; an export in flight → `exporting`; a finished export
 * → `done` with that export's videoUrl; `failed` / `canceled` carry the failure / settlement
 * fields of that job. `previewUrl` (the current preview) and `editorUrl` ride every reply
 * once the root has finished. Nothing here enqueues: a Held Preview never chains (G6).
 */
async function heldChainStatus(userId: string, chain: McpHeldChain) {
  const { root, latest } = chain;
  const rootDone = root.status === "done";
  const row: McpChainRow = rootDone && latest ? latest : root;
  const output = parseVideoJobOutput(row.outputJson);
  const chainIds = row.id === root.id ? [root.id] : [root.id, row.id];
  const isExport = row.type === "export";

  let status: string;
  if (!rootDone) status = toPublicVideoJobStatus(root.status);
  else if (!latest) status = "held";
  else if (isInFlightJobStatus(latest.status)) status = isExport ? "exporting" : "rerendering";
  else if (latest.status === "done") status = isExport ? "done" : "held";
  else status = toPublicVideoJobStatus(latest.status);
  const progress = status === "held" || status === "done" ? 100 : row.progress;

  const editorUrl = rootDone && root.projectId ? mcpEditorUrl(root.projectId) : null;
  const previewOutput = rootDone
    ? parseVideoJobOutput((await currentHeldPreviewRow(userId, root)).outputJson)
    : null;
  const previewUrl = publicVideoUrl(previewOutput?.videoUrl ?? null);

  let failure: Awaited<ReturnType<typeof deriveFailedJobFields>> | null = null;
  if (status === "failed") {
    failure = await deriveFailedJobFields(row, chainIds, {
      exportMode: isExport,
      avatarSourceInputJson: root.inputJson,
    });
    if (editorUrl) failure = { ...failure, userAction: `${failure.userAction} ${CHAIN_EXPORT_RETRY_USER_ACTION}` };
  }
  const canceledSettlement = status === "canceled"
    ? await deriveSettlementFields(row.id === root.id ? [root] : [root, row], chainIds)
    : null;
  const done = status === "done";
  return {
    kind: "job" as const,
    jobId: root.id,
    status,
    currentStep: row.currentStep,
    progress,
    videoUrl: done ? publicVideoUrl(output?.videoUrl ?? null) : null,
    error: status === "failed"
      ? row.errorMessage ?? null
      : status === "canceled"
        ? "งานนี้ถูกยกเลิกแล้ว"
        : null,
    ...(failure ? failure : {}),
    ...(canceledSettlement ? canceledSettlement : {}),
    subtitleQa: output?.subtitleQa ?? null,
    billingReceipt: output?.billingReceipt ?? null,
    ...(done ? { videoId: output?.videoId ?? null } : {}),
    ...(rootDone ? { previewUrl, editorUrl } : {}),
  };
}

export async function getVideoJobStatusTool(userId: string, jobId: string) {
  // T8: an MCP chain (preview or its chained export) reads as one job. Owner-scoped: another
  // user's id resolves to null here AND below, so it is "not found" either way.
  // T5: a Held Preview and every job linked to it read as one job under the root id.
  const chain = await resolveMcpChain(userId, jobId);
  if (chain?.kind === "held") return heldChainStatus(userId, chain);
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
