import type { Prisma } from "@prisma/client";

import { VIDEO_JOB_INFLIGHT_STATUSES } from "@/lib/mcp/video-job-status";
import { prisma } from "@/lib/prisma";

export const RENDER_DEPLOY_DRAIN_KEY = "render_deploy_drain";

type DrainClient = Pick<Prisma.TransactionClient, "siteConfig" | "videoJob" | "renderJob">;

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

export async function assertRenderEnqueueOpen(client: DrainClient = prisma): Promise<void> {
  const row = await client.siteConfig.findUnique({
    where: { key: RENDER_DEPLOY_DRAIN_KEY },
    select: { value: true },
  });
  if (row?.value === "1") throw new RenderDeployDrainError();
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
