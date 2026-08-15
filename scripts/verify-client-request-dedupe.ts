import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  clearClientJsonCache,
  fetchClientJson,
} from "../src/lib/client-request-cache";

async function main() {
  clearClientJsonCache();
  let calls = 0;
  let now = 1_000;
  const fetcher = async () => {
    calls += 1;
    await Promise.resolve();
    return Response.json({ total: 42 });
  };

  const burst = await Promise.all(Array.from({ length: 12 }, () =>
    fetchClientJson<{ total: number }>("/api/credits/balance", { cache: "no-store" }, {
      fetcher,
      ttlMs: 750,
      now: () => now,
    })));
  assert.equal(calls, 1, "twelve concurrent balance consumers share one network request");
  assert.equal(burst.every((result) => result.ok && result.data?.total === 42), true);

  await fetchClientJson("/api/credits/balance", undefined, { fetcher, ttlMs: 750, now: () => now });
  assert.equal(calls, 1, "a remount burst inside the short TTL uses the settled response");

  now += 751;
  await fetchClientJson("/api/credits/balance", undefined, { fetcher, ttlMs: 750, now: () => now });
  assert.equal(calls, 2, "the cache cannot hide balance updates beyond its TTL");

  clearClientJsonCache();
  let slowCalls = 0;
  let releaseSlow: (() => void) | null = null;
  const slowResponse = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const slowFetcher = async () => {
    slowCalls += 1;
    await slowResponse;
    return Response.json({ total: 9 });
  };
  const firstSlow = fetchClientJson("/api/credits/balance", undefined, {
    fetcher: slowFetcher,
    ttlMs: 750,
    now: () => now,
  });
  now += 10_000;
  const secondSlow = fetchClientJson("/api/credits/balance", undefined, {
    fetcher: slowFetcher,
    ttlMs: 750,
    now: () => now,
  });
  assert.equal(slowCalls, 1, "an in-flight request stays single-flight even beyond the settled TTL");
  releaseSlow?.();
  await Promise.all([firstSlow, secondSlow]);

  clearClientJsonCache();
  let failures = 0;
  const failingFetcher = async () => {
    failures += 1;
    return Response.json({ error: "temporary" }, { status: 503 });
  };
  const firstFailure = await fetchClientJson("/api/videos/usage", undefined, { fetcher: failingFetcher });
  const secondFailure = await fetchClientJson("/api/videos/usage", undefined, { fetcher: failingFetcher });
  assert.equal(firstFailure.ok, false);
  assert.equal(secondFailure.ok, false);
  assert.equal(failures, 2, "failed responses are never cached");

  const quotaSource = readFileSync(join(process.cwd(), "src/components/quota-status.tsx"), "utf8");
  assert.match(quotaSource, /fetchClientJson<QuotaData>\("\/api\/videos\/usage"/);
  assert.match(quotaSource, /fetchClientJson<CreditBalance>\("\/api\/credits\/balance"/);
  assert.doesNotMatch(quotaSource, /fetch\("\/api\/(?:videos\/usage|credits\/balance)"/);

  const projectSource = readFileSync(join(process.cwd(), "src/app/(dashboard)/video-editor/_v2/useV2Project.ts"), "utf8");
  assert.match(projectSource, /fetchClientJson(?:<[^>]+>)?\("\/api\/videos\/usage"/);

  const receiptSource = readFileSync(join(process.cwd(), "src/app/(dashboard)/video-editor/_v2/RenderReceiptDialog.tsx"), "utf8");
  assert.match(receiptSource, /fetchClientJson<CreditBalanceResponse>\("\/api\/credits\/balance"/);

  console.log("client request dedupe verification passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
