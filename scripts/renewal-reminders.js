// Runs daily via PM2 cron to deliver manual-renew reminders, grant expiry nudges,
// past-due dunning follow-ups, dormant-payer re-activation, and checkout recovery.
// Calls the internal API route with CRON_SECRET for auth.
const { runCronHttp } = require("./lib/cron-http");

runCronHttp({
  name: "renewal-reminders",
  path: "/api/cron/renewal-reminders",
  timeoutMs: 180000,
  retries: 1,
});
