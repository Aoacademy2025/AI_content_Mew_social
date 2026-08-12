import "dotenv/config";
import { runR2OrphanGc } from "../src/lib/media-r2-orphan-gc";
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
    "--summary",
    "--manifestSha256=",
    "--maxObjects=",
    "--maxBytesMb=",
  ];
  const unknown = process.argv.slice(2).find((arg) =>
    !known.some((item) => item.endsWith("=") ? arg.startsWith(item) : arg === item)
  );
  if (unknown) throw new Error("unknown R2 orphan GC argument");
  if (hasFlag("automated") && !hasFlag("apply")) {
    throw new Error("automated R2 orphan GC requires --apply");
  }

  const report = await runR2OrphanGc({
    mode: hasFlag("apply") ? "apply" : "dry-run",
    automated: hasFlag("automated"),
    manifestSha256: stringArg("manifestSha256"),
    maxObjects: numberArg("maxObjects", 10),
    maxBytes: numberArg("maxBytesMb", 1024) * 1024 * 1024,
  });
  const { records: _records, ...summary } = report;
  console.log(JSON.stringify(hasFlag("summary") ? summary : report));
  if (report.errors > 0) process.exitCode = 1;
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "R2 orphan GC failed");
    process.exit(1);
  });
