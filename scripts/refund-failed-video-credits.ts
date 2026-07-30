import dotenv from "dotenv";

dotenv.config({ path: process.env.REFUND_ENV_FILE || ".env", quiet: true });

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length).trim();
}

function positiveIntegerArgument(name: string): number | undefined {
  const raw = argument(name);
  if (raw == null) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return parsed;
}

async function main() {
  const userEmail = argument("user-email")?.toLowerCase();
  const videoJobId = argument("video-job");
  const reason = argument("reason") || "failed_video_compensation";
  const expectedImages = positiveIntegerArgument("expected-images");
  const expectedCredits = positiveIntegerArgument("expected-credits");
  const apply = process.argv.includes("--apply");
  if (!userEmail || !videoJobId) {
    throw new Error(
      "Usage: npm run ops:refund-failed-video-credits -- --user-email=<email> --video-job=<id> [--reason=<reason>] [--expected-images=<n>] [--expected-credits=<n>] [--apply]",
    );
  }
  if (apply && (expectedImages == null || expectedCredits == null)) {
    throw new Error("--apply requires both --expected-images and --expected-credits guards");
  }

  const [
    { prisma },
    { refundSettledVideoImageBatch },
    { refundVideoJobBaseReservation, summarizeRenderReservationFunding },
    { getBalance },
  ] = await Promise.all([
    import("../src/lib/prisma"),
    import("../src/lib/video-image-batch-settlement"),
    import("../src/lib/render/reservation-settlement"),
    import("../src/lib/credits"),
  ]);

  try {
    const user = await prisma.user.findFirst({
      where: { email: { equals: userEmail } },
      select: { id: true },
    });
    if (!user) throw new Error("User not found");
    const videoJob = await prisma.videoJob.findFirst({
      where: { id: videoJobId, userId: user.id },
      select: { id: true, status: true, currentStep: true },
    });
    if (!videoJob) throw new Error("Video job does not belong to the requested user");
    if (videoJob.status !== "failed") {
      throw new Error(`Refusing to compensate a video job with status=${videoJob.status}`);
    }

    const [images, renderJobs, balanceBefore] = await Promise.all([
      prisma.aiGenerationJob.aggregate({
        where: {
          userId: user.id,
          kind: "image",
          status: "completed",
          chargeState: "settled",
          idempotencyKey: { startsWith: `video:${videoJob.id}:scene:` },
        },
        _count: { _all: true },
        _sum: { creditCost: true },
      }),
      prisma.renderJob.findMany({
        where: {
          userId: user.id,
          parentJobId: videoJob.id,
          type: "RENDER",
        },
        orderBy: { createdAt: "asc" },
        take: 2,
      }),
      getBalance(user.id),
    ]);

    const renderJob = renderJobs.length === 1 ? renderJobs[0] : null;
    const renderFunding = renderJob?.reservedQuota
      ? summarizeRenderReservationFunding(renderJob)
      : null;
    const imageCredits = images._sum.creditCost ?? 0;
    const renderCredits = renderFunding?.funding === "credits" ? renderFunding.amount : 0;
    const refundableCredits = imageCredits + renderCredits;

    console.log(JSON.stringify({
      mode: apply ? "apply" : "dry-run",
      userMatched: true,
      videoJobId: videoJob.id,
      videoJobStatus: videoJob.status,
      currentStep: videoJob.currentStep,
      refundableImageJobs: images._count._all,
      refundableImageCredits: imageCredits,
      renderReservation: renderJob
        ? {
            id: renderJob.id,
            status: renderJob.status,
            reserved: renderJob.reservedQuota,
            funding: renderFunding,
          }
        : { candidateCount: renderJobs.length },
      refundableCredits,
      availableCreditsBefore: balanceBefore.total,
    }));

    if (expectedImages != null && images._count._all !== expectedImages) {
      throw new Error(
        `Expected ${expectedImages} refundable images, found ${images._count._all}; refusing`,
      );
    }
    if (expectedCredits != null && refundableCredits !== expectedCredits) {
      throw new Error(
        `Expected ${expectedCredits} refundable credits, found ${refundableCredits}; refusing`,
      );
    }
    if (!apply) return;
    if (!renderJob || renderJobs.length !== 1) {
      throw new Error(`Expected exactly one base RenderJob, found ${renderJobs.length}; refusing`);
    }
    if (renderJob.status === "QUEUED" || renderJob.status === "RUNNING") {
      throw new Error(`Base RenderJob is still ${renderJob.status}; refusing`);
    }

    const imageResult = await refundSettledVideoImageBatch({
      userId: user.id,
      videoJobId: videoJob.id,
      reason,
    });
    const renderResult = await refundVideoJobBaseReservation({
      userId: user.id,
      videoJobId: videoJob.id,
      reason,
    });
    if (
      renderResult.kind === "not_found"
      || renderResult.kind === "ambiguous"
      || renderResult.kind === "in_flight"
    ) {
      throw new Error(`Base render settlement returned ${renderResult.kind}`);
    }
    const balanceAfter = await getBalance(user.id);
    console.log(JSON.stringify({
      event: "refunded",
      imageResult,
      renderResult,
      availableCreditsAfter: balanceAfter.total,
      availableCreditsDelta: balanceAfter.total - balanceBefore.total,
    }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "refund failed");
  process.exit(1);
});
