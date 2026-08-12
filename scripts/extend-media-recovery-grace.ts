import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { extendLegacyRecoveryDeadline } from "../src/lib/media-retention";

const MIGRATED_ERROR_CODE = "RemoteGcPending7d";

function modeFromArgs(args: string[]): "dry-run" | "apply" {
  if (args.some((arg) => arg !== "--apply")) {
    throw new Error("unknown recovery grace migration argument");
  }
  return args.includes("--apply") ? "apply" : "dry-run";
}

function isoOrNull(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

async function main(): Promise<void> {
  const mode = modeFromArgs(process.argv.slice(2));
  if (mode === "apply" && process.env.MEDIA_RECOVERY_GRACE_MIGRATION !== "1") {
    throw new Error("recovery grace migration apply is disabled");
  }

  const now = new Date();
  const rows = await prisma.mediaObject.findMany({
    where: {
      remoteState: "delete_pending",
      OR: [
        { lastErrorCode: null },
        { lastErrorCode: { not: MIGRATED_ERROR_CODE } },
      ],
    },
    select: {
      id: true,
      version: true,
      sizeBytes: true,
      nextRetryAt: true,
      lastErrorCode: true,
    },
    orderBy: { id: "asc" },
  });

  const planned = rows.map((row) => ({
    ...row,
    targetDeadline: extendLegacyRecoveryDeadline(row.nextRetryAt, now),
  }));
  let updated = 0;
  let skippedChanged = 0;

  if (mode === "apply") {
    for (const row of planned) {
      const result = await prisma.mediaObject.updateMany({
        where: {
          id: row.id,
          version: row.version,
          remoteState: "delete_pending",
          nextRetryAt: row.nextRetryAt,
          lastErrorCode: row.lastErrorCode,
        },
        data: {
          nextRetryAt: row.targetDeadline,
          lastErrorCode: MIGRATED_ERROR_CODE,
          version: { increment: 1 },
        },
      });
      if (result.count === 1) updated++;
      else skippedChanged++;
    }
  }

  const bytes = planned.reduce((sum, row) => sum + row.sizeBytes, BigInt(0));
  const currentDeadlines = planned
    .map((row) => row.nextRetryAt)
    .filter((value): value is Date => value !== null)
    .sort((left, right) => left.getTime() - right.getTime());
  const targetDeadlines = planned
    .map((row) => row.targetDeadline)
    .sort((left, right) => left.getTime() - right.getTime());

  console.log(JSON.stringify({
    mode,
    generatedAt: now.toISOString(),
    pendingObjects: planned.length,
    pendingBytes: Number(bytes),
    earliestCurrentDeadline: isoOrNull(currentDeadlines[0] ?? null),
    earliestTargetDeadline: isoOrNull(targetDeadlines[0] ?? null),
    updated,
    skippedChanged,
  }));
  if (skippedChanged > 0) process.exitCode = 1;
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "recovery grace migration failed");
    process.exit(1);
  });
