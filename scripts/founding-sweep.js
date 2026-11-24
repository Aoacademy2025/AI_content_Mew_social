// Runs every ~15 min via PM2 cron to release abandoned Founding-100 seats back into the pool.
// Backstop for a missed Stripe `checkout.session.expired` webhook. Calls the internal API with CRON_SECRET.
const { runCronHttp } = require("./lib/cron-http");

runCronHttp({
  name: "founding-sweep",
  path: "/api/cron/founding-sweep",
  timeoutMs: 90000,
  retries: 1,
});
