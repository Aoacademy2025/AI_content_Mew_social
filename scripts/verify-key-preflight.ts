/**
 * Verify @/lib/key-preflight (Task 7, 2026-07-16 stability audit).
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
} from "../src/lib/key-preflight";

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

function mockFetch(impl: FetchImpl) {
  (global as unknown as { fetch: FetchImpl }).fetch = impl;
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
  console.log("ElevenLabs key checks");
  await check("valid key (200 on /v1/user) -> valid", async () => {
    mockFetch(async () => jsonResponse(200, { subscription: {} }));
    const r = await testElevenLabsKey("k");
    assert.equal(r.verdict, "valid");
    assert.equal(r.ok, true);
  });

  await check("scoped TTS-only key (401 + missing_permissions body) -> valid, NOT invalid", async () => {
    mockFetch(async () => jsonResponse(401, { detail: { status: "missing_permissions", message: "..." } }));
    const r = await testElevenLabsKey("k");
    assert.equal(r.verdict, "valid");
  });

  await check("truly bad key (401 on /v1/user, then 401 confirmed on real TTS call) -> invalid", async () => {
    let call = 0;
    mockFetch(async () => {
      call++;
      if (call === 1) return jsonResponse(401, { detail: { type: "authentication_error", message: "invalid_api_key" } });
      return jsonResponse(401, { detail: { message: "invalid_api_key" } });
    });
    const r = await testElevenLabsKey("k");
    assert.equal(r.verdict, "invalid");
  });

  await check("ambiguous 401 but TTS call itself succeeds -> valid (fail-open toward usable)", async () => {
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
    const r = await testElevenLabsKey("k", 10);
    assert.equal(r.verdict, "unknown");
  });

  await check("unexpected 5xx -> unknown, NOT invalid (fail-open)", async () => {
    mockFetch(async () => jsonResponse(503, {}));
    const r = await testElevenLabsKey("k");
    assert.equal(r.verdict, "unknown");
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
  await check("preflightElevenLabs blocks only on invalid verdict", async () => {
    mockFetch(async () => jsonResponse(401, { detail: { message: "invalid_api_key" } }));
    let block = await preflightElevenLabs("k");
    assert.ok(block, "expected a block for a confirmed-bad key");
    assert.equal(block!.key, "elevenlabs");
    assert.match(block!.message, /Settings/);

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

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
