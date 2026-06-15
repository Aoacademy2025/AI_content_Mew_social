import { prisma } from "@/lib/prisma";

export async function createVideoJob(userId: string, input: unknown, idempotencyKey?: string) {
  return prisma.videoJob.create({
    data: { userId, inputJson: JSON.stringify(input), idempotencyKey: idempotencyKey ?? null, status: "queued" },
  });
}

/** Atomically claim the oldest queued job (→ processing). Returns it, or null if none. */
export async function claimNextQueuedJob() {
  const next = await prisma.videoJob.findFirst({ where: { status: "queued" }, orderBy: { createdAt: "asc" } });
  if (!next) return null;
  const res = await prisma.videoJob.updateMany({
    where: { id: next.id, status: "queued" },
    data: { status: "processing", startedAt: new Date() },
  });
  if (res.count !== 1) return null; // lost the race
  return prisma.videoJob.findUnique({ where: { id: next.id } });
}

export async function setJobStep(id: string, currentStep: string, progress: number) {
  await prisma.videoJob.update({ where: { id }, data: { currentStep, progress } });
}

export async function finishJob(id: string, output: { videoUrl: string; videoId?: string }) {
  await prisma.videoJob.update({
    where: { id },
    data: { status: "done", progress: 100, outputJson: JSON.stringify(output), videoId: output.videoId ?? null, finishedAt: new Date() },
  });
}

export async function failJob(id: string, message: string) {
  await prisma.videoJob.update({
    where: { id },
    data: { status: "failed", errorMessage: message.slice(0, 1000), finishedAt: new Date() },
  });
}
