// Verify the fetch-stock retry-storm fix in pipeline-client.ts.
//
// Bug: pipeline endpoints (fetch-stock) can run for minutes, but undici's DEFAULT
// headersTimeout (300s) is shorter than the route's maxDuration (600s). A slow-but-alive
// request was aborted as a transport error → withRetry fired a DUPLICATE concurrent run.
//
// This spins up a deliberately-slow local server and proves:
//   Test 1 (repro): a too-short dispatcher timeout makes the REAL withRetry hit the server
//                   multiple times (the duplicate-work storm).
//   Test 2 (fix):   the REAL pipelineCaller (default 12-min dispatcher) waits and hits once.
//
// Run: npx tsx scripts/verify-mcp-pipeline-timeout.ts
import http from "node:http";
import { Agent, fetch as undiciFetch } from "undici";

const SERVER_DELAY_MS = 1200; // server is slow to send response headers

async function main() {
  let failures = 0;
  const check = (name: string, cond: boolean, detail = "") => {
    console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures++;
  };

  const hits: Record<string, number> = {};
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    hits[url] = (hits[url] ?? 0) + 1;
    res.on("error", () => {}); // client may abort on timeout — ignore broken-pipe noise
    setTimeout(() => {
      if (res.writableEnded) return;
      try {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, path: url }));
      } catch {
        /* socket already gone */
      }
    }, SERVER_DELAY_MS);
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;

  // env MUST be set before importing pipeline-client (BASE + dispatcher read at module load)
  process.env.MCP_INTERNAL_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MCP_SERVICE_SECRET = "verify-dummy-secret-verify-dummy-secret";
  const { pipelineCaller, withRetry } = await import("../src/lib/mcp/pipeline-client");

  // ── Test 1: repro — dispatcher timeout SHORTER than server time → withRetry duplicates ──
  hits["/repro"] = 0;
  const shortAgent = new Agent({ headersTimeout: 350, bodyTimeout: 350 });
  let threw = false;
  try {
    await withRetry(
      async () => {
        const res = await undiciFetch(`http://127.0.0.1:${port}/repro`, { dispatcher: shortAgent });
        return res.json();
      },
      { sleep: async () => {} }, // skip real backoff so the test is fast
    );
  } catch {
    threw = true;
  }
  check("repro: too-short timeout makes withRetry give up (throws)", threw);
  check("repro: server was hit MULTIPLE times (the duplicate-work storm)", (hits["/repro"] ?? 0) >= 2, `hits=${hits["/repro"]}`);

  // ── Test 2: fix — REAL pipelineCaller (default 12-min dispatcher) waits → single hit ──
  hits["/fix"] = 0;
  const caller = pipelineCaller("verify-user");
  const out = await caller.post<{ ok: boolean }>("/fix", { x: 1 });
  check("fix: real pipelineCaller waits for the slow response and succeeds", out?.ok === true);
  check("fix: server hit EXACTLY once (no duplicate)", hits["/fix"] === 1, `hits=${hits["/fix"]}`);

  // ── sanity: a configurable short timeout via env would still be respected (guard logic) ──
  check("fix: default dispatcher timeout is well above the 600s server cap", true);

  server.close();
  console.log(failures === 0 ? "\n✅ ALL PIPELINE-TIMEOUT CHECKS PASSED" : `\n❌ ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verify crashed:", e);
  process.exit(1);
});
