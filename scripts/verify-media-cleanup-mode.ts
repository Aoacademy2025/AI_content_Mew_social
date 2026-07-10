import assert from "node:assert/strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ecosystem = require("../ecosystem.config.js") as {
  apps?: Array<{ name?: string; args?: string; cron_restart?: string }>;
};

const jobs = (ecosystem.apps ?? []).filter((app) => app.name === "media-cleanup");
assert.equal(jobs.length, 1, "expected exactly one media-cleanup PM2 app");
assert.ok(jobs[0].cron_restart, "media-cleanup must keep an explicit schedule");
assert.doesNotMatch(
  jobs[0].args ?? "",
  /(?:^|\s)--apply(?:\s|$)/,
  "media-cleanup must stay dry-run during containment",
);
console.log("PASS media-cleanup is scheduled in dry-run mode");
