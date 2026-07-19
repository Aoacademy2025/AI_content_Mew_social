/**
 * Verify @/lib/key-preflight (Task 7, 2026-07-16 stability audit + two 2026-07-17
 * review rounds — 2nd round restores the TTS disambiguation probe in preflight mode
 * for ambiguous 401s, since it's the only way to catch a scoped key missing
 * text_to_speech, and the probe only ever costs the user anything when it succeeds).
 * Run: npx tsx scripts/verify-key-preflight.ts
 *
 * Mocks global.fetch — no real network calls, no DB needed.
 */
import assert from "node:assert/strict";
import {
  testElevenLabsKey,
  testPexelsKey,
  testPixabayKey,
  preflightElevenLabs,
  preflightPexels,
  preflightStockProviders,
  stockVideoProvidersMayBeUsed,
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
  console.log("ElevenLabs key checks (Settings mode — default, mode not passed)");
  await check("valid key (200 on /v1/user) -> valid, 1 fetch", async () => {
    mockFetch(async () => jsonResponse(200, { subscription: {} }));
    const r = await testElevenLabsKey("k");
    assert.equal(r.verdict, "valid");
    assert.equal(r.ok, true);
    assert.equal(fetchCallCount, 1);
  });

  await check("scoped TTS-only key (401 + missing_permissions body) -> valid, NO probe (1 fetch) — historical shortcut unchanged", async () => {
    mockFetch(async () => jsonResponse(401, { detail: { status: "missing_permissions", message: "missing the permission user_read" } }));
    const r = await testElevenLabsKey("k");
    assert.equal(r.verdict, "valid");
    assert.equal(fetchCallCount, 1, "Settings mode trusts missing_permissions without probing");
  });

  await check("definitive bad key (401 invalid_api_key body) -> invalid WITHOUT the TTS call (1 fetch)", async () => {
    mockFetch(async () => jsonResponse(401, { detail: { status: "invalid_api_key", message: "Invalid API key" } }));
    const r = await testElevenLabsKey("k");
    assert.equal(r.verdict, "invalid");
    assert.equal(fetchCallCount, 1, "invalid_api_key is a free, definitive signal — must not fire the paid TTS call");
  });

  await check("ambiguous 401 (not missing_permissions) -> escalates to the real TTS call, probe-401 -> invalid (2 fetches)", async () => {
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

  await check("ambiguous 401 but the TTS call itself succeeds -> valid (2 fetches)", async () => {
    let call = 0;
    mockFetch(async () => {
      call++;
      if (call === 1) return jsonResponse(401, { detail: { message: "some_other_401" } });
      return jsonResponse(200, {});
    });
    const r = await testElevenLabsKey("k");
    assert.equal(r.verdict, "valid");
    assert.equal(fetchCallCount, 2);
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

  console.log("ElevenLabs key checks (preflight mode — mode:'preflight', 2nd review round 2026-07-17)");
  await check("working key (200 on /v1/user) -> valid, exactly 1 fetch (no probe needed)", async () => {
    mockFetch(async () => jsonResponse(200, { subscription: {} }));
    const r = await testElevenLabsKey("k", { mode: "preflight" });
    assert.equal(r.verdict, "valid");
    assert.equal(fetchCallCount, 1);
  });

  await check("definitive bad key (401 invalid_api_key) -> invalid, 1 fetch (free gate, no probe needed)", async () => {
    mockFetch(async () => jsonResponse(401, { detail: { status: "invalid_api_key", message: "Invalid API key" } }));
    const r = await testElevenLabsKey("k", { mode: "preflight" });
    assert.equal(r.verdict, "invalid");
    assert.equal(fetchCallCount, 1);
  });

  await check("scoped key (missing_permissions) + probe-401 -> BLOCK (invalid), 2 fetches — the exact real-world failure class", async () => {
    let call = 0;
    mockFetch(async () => {
      call++;
      if (call === 1) return jsonResponse(401, { detail: { status: "missing_permissions", message: "missing the permission user_read" } });
      return jsonResponse(401, { detail: { type: "authentication_error", code: "unauthorized", message: "missing the permission text_to_speech" } });
    });
    const r = await testElevenLabsKey("k", { mode: "preflight" });
    assert.equal(r.verdict, "invalid");
    assert.equal(fetchCallCount, 2, "preflight must probe missing_permissions (unlike Settings) — this is the case Settings alone would miss");
    assert.match(r.message, /text_to_speech/);
  });

  await check("scoped key (missing_permissions) + probe-200 -> PASS (valid), 2 fetches", async () => {
    let call = 0;
    mockFetch(async () => {
      call++;
      if (call === 1) return jsonResponse(401, { detail: { status: "missing_permissions", message: "missing the permission user_read" } });
      return jsonResponse(200, {});
    });
    const r = await testElevenLabsKey("k", { mode: "preflight" });
    assert.equal(r.verdict, "valid");
    assert.equal(fetchCallCount, 2);
  });

  await check("ambiguous 401 (other) + probe-401 -> BLOCK (invalid), 2 fetches", async () => {
    let call = 0;
    mockFetch(async () => {
      call++;
      if (call === 1) return jsonResponse(401, { detail: { message: "some_other_401_reason" } });
      return jsonResponse(403, { detail: { message: "forbidden" } });
    });
    const r = await testElevenLabsKey("k", { mode: "preflight" });
    assert.equal(r.verdict, "invalid");
    assert.equal(fetchCallCount, 2);
  });

  await check("ambiguous 401 (other) + probe-200 -> PASS (valid), 2 fetches", async () => {
    let call = 0;
    mockFetch(async () => {
      call++;
      if (call === 1) return jsonResponse(401, { detail: { message: "some_other_401_reason" } });
      return jsonResponse(200, {});
    });
    const r = await testElevenLabsKey("k", { mode: "preflight" });
    assert.equal(r.verdict, "valid");
    assert.equal(fetchCallCount, 2);
  });

  await check("probe network-error -> PASS (unknown, fail-open), 2 fetch attempts", async () => {
    let call = 0;
    mockFetch(async () => {
      call++;
      if (call === 1) return jsonResponse(401, { detail: { message: "some_other_401_reason" } });
      throw new Error("ECONNRESET during probe");
    });
    const r = await testElevenLabsKey("k", { mode: "preflight" });
    assert.equal(r.verdict, "unknown");
    assert.equal(fetchCallCount, 2);
  });

  await check("probe timeout (AbortError) -> PASS (unknown, fail-open)", async () => {
    let call = 0;
    mockFetch(async () => {
      call++;
      if (call === 1) return jsonResponse(401, { detail: { message: "some_other_401_reason" } });
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    });
    const r = await testElevenLabsKey("k", { mode: "preflight", timeoutMs: 10 });
    assert.equal(r.verdict, "unknown");
  });

  await check("first-call network-error -> PASS (unknown, fail-open), no probe attempted", async () => {
    mockFetch(async () => { throw new Error("ECONNRESET"); });
    const r = await testElevenLabsKey("k", { mode: "preflight" });
    assert.equal(r.verdict, "unknown");
    assert.equal(fetchCallCount, 1);
  });

  console.log("Pexels key checks");
  await check("Pexels probe bypasses shared CDN cache", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    mockFetch(async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return jsonResponse(200, { videos: [] });
    });
    await testPexelsKey("k");
    const probe = new URL(seenUrl);
    assert.ok(probe.searchParams.get("_hero_preflight"), "probe URL must be unique per request");
    assert.equal(seenInit?.cache, "no-store");
  });
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

  console.log("Pixabay key checks");
  await check("valid Pixabay key (200 with hits) -> valid and bypasses cache", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    mockFetch(async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return jsonResponse(200, { hits: [] });
    });
    const r = await testPixabayKey("k");
    assert.equal(r.verdict, "valid");
    const probe = new URL(seenUrl);
    assert.equal(probe.searchParams.get("key"), "k");
    assert.ok(probe.searchParams.get("_hero_preflight"));
    assert.equal(seenInit?.cache, "no-store");
  });

  await check("invalid Pixabay key (400) -> invalid", async () => {
    mockFetch(async () => jsonResponse(400, { error: "Invalid API key" }));
    const r = await testPixabayKey("k");
    assert.equal(r.verdict, "invalid");
  });

  await check("Pixabay 5xx -> unknown (fail-open)", async () => {
    mockFetch(async () => jsonResponse(503, {}));
    const r = await testPixabayKey("k");
    assert.equal(r.verdict, "unknown");
  });

  console.log("preflightElevenLabs / preflightPexels (job-submit gate)");
  await check("preflightElevenLabs: invalid_api_key blocks for free (1 fetch, no probe)", async () => {
    mockFetch(async () => jsonResponse(401, { detail: { status: "invalid_api_key", message: "Invalid API key" } }));
    const block = await preflightElevenLabs("k");
    assert.ok(block, "expected a block for a confirmed-bad key");
    assert.equal(block!.key, "elevenlabs");
    assert.match(block!.message, /Settings/);
    assert.equal(fetchCallCount, 1);
  });

  await check("preflightElevenLabs: missing_permissions + probe-401 blocks (2 fetches) — the real observed failure class", async () => {
    let call = 0;
    mockFetch(async () => {
      call++;
      if (call === 1) return jsonResponse(401, { detail: { status: "missing_permissions", message: "missing the permission user_read" } });
      return jsonResponse(401, { detail: { message: "missing the permission text_to_speech" } });
    });
    const block = await preflightElevenLabs("k");
    assert.ok(block, "expected a block — this is exactly the key class that caused the 10 real ElevenLabs failures");
    assert.match(block!.message, /text_to_speech/);
    assert.equal(fetchCallCount, 2);
  });

  await check("preflightElevenLabs: missing_permissions + probe succeeds -> no block (2 fetches)", async () => {
    let call = 0;
    mockFetch(async () => {
      call++;
      if (call === 1) return jsonResponse(401, { detail: { status: "missing_permissions", message: "missing the permission user_read" } });
      return jsonResponse(200, {});
    });
    const block = await preflightElevenLabs("k");
    assert.equal(block, null, "a working TTS-scoped key must never be blocked");
    assert.equal(fetchCallCount, 2);
  });

  await check("preflightElevenLabs: probe network-error fails open (no block)", async () => {
    let call = 0;
    mockFetch(async () => {
      call++;
      if (call === 1) return jsonResponse(401, { detail: { message: "ambiguous_reason" } });
      throw new Error("probe network error");
    });
    const block = await preflightElevenLabs("k");
    assert.equal(block, null, "probe network error must fail-open (no block)");
  });

  await check("preflightElevenLabs: first-call network error fails open (no block)", async () => {
    mockFetch(async () => { throw new Error("network down"); });
    const block = await preflightElevenLabs("k");
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

  console.log("stock-provider resolution");
  await check("invalid Pexels + valid Pixabay excludes Pexels and continues", async () => {
    mockFetch(async (url) => url.includes("api.pexels.com")
      ? jsonResponse(401, {})
      : jsonResponse(200, { hits: [] }));
    const result = await preflightStockProviders({ pexelsKey: "bad", pixabayKey: "good" });
    assert.equal(result.block, null);
    assert.deepEqual(result.providers, ["pixabay"]);
  });

  await check("both invalid stock keys block before job creation", async () => {
    mockFetch(async (url) => url.includes("api.pexels.com")
      ? jsonResponse(401, {})
      : jsonResponse(400, {}));
    const result = await preflightStockProviders({ pexelsKey: "bad-p", pixabayKey: "bad-x" });
    assert.ok(result.block);
    assert.deepEqual(result.providers, []);
    assert.equal(result.block?.key, "broll");
  });

  await check("provider timeout stays fail-open and remains selectable", async () => {
    mockFetch(async () => { throw new Error("timeout"); });
    const result = await preflightStockProviders({ pexelsKey: "p", pixabayKey: null });
    assert.equal(result.block, null);
    assert.deepEqual(result.providers, ["pexels"]);
  });

  console.log("stockVideoProvidersMayBeUsed (gate stock-video preflight on resolved stockSource)");
  await check("default/undefined stockSource -> may be used", async () => {
    assert.equal(stockVideoProvidersMayBeUsed({}), true);
    assert.equal(stockVideoProvidersMayBeUsed({ stockSource: "stock" }), true);
  });

  await check("kie-image stockSource -> never uses Pexels/Pixabay", async () => {
    assert.equal(stockVideoProvidersMayBeUsed({ stockSource: "kie-image" }), false);
    assert.equal(stockVideoProvidersMayBeUsed({ stockSource: "kie-image", autoMixProviders: ["video"] }), false);
  });

  await check("auto-mix with no autoMixProviders list (default = everything on) -> may be used", async () => {
    assert.equal(stockVideoProvidersMayBeUsed({ stockSource: "auto-mix" }), true);
  });

  await check("auto-mix WITH 'video' in autoMixProviders -> may be used", async () => {
    assert.equal(stockVideoProvidersMayBeUsed({ stockSource: "auto-mix", autoMixProviders: ["video", "pexels-photo"] }), true);
  });

  await check("auto-mix WITHOUT 'video' in autoMixProviders -> must NOT be used (the exact bug this fixes)", async () => {
    assert.equal(stockVideoProvidersMayBeUsed({ stockSource: "auto-mix", autoMixProviders: ["kie-ai", "unsplash"] }), false);
  });

  await check("auto-mix with an EMPTY autoMixProviders list -> must NOT be used (matches fetch-stock's own semantics)", async () => {
    assert.equal(stockVideoProvidersMayBeUsed({ stockSource: "auto-mix", autoMixProviders: [] }), false);
  });

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
