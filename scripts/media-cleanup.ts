import "dotenv/config";
import {
  applyMediaCleanupPlan,
  applyTmpCleanupPlan,
  getMediaCleanupPlan,
  mediaCleanupSummary,
} from "../src/lib/media-cleanup";
import {
  purgeMediaQuarantine,
  restoreQuarantineRun,
  writeMediaHealthMetrics,
} from "../src/lib/media-quarantine";
import { writeCronHeartbeat } from "../src/lib/cron-heartbeat";

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function numberArg(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function stringArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const olderThanDays = numberArg("olderThanDays", 3);
  const includeStocks = hasFlag("includeStocks");
  const includeTmp = hasFlag("includeTmp");
  const apply = hasFlag("apply");
  const cleanupTmp = hasFlag("cleanup-tmp");
  const purge = hasFlag("purge-quarantine");
  const restoreRunId = stringArg("restore-run");
  const manifestSha256 = stringArg("manifestSha256");

  if ([apply, cleanupTmp, purge, Boolean(restoreRunId)].filter(Boolean).length > 1) {
    throw new Error("choose only one of --apply, --cleanup-tmp, --purge-quarantine, or --restore-run");
  }
  if (apply && includeTmp) {
    throw new Error("--includeTmp cannot be combined with customer-media --apply; use --cleanup-tmp separately");
  }

  if (cleanupTmp) {
    const tmpPlan = await getMediaCleanupPlan({ olderThanDays, includeTmp: true });
    console.log(JSON.stringify({ mode: "cleanup-tmp", ...mediaCleanupSummary(tmpPlan) }, null, 2));
    if (tmpPlan.graphErrors.length > 0) {
      throw new Error(`media graph incomplete: ${tmpPlan.graphErrors.length} error(s)`);
    }
    const result = applyTmpCleanupPlan(tmpPlan);
    const healthPlan = await getMediaCleanupPlan();
    if (healthPlan.graphErrors.length > 0) {
      throw new Error(`media graph incomplete: ${healthPlan.graphErrors.length} error(s)`);
    }
    await writeMediaHealthMetrics(healthPlan);
    console.log(JSON.stringify({ result }, null, 2));
    writeCronHeartbeat("media-cleanup");
    return;
  }

  if (purge) {
    const reviewPlan = await getMediaCleanupPlan({ includeStocks: true });
    if (reviewPlan.graphErrors.length > 0) {
      console.log(JSON.stringify({ mode: "purge-quarantine", ...mediaCleanupSummary(reviewPlan) }, null, 2));
      throw new Error(`media graph incomplete: ${reviewPlan.graphErrors.length} error(s)`);
    }
    const result = await purgeMediaQuarantine();
    const healthPlan = await getMediaCleanupPlan({ includeStocks: true });
    if (healthPlan.graphErrors.length > 0) {
      throw new Error(`media graph incomplete: ${healthPlan.graphErrors.length} error(s)`);
    }
    await writeMediaHealthMetrics(healthPlan);
    console.log(JSON.stringify({ mode: "purge-quarantine", result }, null, 2));
    writeCronHeartbeat("media-cleanup");
    return;
  }

  if (restoreRunId) {
    const result = await restoreQuarantineRun(restoreRunId);
    const healthPlan = await getMediaCleanupPlan({ includeStocks: true });
    if (healthPlan.graphErrors.length > 0) {
      console.log(JSON.stringify({ mode: "restore", ...mediaCleanupSummary(healthPlan), result }, null, 2));
      throw new Error(`media graph incomplete: ${healthPlan.graphErrors.length} error(s)`);
    }
    await writeMediaHealthMetrics(healthPlan);
    console.log(JSON.stringify({ mode: "restore", result }, null, 2));
    writeCronHeartbeat("media-cleanup");
    return;
  }

  const plan = await getMediaCleanupPlan({ olderThanDays, includeStocks, includeTmp });
  const summary = mediaCleanupSummary(plan);

  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    ...summary,
  }, null, 2));

  if (plan.graphErrors.length > 0) {
    throw new Error(`media graph incomplete: ${plan.graphErrors.length} error(s)`);
  }

  if (apply) {
    if (!manifestSha256) throw new Error("--manifestSha256=<reviewed hash> is required with --apply");
    const result = await applyMediaCleanupPlan(plan, manifestSha256);
    const healthPlan = await getMediaCleanupPlan({ olderThanDays, includeStocks, includeTmp: false });
    if (healthPlan.graphErrors.length > 0) {
      throw new Error(`media graph incomplete: ${healthPlan.graphErrors.length} error(s)`);
    }
    await writeMediaHealthMetrics(healthPlan);
    console.log(JSON.stringify({ result }, null, 2));
  } else {
    await writeMediaHealthMetrics(plan);
  }

  writeCronHeartbeat("media-cleanup");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
