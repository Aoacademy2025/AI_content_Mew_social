import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const deploy = readFileSync("deploy/deploy.sh", "utf8");
const nginx = readFileSync("deploy/nginx.conf", "utf8");
const maintenance = readFileSync("deploy/maintenance.html", "utf8");
const runbook = readFileSync("docs/ops/heygen-late-completion-rollout.md", "utf8");

const buildReady = deploy.indexOf('test -f "$STAGING_DIR/BUILD_ID"');
const isolatedBuild = deploy.indexOf("unshare --mount --propagation private");
const gateFlag = deploy.indexOf('REQUIRE_EMPTY_RENDER_QUEUES');
const queueCheck = deploy.indexOf('scripts/check-empty-render-queues.ts');
const dependencyInstall = deploy.indexOf('PUPPETEER_SKIP_DOWNLOAD=1 npm ci --no-audit --no-fund --legacy-peer-deps');
const preinstallGate = deploy.indexOf('Mandatory render drain before dependency mutation');
const finalGate = deploy.indexOf('Final empty queue gate');
const drainOn = deploy.indexOf('ops:render-drain -- on', preinstallGate);
const drainOff = deploy.indexOf('ops:render-drain -- off');
const trapInstall = deploy.indexOf('trap cleanup_deploy_guards EXIT');
const preinstallWait = deploy.indexOf('if ! wait_for_empty_render_queues', drainOn);
const finalWait = deploy.indexOf('if ! wait_for_empty_render_queues', finalGate);
const cleanupCall = deploy.lastIndexOf('cleanup_deploy_guards');
const swap = deploy.indexOf('Atomic swap .next-staging -> .next');
const restart = deploy.indexOf('Restart PM2');

assert.ok(buildReady >= 0, "deploy verifies staged BUILD_ID");
assert.ok(isolatedBuild >= 0 && isolatedBuild < buildReady, "build hides runtime media in a private mount namespace");
assert.match(deploy, /mount --bind "\$media_shadow" "\$app_dir\/public\/renders"/);
assert.match(deploy, /mount --bind "\$media_shadow" "\$app_dir\/stocks"/);
assert.match(deploy, /\[ ! -d "\$media_root" \] \|\| \[ -L "\$media_root" \]/);
assert.ok(
  deploy.indexOf('npm run build', isolatedBuild) < buildReady,
  "the Next build runs inside the private media namespace",
);
assert.equal(gateFlag, -1, "empty-queue safety is mandatory rather than opt-in");
assert.ok(preinstallGate >= 0 && preinstallGate < dependencyInstall, "mandatory queue safety starts before dependency mutation");
assert.ok(trapInstall >= 0 && trapInstall < drainOn, "cleanup is armed before deploy owns the durable render drain");
assert.ok(drainOn > preinstallGate && drainOn < dependencyInstall, "deploy raises the durable render drain before npm ci");
assert.ok(queueCheck >= 0, "deploy's wait loop calls the fail-closed queue checker");
assert.ok(preinstallWait > drainOn && preinstallWait < dependencyInstall, "deploy waits for active work before npm ci mutates dependencies");
assert.ok(finalGate > buildReady, "deploy rechecks the empty queue after the staging build succeeds");
assert.ok(finalWait > finalGate && finalWait < swap, "deploy keeps admission drained and rechecks before swapping");
assert.ok(swap < restart, "swap remains before restart");
assert.ok(drainOff >= 0, "cleanup owns the matching durable render-drain release");
assert.ok(cleanupCall > restart, "deploy releases its guards only after process restarts");
assert.match(deploy, /trap\s+cleanup_deploy_guards\s+EXIT/);
assert.match(deploy, /wait_for_empty_render_queues/);
assert.doesNotMatch(deploy, /REQUIRE_EMPTY_RENDER_QUEUES/);
assert.match(deploy, /MAINTENANCE_PAGE_DIR="\/var\/www\/heroai-maintenance"[\s\S]*maintenance\.html\.next[\s\S]*mv "\$MAINTENANCE_PAGE_DIR\/maintenance\.html\.next"/);
assert.match(deploy.slice(finalGate), /if ! wait_for_empty_render_queues; then[\s\S]*rm -rf "\$STAGING_DIR"[\s\S]*exit 1[\s\S]*fi/);
assert.ok(deploy.indexOf('rm -rf "$APP_DIR/.next.old"') > queueCheck, "gate failure leaves live .next and .next.old untouched");
assert.ok(!deploy.includes("render-cancel") && !deploy.includes("ops:cancel") && !/status\s*=\s*['\"]CANCEL/i.test(deploy), "deploy never cancels user work");
assert.match(
  deploy,
  /PUPPETEER_SKIP_DOWNLOAD=1 npm ci --no-audit --no-fund --legacy-peer-deps/,
  "production install reproduces the reviewed lock graph without downloading another browser",
);
assert.doesNotMatch(
  deploy,
  /npm install --no-audit --no-fund --package-lock=false/,
  "production deploy cannot re-resolve semver ranges outside the lockfile",
);

assert.ok(nginx.includes("if (-f /var/www/ai-content/.deploy-maintenance)"), "nginx template honors the first-rollout marker");
assert.ok(nginx.includes("return 503;"), "maintenance marker returns 503");
assert.match(nginx, /error_page\s+503\s+\/maintenance\.html;/, "503 uses the branded maintenance document");
assert.match(nginx, /location\s*=\s*\/maintenance\.html[\s\S]*\binternal;/, "maintenance document is internal-only");
assert.match(nginx, /root\s+\/var\/www\/heroai-maintenance;/, "maintenance document lives outside the release working tree");
assert.match(nginx, /Retry-After\s+\"?120\"?\s+always;/, "maintenance response tells clients when to retry");
assert.match(nginx, /Cache-Control\s+\"no-store[^\"]*\"\s+always;/, "maintenance response is never cached");
assert.match(maintenance, /<html[^>]+lang="th"/i, "maintenance page declares Thai");
assert.match(maintenance, /<title>[^<]*กำลังอัปเดตระบบ[^<]*<\/title>/i, "maintenance page has a useful browser title");
assert.match(maintenance, /กำลังอัปเดตระบบ/, "maintenance page explains the service state");
assert.match(maintenance, /ลองเชื่อมต่อใหม่อัตโนมัติ/, "maintenance page explains automatic retry");
assert.match(maintenance, /http-equiv="refresh"\s+content="30"/i, "maintenance page retries automatically");
assert.doesNotMatch(maintenance, /https?:\/\//i, "maintenance page has no deploy-fragile external assets");

for (const required of [
  "PRAGMA quick_check",
  "Mandatory render drain",
  ".deploy-maintenance",
  "ops:render-drain -- status",
  ".next.old",
  "superseded",
]) {
  assert.ok(runbook.includes(required), `runbook contains ${required}`);
}
assert.match(runbook, /ห้าม.*cancel|do not cancel/i);
assert.match(runbook, /cleanup trap ภายใน script/);

console.log("ALL PASS");
