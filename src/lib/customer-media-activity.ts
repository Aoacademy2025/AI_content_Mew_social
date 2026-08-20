import { prisma } from "@/lib/prisma";

export type ActiveCustomerMediaJobs = {
  activeRenderJobs: number;
  activeVideoJobs: number;
};

export async function activeCustomerMediaJobs(): Promise<ActiveCustomerMediaJobs> {
  const [activeRenderJobs, activeVideoJobs] = await Promise.all([
    prisma.renderJob.count({ where: { status: { in: ["QUEUED", "RUNNING"] } } }),
    prisma.videoJob.count({ where: { status: "processing" } }),
  ]);
  return { activeRenderJobs, activeVideoJobs };
}

export function hasActiveCustomerMediaJobs(activity: ActiveCustomerMediaJobs): boolean {
  return activity.activeRenderJobs > 0 || activity.activeVideoJobs > 0;
}
