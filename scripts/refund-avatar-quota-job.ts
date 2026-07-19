import "dotenv/config";

import { prisma } from "../src/lib/prisma";
import {
  applyAvatarQuotaRefund,
  inspectAvatarQuotaRefund,
} from "../src/lib/render/avatar-quota-refund";

function parseArgs(argv: string[]) {
  let apply = false;
  let confirmedLegacyHeygen402 = false;
  let videoJobId = "";
  let renderJobId = "";
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--apply") apply = true;
    else if (arg === "--confirmed-heygen-402") confirmedLegacyHeygen402 = true;
    else if (arg === "--job-id") videoJobId = argv[++index] ?? "";
    else if (arg === "--render-job-id") renderJobId = argv[++index] ?? "";
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!videoJobId || !renderJobId) {
    throw new Error("usage: refund-avatar-quota-job.ts [--apply] [--confirmed-heygen-402] --job-id VIDEO_JOB_ID --render-job-id RENDER_JOB_ID");
  }
  return { apply, confirmedLegacyHeygen402, videoJobId, renderJobId };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inspection = await inspectAvatarQuotaRefund({
    videoJobId: args.videoJobId,
    renderJobId: args.renderJobId,
    confirmedLegacyHeygen402: args.confirmedLegacyHeygen402,
  });
  process.stdout.write(`${JSON.stringify({ mode: args.apply ? "apply" : "dry-run", inspection }, null, 2)}\n`);

  if (!args.apply) {
    if (inspection.kind === "rejected") process.exitCode = 2;
    return;
  }
  if (inspection.kind === "rejected") throw new Error(`refusing apply: ${inspection.reason}`);
  const result = await applyAvatarQuotaRefund(inspection);
  process.stdout.write(`${JSON.stringify({ result }, null, 2)}\n`);
  if (result.kind === "not_found" || result.kind === "ambiguous") process.exitCode = 2;
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
