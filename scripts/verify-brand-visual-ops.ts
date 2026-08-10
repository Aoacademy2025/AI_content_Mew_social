import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const watchdog = readFileSync("scripts/ops-watchdog.sh", "utf8");
const localMonitor = readFileSync("scripts/local-prod-monitor.sh", "utf8");
const reconcileScript = readFileSync("scripts/reconcile-ai-images.js", "utf8");

assert.match(watchdog, /reconcile-ai-images:900/, "money reconciliation heartbeat must be monitored");
assert.match(
  localMonitor,
  /CRON=\{[^\n]*\\"reconcile-ai-images\\"/,
  "a scheduled reconciliation process may be stopped between PM2 cron runs",
);
assert.match(
  reconcileScript,
  /statusCode\s*>=\s*200[\s\S]*statusCode\s*<\s*300/,
  "cron wrapper must accept only a successful 2xx response",
);

async function wrapperExitFor(statusCode: number): Promise<number | null> {
  const server = createServer((_request, response) => {
    response.writeHead(statusCode, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ statusCode }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const child = spawn(process.execPath, ["scripts/reconcile-ai-images.js"], {
    env: {
      ...process.env,
      NEXT_PUBLIC_APP_URL: `http://127.0.0.1:${address.port}`,
      CRON_SECRET: "ops-test-secret",
    },
    stdio: "ignore",
  });
  const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return exitCode;
}

async function main() {
  assert.equal(await wrapperExitFor(200), 0, "2xx cron response is successful");
  assert.equal(await wrapperExitFor(401), 1, "bad CRON_SECRET must fail the PM2 cron process");
  assert.equal(await wrapperExitFor(403), 1, "forbidden cron response must fail the PM2 cron process");
  console.log("verify-brand-visual-ops: PASS deploy/heartbeat/auth failure gates");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
