import type { Prisma } from "@prisma/client";

import { VIDEO_JOB_INFLIGHT_STATUSES } from "@/lib/mcp/video-job-status";
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

export async function readRenderQueueCounts(client: DrainClient = prisma): Promise<RenderQueueCounts> {
  const [videoJobs, renderJobs] = await Promise.all([
    client.videoJob.count({ where: { status: { in: [...VIDEO_JOB_INFLIGHT_STATUSES] } } }),
    client.renderJob.count({ where: { status: { in: ["QUEUED", "RUNNING"] } } }),
  ]);
  return { videoJobs, renderJobs, empty: videoJobs === 0 && renderJobs === 0 };
}
