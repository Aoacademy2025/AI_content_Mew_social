import "dotenv/config";
import { planAndRunLocalMediaEviction, evictionRunExitCode } from "../src/lib/media-local-eviction";
import { reconcileMissingVerifiedLocalMedia } from "../src/lib/media-local-missing-reconcile";
import {
  activeCustomerMediaJobs,
  hasActiveCustomerMediaJobs,
} from "../src/lib/customer-media-activity";
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
    "--deferWhenBusy",
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
  const maxObjects = numberArg("maxObjects", 10);
  // HERO-41: this used to be the ONLY busy check, evaluated before the two long
  // scans below. A run that started on an idle box then held ~98% of a core and
  // the storage lock for over 100 minutes while customer renders piled up. The
  // same check is now a gate the scans poll, so the run stops when work arrives.
  const deferWhenBusy = hasFlag("deferWhenBusy");
  if (deferWhenBusy) {
    const activity = await activeCustomerMediaJobs();
    if (hasActiveCustomerMediaJobs(activity)) {
      console.log(JSON.stringify({
        mode,
        deferredReason: "customer_media_active",
        ...activity,
        scanned: 0,
        eligible: { count: 0, sizeBytes: 0 },
        evicted: { count: 0, sizeBytes: 0 },
        errors: 0,
      }));
      return;
    }
  }
  const shouldYield = deferWhenBusy
    ? async () => hasActiveCustomerMediaJobs(await activeCustomerMediaJobs())
    : undefined;

  const reconciliation = await reconcileMissingVerifiedLocalMedia({
    mode,
    maxObjects,
    maxBytes: maxBytesMb * 1024 * 1024,
    shouldYield,
  });
  if (reconciliation.deferredReason) {
    console.log(JSON.stringify({
      mode,
      deferredReason: reconciliation.deferredReason,
      stage: "missing_local_reconciliation",
      missingLocalReconciliation: reconciliation,
    }));
    return;
  }
  const report = await planAndRunLocalMediaEviction({
    olderThanDays: numberArg("olderThanDays", 3),
    includeStocks: hasFlag("includeStocks"),
    options: {
      mode,
      maxObjects,
      maxBytes: maxBytesMb * 1024 * 1024,
      shouldYield,
    },
  });
  console.log(JSON.stringify({
    ...report,
    missingLocalReconciliation: reconciliation,
    eligibleMb: Math.round(report.eligible.sizeBytes / 1024 / 1024),
    evictedMb: Math.round(report.evicted.sizeBytes / 1024 / 1024),
  }));
  process.exitCode = evictionRunExitCode(report, reconciliation);
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "local media eviction failed");
    process.exit(1);
  });
