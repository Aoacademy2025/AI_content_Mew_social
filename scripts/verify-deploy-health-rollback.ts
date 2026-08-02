import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const deploy = readFileSync("deploy/deploy.sh", "utf8");
const syntax = spawnSync("bash", ["-n", "deploy/deploy.sh"], { encoding: "utf8" });

assert.equal(syntax.status, 0, syntax.stderr || "deploy script must be valid bash");
assert.match(deploy, /DEPLOY_HEALTH_URL="\$\{DEPLOY_HEALTH_URL:-http:\/\/127\.0\.0\.1:3000\/api\/health\}"/);
assert.match(deploy, /DEPLOY_HEALTH_TIMEOUT_SEC="\$\{DEPLOY_HEALTH_TIMEOUT_SEC:-90\}"/);
assert.match(deploy, /wait_for_web_health\(\)/, "deploy defines a bounded health probe");
assert.match(deploy, /curl[^\n]+"\$DEPLOY_HEALTH_URL"/, "health probe uses the configured URL");
assert.match(deploy, /rollback_web_build\(\)/, "deploy defines automatic web rollback");
assert.match(
  deploy,
  /rollback_web_build\(\)[\s\S]*mv "\$APP_DIR\/\.next" "\$failed_build_dir"[\s\S]*mv "\$APP_DIR\/\.next\.old" "\$APP_DIR\/\.next"/,
  "rollback quarantines the failed build and restores the prior build",
);

const rolloutStart = deploy.indexOf("release_failed=0");
const webRestart = deploy.indexOf('if ! restart_from_ecosystem "$APP_NAME"; then', rolloutStart);
const healthGate = deploy.indexOf("elif ! wait_for_web_health; then", webRestart);
const workerRestart = deploy.indexOf('restart_from_ecosystem "$WORKER_NAME"');
assert.ok(webRestart >= 0 && healthGate > webRestart, "new web build is health-checked after restart");
assert.ok(workerRestart > healthGate, "workers stay on the prior code until the web build passes health");
assert.match(
  deploy.slice(webRestart, workerRestart),
  /if ! restart_from_ecosystem "\$APP_NAME"; then[\s\S]*release_failed=1[\s\S]*elif ! wait_for_web_health; then[\s\S]*release_failed=1/,
  "a PM2 start failure and a health failure both enter rollback",
);
assert.match(
  deploy.slice(healthGate, workerRestart),
  /rollback_web_build[\s\S]*if ! wait_for_web_health; then[\s\S]*exit 1/,
  "a failed release restores and verifies the prior build, then returns a failed deploy",
);
assert.doesNotMatch(deploy, /^\s*pm2 startup\b/m, "routine deploy must not mutate boot service registration");

console.log("deploy health rollback verification passed");
