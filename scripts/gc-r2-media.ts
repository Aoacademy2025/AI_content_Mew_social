import "dotenv/config";
import { runRemoteMediaGc } from "../src/lib/media-remote-gc";
import { prisma } from "../src/lib/prisma";

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function stringArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function numberArg(name: string, fallback: number): number {
  const value = Number(stringArg(name));
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

async function main(): Promise<void> {
  const known = [
    "--apply",
    "--automated",
    "--pendingOnly",
    "--summary",
    "--manifestSha256=",
    "--maxObjects=",
    "--maxBytesMb=",
    "--graceHours=",
  ];
  const unknown = process.argv.slice(2).find((arg) =>
    !known.some((item) => item.endsWith("=") ? arg.startsWith(item) : arg === item)
  );
  if (unknown) throw new Error("unknown R2 remote GC argument");
  if (hasFlag("automated") && !hasFlag("apply")) {
    throw new Error("automated R2 remote GC requires --apply");
  }

  const report = await runRemoteMediaGc({
    mode: hasFlag("apply") ? "apply" : "dry-run",
    automated: hasFlag("automated"),
    pendingOnly: hasFlag("pendingOnly"),
    manifestSha256: stringArg("manifestSha256"),
    maxObjects: numberArg("maxObjects", 10),
    maxBytes: numberArg("maxBytesMb", 1024) * 1024 * 1024,
    graceHours: numberArg("graceHours", 24),
  });
  const { records: _records, ...summary } = report;
  const output = hasFlag("summary") ? summary : report;
  console.log(JSON.stringify({
    ...output,
    eligibleMb: Math.round(report.eligible.sizeBytes / 1024 / 1024),
    selectedMb: Math.round(report.selected.sizeBytes / 1024 / 1024),
    stagedMb: Math.round(report.staged.sizeBytes / 1024 / 1024),
    deletedMb: Math.round(report.deleted.sizeBytes / 1024 / 1024),
    missingFinalizedMb: Math.round(
      report.missingFinalized.sizeBytes / 1024 / 1024,
    ),
    restoredMb: Math.round(report.restored.sizeBytes / 1024 / 1024),
  }));
  if (report.errors > 0) process.exitCode = 1;
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "R2 remote GC failed");
    process.exit(1);
  });
