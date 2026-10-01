import { prisma } from "@/lib/prisma";
import { VIDEO_JOB_INFLIGHT_STATUSES } from "@/lib/mcp/video-job-status";
import { cancelHeroVoiceGeneration } from "@/lib/hero-voice-generation.server";
import { parseHeroVoiceProviderCheckpoint } from "@/lib/mcp/hero-voice-provider-checkpoint";
import { refundSettledVideoImageBatch } from "@/lib/video-image-batch-settlement";
import { refundVideoJobTerminalRenderReservations } from "@/lib/render/reservation-settlement";
import { refundVideoJobFunding } from "@/lib/mcp/video-job-funding";
import { resolveMcpChain, writeMcpChainTerminalMarker } from "@/lib/mcp/chain-export";

/**
 * T10 (ADR 0063): the cancel core shared by web `DELETE /api/videos/jobs/[id]` and the MCP
 * `cancel_video_job` tool. Cancels exactly ONE owned VideoJob row (queued / processing /
 * waiting_provider) with its funding, image and render settlement, then the matching
 * EditorProject transition. No chain awareness lives here — a caller decides WHICH row id
 * (preview or export) to pass in; this is byte-identical to the web route's prior inline
 * DELETE body, just parameterized on userId instead of a session.
 */
export type CancelVideoJobResult =
  | { kind: "not_cancelable" }
  | { kind: "canceled"; settlementPending: boolean };

export async function cancelVideoJobCore(userId: string, jobId: string): Promise<CancelVideoJobResult> {
  const job = await prisma.videoJob.findFirst({
    where: { id: jobId, userId },
    select: {
      id: true,
      projectId: true,
      type: true,
      currentStep: true,
      providerCheckpointJson: true,
    },
  });
  if (!job) return { kind: "not_cancelable" };

  const res = await prisma.videoJob.updateMany({
    where: { id: jobId, userId, status: { in: [...VIDEO_JOB_INFLIGHT_STATUSES] } },
    data: {
      status: "canceled",
      finishedAt: new Date(),
      errorMessage: "canceled by user (editor v2)",
      reservationRefundPending: true,
      reservationRefundReason: "video_user_canceled",
    },
  });
  if (res.count !== 1) return { kind: "not_cancelable" };

  const heroVoiceCheckpoint = parseHeroVoiceProviderCheckpoint(job.providerCheckpointJson);
  if (heroVoiceCheckpoint) {
    await cancelHeroVoiceGeneration(userId, heroVoiceCheckpoint.aiGenerationJobId).catch((error) => {
      console.error(
        `[video-job-cancel] Hero Voice cancel settlement failed job=${job.id}`,
        error instanceof Error ? error.message : "unknown error",
      );
    });
  }
  let settlementPending = false;
  try {
    await refundVideoJobFunding(job.id, userId, "user-canceled");
  } catch (error) {
    settlementPending = true;
    console.error(
      `[video-job-cancel] pre-render funding settlement failed job=${job.id}`,
      error instanceof Error ? error.message : "unknown error",
    );
  }
  try {
    await refundSettledVideoImageBatch({
      userId,
      videoJobId: job.id,
      reason: "video_user_canceled",
    });
  } catch (error) {
    settlementPending = true;
    console.error(
      `[video-job-cancel] image settlement failed job=${job.id}`,
      error instanceof Error ? error.message : "unknown error",
    );
  }
  try {
    const renderSettlement = await refundVideoJobTerminalRenderReservations({
      videoJobId: job.id,
      userId,
      reason: "video_user_canceled",
    });
    if (renderSettlement.kind === "in_flight") settlementPending = true;
  } catch (error) {
    settlementPending = true;
    console.error(
      `[video-job-cancel] render settlement failed job=${job.id}`,
      error instanceof Error ? error.message : "unknown error",
    );
  }
  await prisma.videoJob.updateMany({
    where: { id: job.id, userId, status: "canceled" },
    data: settlementPending
      ? { reservationRefundAttempts: { increment: 1 } }
      : {
          reservationRefundPending: false,
          reservationRefundReason: null,
          reservationRefundAttempts: { increment: 1 },
        },
  });
  if (job.projectId) {
    if (job.type === "export") {
      await prisma.editorProject.updateMany({
        where: { id: job.projectId, userId, activeExportJobId: job.id },
        data: { status: "post", lastOpenedAt: new Date() },
      });
    } else {
      await prisma.editorProject.updateMany({
        where: { id: job.projectId, userId, activeJobId: job.id },
        data: { status: "draft", lastOpenedAt: new Date() },
      });
    }
  }
  return { kind: "canceled", settlementPending };
}

/**
 * T10 (ADR 0063): route a `cancel_video_job(id)` call to the right row of an MCP chain —
 * `id` may be either the preview or the export id (resolveMcpChain accepts both, owner-scoped).
 *
 * - Preview still in flight → cancel the preview row (byte-identical to web DELETE on a
 *   `type:"create"` job). A canceled preview can never chain, because enqueue requires
 *   `status==="done"` — no marker needed.
 * - Preview done, an export row already exists and is in flight → cancel that export row
 *   (byte-identical to web DELETE on a `type:"export"` job; its own settlement path).
 * - Preview done, export row exists but is already terminal (done/failed/canceled) →
 *   not_cancelable — nothing in flight.
 * - Preview done, no export row yet (the gap between preview finish and export enqueue) →
 *   write a canceled terminal marker under the chain key so neither `get_video_status` nor
 *   the watchdog ever enqueues one afterwards. The preview's single charge already stands
 *   (Q10 — cancel during the export half follows web semantics), so there is nothing to
 *   settle for a job that was never created.
 * - The marker write loses a race to a concurrent enqueue (`exists`) → re-resolve and cancel
 *   whatever is now really under the key, if it is still in flight.
 * - A conflicting foreign row already holds the chain key, or the preview is already
 *   terminal itself → not_cancelable.
 * - `id` is not part of any MCP chain (plain job, or chain feature off) → the plain
 *   single-job cancel. A foreign id resolves to no chain (owner-scoped) and then to
 *   "not found" in the plain path too, so both a foreign id and an already-terminal id
 *   return the exact same not_cancelable shape — no existence oracle.
 */
export async function cancelMcpVideoJob(userId: string, jobId: string): Promise<CancelVideoJobResult> {
  const chain = await resolveMcpChain(userId, jobId);
  if (!chain) return cancelVideoJobCore(userId, jobId);

  const { preview, exportJob, conflict } = chain;
  const inFlight = (status: string) => (VIDEO_JOB_INFLIGHT_STATUSES as readonly string[]).includes(status);

  if (inFlight(preview.status)) return cancelVideoJobCore(userId, preview.id);
  if (preview.status !== "done") return { kind: "not_cancelable" };

  if (exportJob) {
    return inFlight(exportJob.status)
      ? cancelVideoJobCore(userId, exportJob.id)
      : { kind: "not_cancelable" };
  }
  if (conflict) return { kind: "not_cancelable" };

  const marker = await writeMcpChainTerminalMarker({
    userId,
    previewJobId: preview.id,
    status: "canceled",
    code: "canceled_by_user",
    message: "canceled by user (mcp)",
  });
  if (marker.kind === "not_chain") return { kind: "not_cancelable" };
  if (marker.kind === "written") return { kind: "canceled", settlementPending: false };

  // "exists": a concurrent enqueue won the race and created the real export row (or an
  // earlier refusal/cancel already closed the chain). Cancel it normally if still in flight.
  const resolved = await resolveMcpChain(userId, preview.id);
  return resolved?.exportJob && inFlight(resolved.exportJob.status)
    ? cancelVideoJobCore(userId, resolved.exportJob.id)
    : { kind: "not_cancelable" };
}
