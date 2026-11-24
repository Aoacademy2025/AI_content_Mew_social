// Runs daily via PM2 cron to revert expired free trials to FREE + send the upgrade prompt.
const { runCronHttp } = require("./lib/cron-http");

runCronHttp({
  name: "trial-expiry",
  path: "/api/cron/trial-expiry",
  timeoutMs: 90000,
  retries: 1,
});
