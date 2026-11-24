// Runs every ~15 min via PM2 cron to settle-or-refund AI image credit
// reservations that got stuck at chargeState="reserved" (RunPod status-poll
// outage, or a hard deadline reached while the job was still queued).
// Calls the internal API with CRON_SECRET.
const { runCronHttp } = require("./lib/cron-http");

runCronHttp({
  name: "reconcile-ai-images",
  path: "/api/cron/reconcile-ai-images?dryRun=0&olderThanMinutes=30&limit=50",
  timeoutMs: 120000,
  retries: 1,
});
