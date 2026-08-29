/**
 * Deploy must never expose a raw nginx 502 to customers.
 *
 * nginx already returns the styled 503 page whenever `.deploy-maintenance` exists;
 * the gap was that deploy.sh never created it, so the seconds where PM2 has port
 * 3000 closed reached customers as a bare 502 (measured 2026-08-26: 12 responses
 * in ~4s, one of them a customer mid-save).
 *
 * Static assertions over the shipped deploy assets — a real deploy cannot run in CI.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures += 1;
}

const sh = readFileSync(resolve("deploy/deploy.sh"), "utf8");
const nginx = readFileSync(resolve("deploy/nginx.conf"), "utf8");

const FLAG = "/var/www/ai-content/.deploy-maintenance";
const raiseAt = sh.indexOf("\nraise_maintenance_barrier\n");
const swapAt = sh.indexOf('echo "=== [5c/6] Atomic swap');
const healthAt = sh.indexOf("wait_for_web_health");
const workerAt = sh.indexOf('WORKER_NAME="mcp-video-worker"');
const renderWorkerRestartAt = sh.indexOf('restart_from_ecosystem "$RENDER_WORKER_NAME"');
const cleanupAt = sh.lastIndexOf("\ncleanup_deploy_guards\n");

check("nginx maps 503 to the styled maintenance page", /error_page\s+503\s+\/maintenance\.html;/.test(nginx));
check(
  "nginx short-circuits public locations while the flag file exists",
  (nginx.match(/if\s*\(-f\s+\/var\/www\/ai-content\/\.deploy-maintenance\)\s*\{\s*return\s+503;/g) ?? []).length >= 2,
);
check("deploy.sh uses the same flag path nginx watches", sh.includes(FLAG));
check("the barrier is raised before the build swap", raiseAt > 0 && swapAt > raiseAt);
check("the barrier is lowered only after the web health check", cleanupAt > healthAt);
check(
  "the barrier stays raised until both orchestration and render workers restart",
  workerAt > healthAt && cleanupAt > renderWorkerRestartAt,
);
check("an EXIT trap guarantees deploy guards are never left up", /trap\s+cleanup_deploy_guards\s+EXIT/.test(sh));
check(
  "raising the barrier can never abort the deploy (best effort + warning)",
  /: > "\$DEPLOY_MAINTENANCE_FLAG" 2>\/dev\/null \|\| \{/.test(sh),
);
check(
  "the health probe bypasses nginx, so the barrier cannot fail the deploy",
  sh.includes("DEPLOY_HEALTH_URL:-http://127.0.0.1:3000/api/health"),
);

const pullAt = sh.indexOf('echo "=== [1/6] Pull latest code ==="');
const hashBeforeAt = sh.indexOf("DEPLOY_SELF_HASH_BEFORE=\"$(sha256sum");
const reexecAt = sh.indexOf("exec bash \"$DEPLOY_SELF_PATH\"");
const ciGateAt = sh.indexOf('echo "=== [1b/6] CI gate');

check("the script hashes itself BEFORE the pull can replace it", hashBeforeAt > 0 && hashBeforeAt < pullAt);
check("a self-modifying pull re-execs the new script before the CI gate", reexecAt > pullAt && reexecAt < ciGateAt);
check("the re-exec is one-shot (no loop)", /DEPLOY_REEXECED:-0.*!=\s*"1"/.test(sh) && /export DEPLOY_REEXECED=1/.test(sh));
check("re-exec only fires when the hash actually changed", /DEPLOY_SELF_HASH_AFTER"?\s*!=\s*"\$DEPLOY_SELF_HASH_BEFORE"/.test(sh));

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nverify-deploy-maintenance-window: PASS");
