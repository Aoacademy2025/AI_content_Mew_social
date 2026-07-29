import "dotenv/config";
import { planAndRunLocalMediaEviction } from "../src/lib/media-local-eviction";
import { prisma } from "../src/lib/prisma";

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function numberArg(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

async function main(): Promise<void> {
  const known = [
    "--apply",
    "--includeStocks",
    "--olderThanDays=",
    "--maxObjects=",
    "--maxBytesMb=",
  ];
  const unknown = process.argv.slice(2).find((arg) =>
    !known.some((item) => item.endsWith("=") ? arg.startsWith(item) : arg === item)
  );
  if (unknown) throw new Error("unknown local eviction argument");

  const mode = hasFlag("apply") ? "apply" : "dry-run";
  const maxBytesMb = numberArg("maxBytesMb", 1024);
  const report = await planAndRunLocalMediaEviction({
    olderThanDays: numberArg("olderThanDays", 3),
    includeStocks: hasFlag("includeStocks"),
    options: {
      mode,
      maxObjects: numberArg("maxObjects", 10),
      maxBytes: maxBytesMb * 1024 * 1024,
    },
  });
  console.log(JSON.stringify({
    ...report,
    eligibleMb: Math.round(report.eligible.sizeBytes / 1024 / 1024),
    evictedMb: Math.round(report.evicted.sizeBytes / 1024 / 1024),
  }));
  if (report.errors > 0) process.exitCode = 1;
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "local media eviction failed");
    process.exit(1);
  });
