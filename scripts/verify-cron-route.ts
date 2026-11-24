import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { runAuthorizedCronJob } from "../src/lib/cron-route";

const ALL_CRON_LAUNCHERS = [
  "renewal-reminders.js",
  "cleanup-videos.js",
  "founding-sweep.js",
  "reconcile-processing.js",
  "reconcile-ai-images.js",
  "north-star-snapshot.js",
  "trial-expiry.js",
  "trial-reminders.js",
  "disk-watch.js",
] as const;

function socketTimeout(): Error {
  return Object.assign(
    new Error("Socket timeout (the database failed to respond to a query within the configured timeout)"),
    { name: "PrismaClientKnownRequestError", code: "P1008" },
  );
}

function launcher(name: string): string {
  return readFileSync(join(process.cwd(), "scripts", name), "utf8");
}

async function runLauncherAgainstServer(
  scriptName: string,
  handler: (req: IncomingMessage, res: ServerResponse, requestIndex: number) => void,
  extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number | null; requests: number; authHeaders: string[] }> {
  let requests = 0;
  const authHeaders: string[] = [];
  const openSockets = new Set<NonNullable<IncomingMessage["socket"]>>();

  const server = createServer((req, res) => {
    requests += 1;
    authHeaders.push(req.headers.authorization ?? "");
    handler(req, res, requests);
  });
  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const child = spawn(process.execPath, [join("scripts", scriptName)], {
    env: {
      ...process.env,
      NEXT_PUBLIC_APP_URL: `http://127.0.0.1:${address.port}`,
      CRON_SECRET: "cron-secret-for-verify",
      CRON_HTTP_TIMEOUT_MS: "80",
      CRON_HTTP_RETRY_DELAY_MS: "20",
      ...extraEnv,
    },
    stdio: "ignore",
  });

  const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  for (const socket of openSockets) socket.destroy();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return { exitCode, requests, authHeaders };
}

async function main() {
  const secret = "cron-secret-for-verify";

  // ── 1. runAuthorizedCronJob auth, heartbeat, 503 handling ──────────────────
  {
    const result = await runAuthorizedCronJob({
      authorization: null,
      secret,
      name: "trial-expiry",
      run: async () => ({ checked: 1 }),
    });
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { error: "Unauthorized" });
  }

  {
    const result = await runAuthorizedCronJob({
      authorization: `Bearer ${secret}`,
      secret: undefined,
      name: "trial-expiry",
      run: async () => ({ checked: 1 }),
    });
    assert.equal(result.status, 401, "unset CRON_SECRET fails closed");
  }

  {
    let heartbeat = "";
    const result = await runAuthorizedCronJob({
      authorization: `Bearer ${secret}`,
      secret,
      name: "trial-expiry",
      run: async () => ({ checked: 4, reverted: 2 }),
      onSuccess: (name) => {
        heartbeat = name;
      },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true, checked: 4, reverted: 2 });
    assert.equal(heartbeat, "trial-expiry");
  }

  {
    let heartbeat = "";
    const logs: Array<[string, unknown]> = [];
    const result = await runAuthorizedCronJob({
      authorization: `Bearer ${secret}`,
      secret,
      name: "trial-expiry",
      run: async () => {
        throw socketTimeout();
      },
      onSuccess: (name) => {
        heartbeat = name;
      },
      logError: (name, error) => {
        logs.push([name, error]);
      },
    });
    assert.equal(result.status, 503, "Prisma socket timeout is caught");
    assert.deepEqual(result.body, { ok: false, error: "cron_failed" });
    assert.equal(heartbeat, "", "failed run must not write the heartbeat");
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.[0], "trial-expiry");
  }

  {
    const logs: Array<[string, unknown]> = [];
    const result = await runAuthorizedCronJob({
      authorization: `Bearer ${secret}`,
      secret,
      name: "north-star-snapshot",
      run: async () => {
        throw socketTimeout();
      },
      logError: (name, error) => {
        logs.push([name, error]);
      },
    });
    assert.equal(result.status, 503);
    assert.equal(logs[0]?.[0], "north-star-snapshot");
  }

  // ── 2. HERO-127 single-flight concurrency guard ────────────────────────────
  {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let invocations = 0;
    let heartbeats = 0;

    const firstPromise = runAuthorizedCronJob({
      authorization: `Bearer ${secret}`,
      secret,
      name: "renewal-reminders",
      run: async () => {
        invocations += 1;
        await firstGate;
        return { remindersSent: 1 };
      },
      onSuccess: () => {
        heartbeats += 1;
      },
    });

    const overlapUnauth = await runAuthorizedCronJob({
      authorization: null,
      secret,
      name: "renewal-reminders",
      run: async () => {
        invocations += 1;
        return {};
      },
    });
    assert.equal(overlapUnauth.status, 401, "auth still runs before single-flight check");

    const overlap = await runAuthorizedCronJob({
      authorization: `Bearer ${secret}`,
      secret,
      name: "renewal-reminders",
      run: async () => {
        invocations += 1;
        return {};
      },
      onSuccess: () => {
        heartbeats += 1;
      },
    });
    assert.equal(overlap.status, 409, "overlapping cron run returns 409 instead of stacking DB sweeps");
    assert.deepEqual(overlap.body, {
      ok: false,
      error: "cron_already_running",
      name: "renewal-reminders",
    });

    releaseFirst();
    const first = await firstPromise;
    assert.equal(first.status, 200);
    assert.equal(invocations, 1, "overlapping caller never executed the cron sweep");
    assert.equal(heartbeats, 1, "heartbeat written only once by the real run");

    const afterDone = await runAuthorizedCronJob({
      authorization: `Bearer ${secret}`,
      secret,
      name: "renewal-reminders",
      run: async () => ({ remindersSent: 0 }),
    });
    assert.equal(afterDone.status, 200, "single-flight lock releases cleanly after completion");
  }

  // ── 3. HERO-127 static guardrails across all 9 HTTP cron launchers ─────────
  const helperSource = readFileSync(join(process.cwd(), "scripts", "lib", "cron-http.js"), "utf8");
  assert.match(helperSource, /let settled = false;/, "shared runner tracks single settlement per attempt");
  assert.match(
    helperSource,
    /statusCode\s*>=\s*200[\s\S]*statusCode\s*<\s*300/,
    "shared runner accepts only 2xx responses as success",
  );

  for (const file of ALL_CRON_LAUNCHERS) {
    const source = launcher(file);
    assert.match(source, /runCronHttp/, `${file} delegates to shared single-settled cron-http runner`);
    assert.match(source, /retries:\s*1\b/, `${file} caps retries at 1 (no 4-shot retry storm)`);
    assert.doesNotMatch(source, /attempt\(3\)|retries:\s*[2-9]/, `${file} must not allow exponential or multi-shot retry storms`);
    assert.doesNotMatch(source, /timeout(?:Ms)?:\s*30000\b/, `${file} timeout must exceed the 30s Prisma lock window`);
  }
  assert.match(
    launcher("renewal-reminders.js"),
    /timeoutMs:\s*180000\b/,
    "renewal-reminders waits up to 180s for its multi-sweep daily pass",
  );

  // ── 4. HERO-127 live HTTP regression tests (proves zero timeout fork-bomb) ─
  // Previously `req.on("timeout")` called `req.destroy()` -> emitted `req.on("error")`
  // and BOTH handlers called `attempt(retries - 1)`, turning 1 timeout into 2/4/8
  // concurrent requests (15 total with retries=3).
  for (const file of ALL_CRON_LAUNCHERS) {
    const timeoutResult = await runLauncherAgainstServer(file, (_req, _res) => {
      // Intentionally hold connection open past CRON_HTTP_TIMEOUT_MS so req.destroy() fires ECONNRESET.
    });
    assert.equal(timeoutResult.exitCode, 1, `${file} exits nonzero after timeout exhaustion`);
    assert.equal(
      timeoutResult.requests,
      2,
      `${file} must send exactly 2 requests on timeout (1 initial + 1 single-settled retry), got ${timeoutResult.requests}`,
    );
    assert.equal(
      timeoutResult.authHeaders[0],
      `Bearer ${secret}`,
      `${file} forwards Bearer CRON_SECRET`,
    );
  }

  // Deterministic 4xx (401 auth failure, 409 single-flight overlap) exit 1 immediately with 1 request.
  for (const statusCode of [401, 409]) {
    const res4xx = await runLauncherAgainstServer("renewal-reminders.js", (_req, res) => {
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, statusCode }));
    });
    assert.equal(res4xx.exitCode, 1, `HTTP ${statusCode} exits nonzero`);
    assert.equal(res4xx.requests, 1, `HTTP ${statusCode} must not retry`);
  }

  // Transient 503 retries once and succeeds when the second attempt returns 200.
  {
    const transient503 = await runLauncherAgainstServer("renewal-reminders.js", (_req, res, idx) => {
      if (idx === 1) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "cron_failed" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    assert.equal(transient503.exitCode, 0, "transient 503 recovers cleanly on single retry");
    assert.equal(transient503.requests, 2, "transient 503 makes exactly 2 requests");
  }

  // Persistent 503 retries once (2 requests total) and exits 1.
  {
    const persistent503 = await runLauncherAgainstServer("renewal-reminders.js", (_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "cron_failed" }));
    });
    assert.equal(persistent503.exitCode, 1, "persistent 503 exits nonzero");
    assert.equal(persistent503.requests, 2, "persistent 503 makes exactly 2 requests");
  }

  // ── 5. HERO-127 UTC schedule safety in ecosystem.config.js ─────────────────
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ecosystem = require("../ecosystem.config.js") as {
    apps: Array<{ name: string; cron_restart?: string }>;
  };
  const scheduleByName = new Map(ecosystem.apps.map((app) => [app.name, app.cron_restart]));
  assert.equal(scheduleByName.get("trial-expiry"), "0 1 * * *", "trial-expiry runs 08:00 BKK (01:00 UTC)");
  assert.equal(
    scheduleByName.get("renewal-reminders"),
    "15 2 * * *",
    "renewal-reminders runs 09:15 BKK (02:15 UTC), staggered after 02:00 UTC db-backup",
  );
  assert.equal(
    scheduleByName.get("trial-reminders"),
    "15 3 * * *",
    "trial-reminders runs 10:15 BKK (03:15 UTC), staggered after 03:00 UTC cleanup-videos",
  );
  assert.notEqual(
    scheduleByName.get("renewal-reminders"),
    scheduleByName.get("db-backup"),
    "renewal-reminders must not collide with db-backup",
  );
  assert.notEqual(
    scheduleByName.get("trial-reminders"),
    scheduleByName.get("cleanup-videos"),
    "trial-reminders must not collide with cleanup-videos",
  );

  console.log("verify-cron-route: ok (auth, 503, single-flight 409, all 9 launchers timeout/4xx/503, UTC schedules)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
