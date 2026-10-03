import type { Prisma } from "@prisma/client";

import { VIDEO_JOB_INFLIGHT_STATUSES, clipImportIdOf } from "@/lib/mcp/video-job-status";
import { prisma } from "@/lib/prisma";

export const RENDER_DEPLOY_DRAIN_KEY = "render_deploy_drain";
export const RENDER_MAINTENANCE_CUSTOMER_MESSAGE = "ระบบเรนเดอร์กำลังปรับปรุงชั่วคราว กรุณาลองใหม่";

type DrainClient = Pick<Prisma.TransactionClient, "siteConfig" | "videoJob" | "renderJob">;

export type RenderEnqueueDrainContext = {
  parentVideoJobId?: string;
  userId?: string;
};

export class RenderDeployDrainError extends Error {
  readonly code = "render_deploy_drain";
  reservationRefunded = false;
  private refundInFlight: Promise<void> | null = null;

  constructor() {
    super("render enqueue is paused for deployment maintenance");
    this.name = "RenderDeployDrainError";
  }

  async refundOnce(refund: () => Promise<void>): Promise<void> {
    if (this.reservationRefunded) return;
    if (!this.refundInFlight) {
      this.refundInFlight = refund()
        .then(() => { this.reservationRefunded = true; })
        .finally(() => { this.refundInFlight = null; });
    }
    await this.refundInFlight;
  }
}

export async function assertRenderEnqueueOpen(
  client: DrainClient = prisma,
  context: RenderEnqueueDrainContext = {},
): Promise<void> {
  const row = await client.siteConfig.findUnique({
    where: { key: RENDER_DEPLOY_DRAIN_KEY },
    select: { value: true, updatedAt: true },
  });
  if (row?.value !== "1") return;

  // Drain blocks NEW parent work while allowing a child RenderJob required to
  // finish a VideoJob that was already in flight before maintenance began.
  // Ownership + creation time prevent an arbitrary parent id from bypassing it.
  if (context.parentVideoJobId && context.userId) {
    const existingParent = await client.videoJob.findFirst({
      where: {
        id: context.parentVideoJobId,
        userId: context.userId,
        status: { in: [...VIDEO_JOB_INFLIGHT_STATUSES] },
        createdAt: { lte: row.updatedAt },
      },
      select: { id: true },
    });
    if (existingParent) return;
  }

  throw new RenderDeployDrainError();
}

export type RenderQueueCounts = {
  videoJobs: number;
  renderJobs: number;
  empty: boolean;
};

type QueueCountClient = Pick<Prisma.TransactionClient, "videoJob" | "renderJob" | "mediaImport">;

/**
 * What the deploy drain waits for (deploy.sh via check-empty-render-queues.ts).
 *
 * PR-B fix round 1 (SEC-A5): a clip job parked in `waiting_import` counts only while its presenter
 * import can still finish — the caller's own import, `ready`, or `pending` / `processing` inside
 * its deadline. The lane claims and publishes an import only inside its deadline, so one past it
 * (the lane down), failed or missing can never become a render; without this a dead lane held
 * every deploy forever. Read-only: the job stays `waiting_import`, still counts toward the
 * in-flight cap and can still be canceled; the watchdog / get_video_status settle it as before.
 */
export async function readRenderQueueCounts(client: QueueCountClient = prisma, now: Date = new Date()): Promise<RenderQueueCounts> {
  // S1: parked FIRST, then runnable. A job only moves waiting_import → queued, so one that
  // settles between the two reads is counted twice (safe) — never in neither.
  const parked = await client.videoJob.findMany({ where: { status: "waiting_import" }, select: { userId: true, inputJson: true } });
  const [runnable, renderJobs] = await Promise.all([
    client.videoJob.count({ where: { status: { in: VIDEO_JOB_INFLIGHT_STATUSES.filter((status) => status !== "waiting_import") } } }),
    client.renderJob.count({ where: { status: { in: ["QUEUED", "RUNNING"] } } }),
  ]);
  const videoJobs = runnable + await countParkedJobsThatCanStillRun(client, parked, now);
  return { videoJobs, renderJobs, empty: videoJobs === 0 && renderJobs === 0 };
}

async function countParkedJobsThatCanStillRun(
  client: QueueCountClient,
  parked: Array<{ userId: string; inputJson: string }>,
  now: Date,
): Promise<number> {
  const wanted = parked
    .map((job) => ({ userId: job.userId, importId: clipImportIdOf(job.inputJson) }))
    .filter((job): job is { userId: string; importId: string } => job.importId !== null);
  if (wanted.length === 0) return 0;
  const live = await client.mediaImport.findMany({
    where: {
      id: { in: [...new Set(wanted.map((job) => job.importId))] },
      purpose: "presenter",
      OR: [{ status: "ready" }, { status: { in: ["pending", "processing"] }, deadlineAt: { gt: now } }],
    },
    select: { id: true, userId: true },
  });
  const owner = new Map(live.map((row) => [row.id, row.userId]));
  return wanted.filter((job) => owner.get(job.importId) === job.userId).length;
}
