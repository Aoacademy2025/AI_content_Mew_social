import dotenv from "dotenv";
import { formatRunpodBillingError } from "../src/lib/runpod-image-cost";

dotenv.config({
  path: process.env.RUNPOD_ENV_FILE || ".env",
  quiet: true,
});

async function main() {
  // Load only after dotenv so Prisma and server-side configuration see the
  // production database and endpoint selected by the deployment environment.
  const { runRunpodImageCostSync } = await import("../src/lib/runpod-image-cost.server");
  const result = await runRunpodImageCostSync();
  console.log(JSON.stringify(result));
  if (!result.admitted) process.exitCode = 2;
}

main().catch((error) => {
  console.error(formatRunpodBillingError(error, "RunPod image cost sync failed"));
  process.exit(1);
});
