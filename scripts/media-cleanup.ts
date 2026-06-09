import "dotenv/config";
import {
  applyMediaCleanupPlan,
  getMediaCleanupPlan,
  mediaCleanupSummary,
} from "../src/lib/media-cleanup";

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function numberArg(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

async function main() {
  const olderThanDays = numberArg("olderThanDays", 3);
  const includeStocks = hasFlag("includeStocks");
  const includeTmp = hasFlag("includeTmp");
  const apply = hasFlag("apply");

  const plan = await getMediaCleanupPlan({ olderThanDays, includeStocks, includeTmp });
  const summary = mediaCleanupSummary(plan);

  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    ...summary,
  }, null, 2));

  if (apply) {
    const result = applyMediaCleanupPlan(plan);
    console.log(JSON.stringify({ result }, null, 2));
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
