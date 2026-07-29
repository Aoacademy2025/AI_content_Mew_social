import dotenv from "dotenv";

dotenv.config({ path: process.env.REFUND_ENV_FILE || ".env", quiet: true });

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length).trim();
}

async function main() {
  const userEmail = argument("user-email")?.toLowerCase();
  const videoJobId = argument("video-job");
  const reason = argument("reason") || "video_image_batch_incomplete";
  const apply = process.argv.includes("--apply");
  if (!userEmail || !videoJobId) {
    throw new Error(
      "Usage: tsx scripts/refund-video-image-batch.ts --user-email=<email> --video-job=<id> [--reason=<reason>] [--apply]",
    );
  }

  const [{ prisma }, { refundSettledVideoImageBatch }] = await Promise.all([
    import("../src/lib/prisma"),
    import("../src/lib/ai-generation-jobs.server"),
  ]);
  try {
    const user = await prisma.user.findFirst({
      where: { email: { equals: userEmail } },
      select: { id: true, email: true },
    });
    if (!user) throw new Error("User not found");
    const videoJob = await prisma.videoJob.findFirst({
      where: { id: videoJobId, userId: user.id },
      select: { id: true, status: true },
    });
    if (!videoJob) throw new Error("Video job does not belong to the requested user");
    if (videoJob.status !== "failed") {
      throw new Error(`Refusing to compensate a video job with status=${videoJob.status}`);
    }
    const jobs = await prisma.aiGenerationJob.aggregate({
      where: {
        userId: user.id,
        kind: "image",
        status: "completed",
        chargeState: "settled",
        idempotencyKey: { startsWith: `video:${videoJob.id}:scene:` },
      },
      _count: { _all: true },
      _sum: { creditCost: true },
    });
    console.log(JSON.stringify({
      mode: apply ? "apply" : "dry-run",
      userEmail: user.email,
      videoJobId: videoJob.id,
      videoJobStatus: videoJob.status,
      refundableJobs: jobs._count._all,
      refundableCredits: jobs._sum.creditCost ?? 0,
    }));
    if (!apply) return;

    const result = await refundSettledVideoImageBatch({
      userId: user.id,
      videoJobId: videoJob.id,
      reason,
    });
    console.log(JSON.stringify({ event: "refunded", ...result }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "refund failed");
  process.exit(1);
});
