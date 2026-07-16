import { prisma } from "../src/lib/prisma";
import {
  RENDER_DEPLOY_DRAIN_KEY,
  readRenderQueueCounts,
} from "../src/lib/render-deploy-drain";

async function main() {
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length > 0 || !command || !["status", "on", "off"].includes(command)) {
    console.error("usage: set-render-deploy-drain.ts status|on|off");
    process.exitCode = 2;
    return;
  }

  if (command === "on" || command === "off") {
    const value = command === "on" ? "1" : "0";
    await prisma.siteConfig.upsert({
      where: { key: RENDER_DEPLOY_DRAIN_KEY },
      update: { value },
      create: { key: RENDER_DEPLOY_DRAIN_KEY, value },
    });
  }

  const [row, counts] = await Promise.all([
    prisma.siteConfig.findUnique({ where: { key: RENDER_DEPLOY_DRAIN_KEY }, select: { value: true } }),
    readRenderQueueCounts(),
  ]);
  console.log(`render drain=${row?.value === "1" ? "on" : "off"} videoJobs=${counts.videoJobs} renderJobs=${counts.renderJobs}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
