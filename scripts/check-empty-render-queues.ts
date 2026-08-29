import "dotenv/config";

import { prisma } from "../src/lib/prisma";
import { readRenderQueueCounts } from "../src/lib/render-deploy-drain";

async function main() {
  const counts = await readRenderQueueCounts();
  console.log(`videoJobs=${counts.videoJobs} renderJobs=${counts.renderJobs} empty=${counts.empty ? "yes" : "no"}`);
  if (!counts.empty) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
