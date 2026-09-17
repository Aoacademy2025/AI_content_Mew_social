import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runAuthorizedCronJob } from "../src/lib/cron-route";

function socketTimeout(): Error {
  return Object.assign(
    new Error("Socket timeout (the database failed to respond to a query within the configured timeout)"),
    { name: "PrismaClientKnownRequestError", code: "P1008" },
  );
}

function launcher(name: string): string {
  return readFileSync(join(process.cwd(), "scripts", name), "utf8");
}

async function main() {
  const secret = "cron-secret-for-verify";

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

  for (const file of ["trial-expiry.js", "north-star-snapshot.js"]) {
    const source = launcher(file);
    assert.match(source, /timeout:\s*90000/, `${file} waits longer than the 30s Prisma lock`);
    assert.match(source, /attempt\(1\)/, `${file} retries once, not three times`);
    assert.doesNotMatch(source, /attempt\(3\)/, `${file} must not keep the four-shot retry storm`);
    assert.match(
      source,
      /statusCode\s*>=\s*200[\s\S]*statusCode\s*<\s*300/,
      `${file} exits nonzero on 503 so a lock miss is not recorded as success`,
    );
  }

  console.log("verify-cron-route: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
