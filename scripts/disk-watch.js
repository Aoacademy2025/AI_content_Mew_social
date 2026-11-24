// Runs daily via PM2 cron to sweep safe junk and alert admins when disk is high.
// Calls the internal API route with CRON_SECRET for auth.
const { runCronHttp } = require("./lib/cron-http");

runCronHttp({
  name: "disk-watch",
  path: "/api/cron/disk-watch",
  timeoutMs: 90000,
  retries: 1,
});
