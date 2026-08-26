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
const lowerAt = sh.indexOf('lower_maintenance_barrier\necho "Maintenance barrier lowered');
const workerAt = sh.indexOf('WORKER_NAME="mcp-video-worker"');

check("nginx maps 503 to the styled maintenance page", /error_page\s+503\s+\/maintenance\.html;/.test(nginx));
check(
  "nginx short-circuits public locations while the flag file exists",
  (nginx.match(/if\s*\(-f\s+\/var\/www\/ai-content\/\.deploy-maintenance\)\s*\{\s*return\s+503;/g) ?? []).length >= 2,
);
check("deploy.sh uses the same flag path nginx watches", sh.includes(FLAG));
check("the barrier is raised before the build swap", raiseAt > 0 && swapAt > raiseAt);
check("the barrier is lowered only after the web health check", lowerAt > 0 && lowerAt > healthAt);
check("the barrier is lowered before the workers restart (site back first)", lowerAt > 0 && workerAt > lowerAt);
check("an EXIT trap guarantees the barrier is never left up", /trap\s+lower_maintenance_barrier\s+EXIT/.test(sh));
check(
  "raising the barrier can never abort the deploy (best effort + warning)",
  /: > "\$DEPLOY_MAINTENANCE_FLAG" 2>\/dev\/null \|\| \{/.test(sh),
);
check(
  "the health probe bypasses nginx, so the barrier cannot fail the deploy",
  sh.includes("DEPLOY_HEALTH_URL:-http://127.0.0.1:3000/api/health"),
);

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nverify-deploy-maintenance-window: PASS");
