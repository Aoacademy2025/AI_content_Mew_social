import dotenv from "dotenv";

dotenv.config({
  path: process.env.RUNPOD_ENV_FILE || ".env",
  quiet: true,
});

async function main() {
  // Load only after dotenv so Prisma and server-side configuration see the
  // production database and endpoint selected by the deployment environment.
  const {
    getRunpodImageCostSnapshot,
    syncRunpodImageBilling,
  } = await import("../src/lib/runpod-image-cost.server");
  const synced = await syncRunpodImageBilling();
  const snapshot = await getRunpodImageCostSnapshot();
  console.log(JSON.stringify({
    event: "runpod-image-cost-sync",
    ...synced,
    costBahtPerImage: snapshot.costBahtPerImage,
    targetBahtPerImage: snapshot.targetBahtPerImage,
    hardLimitBahtPerImage: snapshot.hardLimitBahtPerImage,
    deliveredImages: snapshot.deliveredImages,
    status: snapshot.status,
    admitted: snapshot.admitted,
    lastSuccessfulSyncAt: snapshot.lastSuccessfulSyncAt,
  }));
  if (!snapshot.admitted) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "RunPod image cost sync failed");
  process.exit(1);
});
