import { prisma } from "@/lib/prisma";
import { VIDEO_JOB_INFLIGHT_STATUSES } from "@/lib/mcp/video-job-status";
import { cancelHeroVoiceGeneration } from "@/lib/hero-voice-generation.server";
import { parseHeroVoiceProviderCheckpoint } from "@/lib/mcp/hero-voice-provider-checkpoint";
import { refundSettledVideoImageBatch } from "@/lib/video-image-batch-settlement";
import { refundVideoJobTerminalRenderReservations } from "@/lib/render/reservation-settlement";
import { refundVideoJobFunding } from "@/lib/mcp/video-job-funding";

/**
 * T10 (ADR 0063): the cancel core shared by web `DELETE /api/videos/jobs/[id]` and the MCP
 * `cancel_video_job` tool. Cancels exactly ONE owned VideoJob row (queued / processing /
 * waiting_provider) with its funding, image and render settlement, then the matching
 * EditorProject transition. No chain awareness lives here — a caller decides WHICH row id
 * (preview or export) to pass in; this is byte-identical to the web route's prior inline
 * DELETE body, just parameterized on userId instead of a session.
 *
 * Fix round 1 (A5): this module deliberately imports NOTHING from `@/lib/mcp/chain-export` —
 * that pulls in `orchestrator-steps`, `editor-export-snapshot`, `internal-ai-access` and more,
 * just to cancel one row. The chain-aware MCP router (`cancelMcpVideoJob`) lives in
 * `video-job-cancel.ts` instead, so web DELETE's import graph (and GET's, which shares this
 * route file) stays exactly what it was before T10.
 */
export type CancelVideoJobResult =
  | { kind: "not_cancelable" }
  | { kind: "canceled"; settlementPending: boolean };

/**
 * `logPrefix` (fix round 1, A6): defaults to a value distinct from the web route's original
 * `[api/videos/jobs/:id]` log lines, so a saved log search/alert on that exact string keeps
 * matching. The web route passes its original prefix explicitly; MCP's chain router leaves it
 * at the default.
 */
export async function cancelVideoJobCore(
  userId: string,
  jobId: string,
  logPrefix = "[video-job-cancel]",
): Promise<CancelVideoJobResult> {
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
        `${logPrefix} Hero Voice cancel settlement failed job=${job.id}`,
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
      `${logPrefix} pre-render funding settlement failed job=${job.id}`,
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
      `${logPrefix} image settlement failed job=${job.id}`,
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
      `${logPrefix} render settlement failed job=${job.id}`,
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
