import "dotenv/config";
import {
  applyMediaExpiryBackfill,
  discoverMediaExpiryBackfill,
  type MediaExpiryBackfillReport,
} from "../src/lib/media-expiry-backfill";
import { prisma } from "../src/lib/prisma";

function readArgs(argv: string[]): { apply: boolean; expectedHash: string | undefined } {
  const unknown = argv.filter(
    (arg) => arg !== "--apply" && !arg.startsWith("--report-sha256="),
  );
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}`);

  const hashArgs = argv.filter((arg) => arg.startsWith("--report-sha256="));
  if (hashArgs.length > 1) throw new Error("--report-sha256 may be provided only once");

  const expectedHash = hashArgs[0]?.slice("--report-sha256=".length);
  if (expectedHash !== undefined && !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error("--report-sha256 must be a lowercase 64-character SHA-256 hash");
  }

  return { apply: argv.includes("--apply"), expectedHash };
}

async function main() {
  const { apply, expectedHash } = readArgs(process.argv.slice(2));
  const { rows, sha256 } = await discoverMediaExpiryBackfill(prisma);

  if (!apply) {
    const report: MediaExpiryBackfillReport = { mode: "dry-run", rows, sha256 };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  if (!expectedHash) {
    throw new Error("--apply requires --report-sha256=<hash from reviewed dry-run>");
  }
  if (expectedHash !== sha256) {
    throw new Error("reviewed report hash does not match current plan");
  }

  const updated = await applyMediaExpiryBackfill(prisma, rows);
  const report: MediaExpiryBackfillReport = { mode: "apply", rows, sha256, updated };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : "media expiry backfill failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
