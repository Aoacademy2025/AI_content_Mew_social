// Runs daily via PM2 cron for bounded operational housekeeping.
// Customer media lifecycle is handled by the graph/quarantine pipeline.
// Calls the internal API route with CRON_SECRET for auth.
const { runCronHttp } = require("./lib/cron-http");

runCronHttp({
  name: "cleanup-videos",
  path: "/api/cron/cleanup-videos",
  timeoutMs: 90000,
  retries: 1,
});
