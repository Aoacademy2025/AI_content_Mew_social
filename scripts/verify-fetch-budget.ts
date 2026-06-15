/**
 * TDD verify for src/lib/fetch-budget.ts.
 * Run: npx tsx scripts/verify-fetch-budget.ts
 * Must FAIL before src/lib/fetch-budget.ts exists, PASS after (~8s runtime).
 *
 * Local node:http server scripts the failure sequences:
 *   1. hang (per-attempt timeout) → 200      ⇒ retry succeeds
 *   2. 429 + Retry-After: 1 → 200            ⇒ waits ≥ ~1s, succeeds
 *   3. 502 × 3                               ⇒ throws ProviderError 'transient'
 *   4. 401                                   ⇒ immediate 'invalid_key' (heygen), exactly 1 request
 *   5. caller abort propagates immediately   ⇒ AbortError in <500ms, server hits stop growing
 *   6. 401 + returnHttpErrors                ⇒ Response returned, body still readable
 */
import http from "node:http";
import assert from "node:assert/strict";
import { fetchWithBudget, parseRetryAfterMs, backoffDelayMs } from "../src/lib/fetch-budget";
import { isProviderError } from "../src/lib/provider-errors";

const hits: Record<string, number> = {};

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  hits[url] = (hits[url] ?? 0) + 1;
  const n = hits[url];

  if (url === "/timeout-then-ok") {
    if (n === 1) return; // hang forever — client per-attempt timeout must fire
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url === "/429-then-ok") {
    if (n === 1) {
      res.writeHead(429, { "Retry-After": "1" });
      res.end("rate limited");
      return;
    }
    res.writeHead(200);
    res.end("ok");
    return;
  }
  if (url === "/502-always") {
    res.writeHead(502);
    res.end("bad gateway");
    return;
  }
  if (url === "/401" || url === "/401-return") {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  if (url === "/502-abort") {
    res.writeHead(502);
    res.end("bad gateway");
    return;
  }
  res.writeHead(404);
  res.end();
});

async function main() {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  const base = `http://127.0.0.1:${addr.port}`;

  // 0. helpers
  assert.equal(parseRetryAfterMs("2"), 2000);
  const httpDateMs = parseRetryAfterMs(new Date(Date.now() + 5000).toUTCString());
  assert.ok(httpDateMs !== null && httpDateMs > 3000 && httpDateMs <= 5500, `http-date Retry-After parsed: ${httpDateMs}`);
  assert.equal(parseRetryAfterMs("garbage"), null);
  assert.equal(parseRetryAfterMs(null), null);
  const d = backoffDelayMs(2);
  assert.ok(d >= 2000 && d < 2500, `backoff(2) in [2000,2500): ${d}`);

  // 1. per-attempt timeout, then success
  const res1 = await fetchWithBudget(`${base}/timeout-then-ok`, {}, {
    provider: "test", timeoutMs: 500, retries: 2, wallClockMs: 30_000,
  });
  assert.equal(res1.status, 200);
  assert.equal(hits["/timeout-then-ok"], 2, "timeout case: exactly 2 attempts");

  // 2. 429 honors Retry-After: 1
  const t0 = Date.now();
  const res2 = await fetchWithBudget(`${base}/429-then-ok`, {}, {
    provider: "test", timeoutMs: 5_000, retries: 2, wallClockMs: 30_000,
  });
  const elapsed = Date.now() - t0;
  assert.equal(res2.status, 200);
  assert.equal(hits["/429-then-ok"], 2, "429 case: exactly 2 attempts");
  assert.ok(elapsed >= 950, `waited Retry-After (~1s), got ${elapsed}ms`);

  // 3. 502 × 3 → ProviderError 'transient'
  let err3: unknown;
  try {
    await fetchWithBudget(`${base}/502-always`, {}, {
      provider: "test", timeoutMs: 5_000, retries: 2, wallClockMs: 30_000,
    });
  } catch (e) {
    err3 = e;
  }
  if (!isProviderError(err3)) throw new Error("502 case did not throw ProviderError");
  assert.equal(err3.code, "transient");
  assert.equal(err3.status, 502);
  assert.equal(err3.retryable, true);
  assert.equal(hits["/502-always"], 3, "502 case: exactly 3 attempts (1 + 2 retries)");

  // 4. 401 → immediate invalid_key for provider 'heygen' (no retry)
  let err4: unknown;
  try {
    await fetchWithBudget(`${base}/401`, {}, {
      provider: "heygen", timeoutMs: 5_000, retries: 2, wallClockMs: 30_000,
    });
  } catch (e) {
    err4 = e;
  }
  if (!isProviderError(err4)) throw new Error("401 case did not throw ProviderError");
  assert.equal(err4.code, "invalid_key");
  assert.equal(err4.provider, "heygen");
  assert.equal(err4.retryable, false);
  assert.equal(err4.status, 401);
  assert.equal(hits["/401"], 1, "401 case: exactly 1 request (no retry)");

  // 5. caller abort propagates immediately: AbortError in <500ms, server hits stop growing
  {
    const ac = new AbortController();
    // Abort after 100ms — well before the 3-attempt × backoff chain (~1s+) would complete.
    setTimeout(() => ac.abort(), 100);
    const hitsBeforeAbort = hits["/502-abort"] ?? 0;
    const t5 = Date.now();
    let err5: unknown;
    try {
      await fetchWithBudget(`${base}/502-abort`, { signal: ac.signal }, {
        provider: "test", timeoutMs: 5_000, retries: 3, wallClockMs: 30_000,
      });
    } catch (e) {
      err5 = e;
    }
    const elapsed5 = Date.now() - t5;
    if (!(err5 instanceof Error)) throw new Error("caller-abort case did not throw");
    assert.equal(err5.name, "AbortError", `expected AbortError, got ${err5.name}: ${err5.message}`);
    assert.ok(isProviderError(err5) === false, "AbortError must NOT be wrapped as ProviderError");
    assert.ok(elapsed5 < 500, `caller abort must propagate in <500ms, got ${elapsed5}ms`);
    const hitsAfterAbort = hits["/502-abort"] ?? 0;
    assert.ok(hitsAfterAbort - hitsBeforeAbort <= 1, `server hits must not grow after abort (grew by ${hitsAfterAbort - hitsBeforeAbort})`);
    console.log(`  check (5) caller-abort: AbortError in ${elapsed5}ms, server hits delta=${hitsAfterAbort - hitsBeforeAbort} — PASS`);
  }

  // 6. returnHttpErrors: caller keeps its own res.status mapping; body stays readable
  const res6 = await fetchWithBudget(`${base}/401-return`, {}, {
    provider: "heygen", timeoutMs: 5_000, retries: 1, wallClockMs: 30_000, returnHttpErrors: true,
  });
  assert.equal(res6.status, 401);
  const body6 = await res6.json();
  assert.equal(body6.error, "unauthorized");
  assert.equal(hits["/401-return"], 1);

  console.log("verify-fetch-budget: ALL PASS (6 checks)");
}

main()
  .then(() => {
    server.closeAllConnections?.();
    server.close();
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    server.closeAllConnections?.();
    server.close();
    process.exit(1);
  });
