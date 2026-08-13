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
assert.ok(gateFlag > buildReady, "empty-queue gate runs only after a successful staging build");
assert.ok(queueCheck >= gateFlag && queueCheck < swap, "queue checker runs immediately before swap");
assert.ok(swap < restart, "swap remains before restart");
assert.match(deploy, /if \[ "\$\{REQUIRE_EMPTY_RENDER_QUEUES:-0\}" = "1" \]; then/);
assert.match(deploy, /MAINTENANCE_PAGE_DIR="\/var\/www\/heroai-maintenance"[\s\S]*maintenance\.html\.next[\s\S]*mv "\$MAINTENANCE_PAGE_DIR\/maintenance\.html\.next"/);
assert.match(deploy, /if ! npx tsx scripts\/check-empty-render-queues\.ts; then[\s\S]*rm -rf "\$STAGING_DIR"[\s\S]*exit 1[\s\S]*fi/);
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
  "REQUIRE_EMPTY_RENDER_QUEUES=1",
  ".deploy-maintenance",
  "ops:render-drain -- off",
  ".next.old",
  "superseded",
]) {
  assert.ok(runbook.includes(required), `runbook contains ${required}`);
}
assert.match(runbook, /ห้าม.*cancel|do not cancel/i);
assert.match(runbook, /trap[\s\S]*\.deploy-maintenance[\s\S]*ops:render-drain -- off/);

console.log("ALL PASS");
