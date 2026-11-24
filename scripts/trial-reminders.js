// Runs daily via PM2 cron to send the trial lifecycle nudges (2 days left / expiry day /
// day +3). Calls the internal API route with CRON_SECRET for auth. The route itself is a
// no-op unless TRIAL_REMINDERS=1.
const { runCronHttp } = require("./lib/cron-http");

runCronHttp({
  name: "trial-reminders",
  path: "/api/cron/trial-reminders",
  timeoutMs: 90000,
  retries: 1,
});
