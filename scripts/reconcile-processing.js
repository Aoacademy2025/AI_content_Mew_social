// Runs every ~15 min via PM2 cron to self-heal stale PROCESSING videos that
// already have a valid output file. Calls the internal API with CRON_SECRET.
const { runCronHttp } = require("./lib/cron-http");

runCronHttp({
  name: "reconcile-processing",
  path: "/api/cron/reconcile-processing?dryRun=0&staleAfterMinutes=30&failAfterHours=24&failMissingOutput=0",
  timeoutMs: 90000,
  retries: 1,
});
