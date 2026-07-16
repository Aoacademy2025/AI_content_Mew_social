/**
 * Verify @/lib/key-preflight (Task 7, 2026-07-16 stability audit + 2026-07-17 review
 * round fixes).
 * Run: npx tsx scripts/verify-key-preflight.ts
 *
 * Mocks global.fetch — no real network calls, no DB needed.
 */
import assert from "node:assert/strict";
import {
  testElevenLabsKey,
  testPexelsKey,
  preflightElevenLabs,
  preflightPexels,
  pexelsStockMayBeUsed,
} from "../src/lib/key-preflight";

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

let fetchCallCount = 0;
function mockFetch(impl: FetchImpl) {
  fetchCallCount = 0;
  (global as unknown as { fetch: FetchImpl }).fetch = async (url, init) => {
    fetchCallCount++;
    return impl(url, init);
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    console.error(`  FAIL - ${name}`);
    throw e;
  }
}

async function main() {
  console.log("ElevenLabs key checks (Settings mode — disambiguate defaults to true)");
  await check("valid key (200 on /v1/user) -> valid", async () => {
    mockFetch(async () => jsonResponse(200, { subscription: {} }));
    const r = await testElevenLabsKey("k");
    assert.equal(r.verdict, "valid");
    assert.equal(r.ok, true);
  });

  await check("scoped TTS-only key (401 + missing_permissions body) -> valid, NOT invalid", async () => {
    mockFetch(async () => jsonResponse(401, { detail: { status: "missing_permissions", message: "missing the permission user_read" } }));
    const r = await testElevenLabsKey("k");
    assert.equal(r.verdict, "valid");
  });

  await check("definitive bad key (401 invalid_api_key body) -> invalid WITHOUT the TTS call (1 fetch)", async () => {
    mockFetch(async () => jsonResponse(401, { detail: { status: "invalid_api_key", message: "Invalid API key" } }));
    const r = await testElevenLabsKey("k");
    assert.equal(r.verdict, "invalid");
    assert.equal(fetchCallCount, 1, "invalid_api_key is a free, definitive signal — must not fire the paid TTS call");
  });

  await check("ambiguous 401 (Settings mode, disambiguate:true) -> escalates to the real TTS call", async () => {
    let call = 0;
    mockFetch(async () => {
      call++;
      if (call === 1) return jsonResponse(401, { detail: { message: "some_other_401" } });
      return jsonResponse(401, { detail: { message: "invalid_api_key" } });
    });
    const r = await testElevenLabsKey("k");
    assert.equal(r.verdict, "invalid");
    assert.equal(fetchCallCount, 2, "Settings mode must disambiguate via the real TTS call");
  });

  await check("ambiguous 401 but the TTS call itself succeeds -> valid (Settings mode)", async () => {
    let call = 0;
    mockFetch(async () => {
      call++;
      if (call === 1) return jsonResponse(401, { detail: { message: "some_other_401" } });
      return jsonResponse(200, {});
    });
    const r = await testElevenLabsKey("k");
    assert.equal(r.verdict, "valid");
  });

  await check("network error -> unknown (fail-open)", async () => {
    mockFetch(async () => { throw new Error("ECONNRESET"); });
    const r = await testElevenLabsKey("k");
    assert.equal(r.verdict, "unknown");
  });

  await check("timeout (AbortError) -> unknown (fail-open)", async () => {
    mockFetch(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    });
    const r = await testElevenLabsKey("k", { timeoutMs: 10 });
    assert.equal(r.verdict, "unknown");
  });

  await check("unexpected 5xx -> unknown, NOT invalid (fail-open)", async () => {
    mockFetch(async () => jsonResponse(503, {}));
    const r = await testElevenLabsKey("k");
    assert.equal(r.verdict, "unknown");
  });

  console.log("ElevenLabs key checks (preflight mode — disambiguate:false, review round 2026-07-17)");
  await check("definitive bad key (401 invalid_api_key) -> STILL invalid, 1 fetch (no TTS call needed)", async () => {
    mockFetch(async () => jsonResponse(401, { detail: { status: "invalid_api_key", message: "Invalid API key" } }));
    const r = await testElevenLabsKey("k", { disambiguate: false });
    assert.equal(r.verdict, "invalid");
    assert.equal(fetchCallCount, 1);
  });

  await check("scoped TTS-only key (missing_permissions) -> still valid, 1 fetch", async () => {
    mockFetch(async () => jsonResponse(401, { detail: { status: "missing_permissions", message: "missing the permission user_read" } }));
    const r = await testElevenLabsKey("k", { disambiguate: false });
    assert.equal(r.verdict, "valid");
    assert.equal(fetchCallCount, 1);
  });

  await check("ambiguous 401 -> unknown (fail-open), NEVER fires the paid TTS call", async () => {
    mockFetch(async () => jsonResponse(401, { detail: { message: "some_other_401_reason" } }));
    const r = await testElevenLabsKey("k", { disambiguate: false });
    assert.equal(r.verdict, "unknown");
    assert.equal(fetchCallCount, 1, "preflight must make exactly ONE fetch call — no TTS-generation disambiguation");
  });

  console.log("Pexels key checks");
  await check("valid key (200) -> valid", async () => {
    mockFetch(async () => jsonResponse(200, { videos: [] }));
    const r = await testPexelsKey("k");
    assert.equal(r.verdict, "valid");
  });

  await check("invalid key (401) -> invalid", async () => {
    mockFetch(async () => jsonResponse(401, { status: 401, code: "Unauthorized", message: "Invalid API key" }));
    const r = await testPexelsKey("k");
    assert.equal(r.verdict, "invalid");
  });

  await check("403 -> invalid", async () => {
    mockFetch(async () => jsonResponse(403, {}));
    const r = await testPexelsKey("k");
    assert.equal(r.verdict, "invalid");
  });

  await check("429 rate limit -> unknown, NOT invalid (fail-open)", async () => {
    mockFetch(async () => jsonResponse(429, {}));
    const r = await testPexelsKey("k");
    assert.equal(r.verdict, "unknown");
  });

  await check("network error -> unknown (fail-open)", async () => {
    mockFetch(async () => { throw new TypeError("fetch failed"); });
    const r = await testPexelsKey("k");
    assert.equal(r.verdict, "unknown");
  });

  console.log("preflightElevenLabs / preflightPexels (job-submit gate)");
  await check("preflightElevenLabs blocks only on invalid verdict, never calls TTS", async () => {
    mockFetch(async () => jsonResponse(401, { detail: { status: "invalid_api_key", message: "Invalid API key" } }));
    let block = await preflightElevenLabs("k");
    assert.ok(block, "expected a block for a confirmed-bad key");
    assert.equal(block!.key, "elevenlabs");
    assert.match(block!.message, /Settings/);
    assert.equal(fetchCallCount, 1, "preflightElevenLabs must never fire the paid TTS call");

    mockFetch(async () => jsonResponse(401, { detail: { message: "ambiguous_reason" } }));
    block = await preflightElevenLabs("k");
    assert.equal(block, null, "ambiguous 401 must fail-open (no block) in preflight mode");
    assert.equal(fetchCallCount, 1, "still exactly one fetch — no TTS disambiguation call");

    mockFetch(async () => { throw new Error("network down"); });
    block = await preflightElevenLabs("k");
    assert.equal(block, null, "network error must fail-open (no block)");
  });

  await check("preflightPexels blocks only on invalid verdict", async () => {
    mockFetch(async () => jsonResponse(401, {}));
    let block = await preflightPexels("k");
    assert.ok(block, "expected a block for a confirmed-bad key");
    assert.equal(block!.key, "pexels");

    mockFetch(async () => jsonResponse(500, {}));
    block = await preflightPexels("k");
    assert.equal(block, null, "5xx must fail-open (no block)");
  });

  console.log("pexelsStockMayBeUsed (review round 2026-07-17 — gate Pexels preflight on resolved stockSource)");
  await check("default/undefined stockSource -> may be used", async () => {
    assert.equal(pexelsStockMayBeUsed({}), true);
    assert.equal(pexelsStockMayBeUsed({ stockSource: "stock" }), true);
  });

  await check("kie-image stockSource -> never uses Pexels/Pixabay", async () => {
    assert.equal(pexelsStockMayBeUsed({ stockSource: "kie-image" }), false);
    assert.equal(pexelsStockMayBeUsed({ stockSource: "kie-image", autoMixProviders: ["video"] }), false);
  });

  await check("auto-mix with no autoMixProviders list (default = everything on) -> may be used", async () => {
    assert.equal(pexelsStockMayBeUsed({ stockSource: "auto-mix" }), true);
  });

  await check("auto-mix WITH 'video' in autoMixProviders -> may be used", async () => {
    assert.equal(pexelsStockMayBeUsed({ stockSource: "auto-mix", autoMixProviders: ["video", "pexels-photo"] }), true);
  });

  await check("auto-mix WITHOUT 'video' in autoMixProviders -> must NOT be used (the exact bug this fixes)", async () => {
    assert.equal(pexelsStockMayBeUsed({ stockSource: "auto-mix", autoMixProviders: ["kie-ai", "unsplash"] }), false);
  });

  await check("auto-mix with an EMPTY autoMixProviders list -> must NOT be used (matches fetch-stock's own semantics)", async () => {
    assert.equal(pexelsStockMayBeUsed({ stockSource: "auto-mix", autoMixProviders: [] }), false);
  });

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
