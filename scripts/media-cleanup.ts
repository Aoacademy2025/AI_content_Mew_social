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
  writeMediaCleanupReviewArtifact,
  writeMediaHealthMetrics,
} from "../src/lib/media-quarantine";
import { writeCronHeartbeat } from "../src/lib/cron-heartbeat";

const MODE_USAGE = "default dry-run | --apply --manifestSha256=<sha256> | --restore-run=<runId> | --purge-quarantine";

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

function sanitizedFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/^media graph incomplete: \d+ error\(s\)$/.test(message)) return message;
  if (message === "reviewed manifest hash mismatch") return message;
  if (message === "invalid quarantine run id" || message === "invalid quarantine manifest") return message;
  if (
    message.startsWith("--") ||
    message.startsWith("media cleanup operation modes are mutually exclusive") ||
    message === "restore and purge do not accept cleanup selection flags"
  ) return message;
  return "media cleanup operation failed";
}

async function main() {
  const olderThanDaysArg = stringArg("olderThanDays");
  const olderThanDaysSelected = olderThanDaysArg !== undefined || hasFlag("olderThanDays");
  const olderThanDays = numberArg("olderThanDays", 3);
  const includeStocks = hasFlag("includeStocks");
  const includeTmp = hasFlag("includeTmp");
  const apply = hasFlag("apply");
  const reviewedManifestSha256 = stringArg("manifestSha256");
  const restoreRunId = stringArg("restore-run");
  const purgeQuarantine = hasFlag("purge-quarantine");
  const selectedModes = Number(apply) + Number(Boolean(restoreRunId)) + Number(purgeQuarantine);

  if (selectedModes > 1) {
    throw new Error(`media cleanup operation modes are mutually exclusive: ${MODE_USAGE}`);
  }
  if (reviewedManifestSha256 && !apply) {
    throw new Error("--manifestSha256 requires --apply");
  }
  if (apply && !/^[a-f0-9]{64}$/.test(reviewedManifestSha256 ?? "")) {
    throw new Error("--apply requires --manifestSha256=<reviewed sha256>");
  }
  if (
    (restoreRunId || purgeQuarantine) &&
    (includeStocks || includeTmp || olderThanDaysSelected)
  ) {
    throw new Error("restore and purge do not accept cleanup selection flags");
  }

  if (restoreRunId) {
    const result = await restoreQuarantineRun(restoreRunId);
    console.log(JSON.stringify({ mode: "restore", result }, null, 2));
    return;
  }
  if (purgeQuarantine) {
    const result = await purgeMediaQuarantine();
    console.log(JSON.stringify({ mode: "purge-quarantine", result }, null, 2));
    return;
  }

  const plan = await getMediaCleanupPlan({ olderThanDays, includeStocks, includeTmp });
  const summary = mediaCleanupSummary(plan);

  if (plan.graphErrors.length > 0) {
    throw new Error(`media graph incomplete: ${plan.graphErrors.length} error(s)`);
  }

  const reviewArtifact = apply ? null : await writeMediaCleanupReviewArtifact(plan);
  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    ...summary,
    ...(reviewArtifact ? { reviewArtifact } : {}),
  }, null, 2));

  let result = null;
  let tmpResult = null;
  let metricsPlan = plan;
  if (apply) {
    result = await applyMediaCleanupPlan(plan, reviewedManifestSha256!);
    if (includeTmp) tmpResult = applyTmpCleanupPlan(plan);
    metricsPlan = await getMediaCleanupPlan({ olderThanDays, includeStocks, includeTmp });
    if (metricsPlan.graphErrors.length > 0) {
      throw new Error(`media graph incomplete: ${metricsPlan.graphErrors.length} error(s)`);
    }
    console.log(JSON.stringify({ result, tmpResult }, null, 2));
  }

  await writeMediaHealthMetrics(metricsPlan);
  writeCronHeartbeat("media-cleanup");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(sanitizedFailureMessage(error));
    process.exit(1);
  });
