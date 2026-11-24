// Daily counts-only MAPC snapshot. No user IDs, emails, prompts, or output URLs
// are written to NorthStarDailySnapshot.
const { runCronHttp } = require("./lib/cron-http");

runCronHttp({
  name: "north-star-snapshot",
  path: "/api/cron/north-star-snapshot",
  timeoutMs: 90000,
  retries: 1,
});
