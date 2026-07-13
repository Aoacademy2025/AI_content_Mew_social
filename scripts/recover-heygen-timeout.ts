import "dotenv/config";

import { prisma } from "../src/lib/prisma";
import { pipelineCaller } from "../src/lib/mcp/pipeline-client";
import {
  applyLegacyAvatarRecovery,
  formatLegacyAvatarRecoveryResult,
  inspectLegacyAvatarRecovery,
} from "../src/lib/mcp/legacy-avatar-recovery";

function parseArgs(argv: string[]) {
  let apply = false;
  let jobId = "";
  let heygenVideoId = "";
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--apply") apply = true;
    else if (arg === "--job-id") jobId = argv[++index] ?? "";
    else if (arg === "--heygen-video-id") heygenVideoId = argv[++index] ?? "";
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!jobId || !heygenVideoId) {
    throw new Error("usage: recover-heygen-timeout.ts [--apply] --job-id ID --heygen-video-id ID");
  }
  return { apply, jobId, heygenVideoId };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inspection = await inspectLegacyAvatarRecovery(
    { jobId: args.jobId, heygenVideoId: args.heygenVideoId },
    {
      workspaceRoot: process.cwd(),
      pollProvider: async (userId, providerVideoId) => {
        return pipelineCaller(userId).post("/api/videos/poll-avatar", { videoId: providerVideoId }, { retries: 0 });
      },
    },
  );
  console.log(formatLegacyAvatarRecoveryResult(inspection));

  if (!args.apply) {
    if (inspection.status === "rejected") process.exitCode = 2;
    return;
  }
  if (inspection.status !== "recoverable" && inspection.status !== "pending") {
    throw new Error(`refusing apply for ${inspection.status} inspection`);
  }
  const applied = await applyLegacyAvatarRecovery(inspection);
  console.log(JSON.stringify(applied));
  if (!applied.applied && !applied.idempotent) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
