// Verify the tts-gemini Gemini-TTS call honors its 600s undici dispatcher.
//
// Bug: the route set `new Agent({ headersTimeout: 600_000 })` but handed it to Node's
// BUILT-IN global fetch — a node_modules Agent is NOT reliably honored there, so it fell back
// to undici's ~300s default and long (5-6 min) TTS calls died with HeadersTimeoutError.
// Fix: call undici's OWN fetch (same module as Agent) so the dispatcher actually takes effect.
//
// Run: npx tsx scripts/verify-tts-gemini-dispatcher.ts
import { readFileSync } from "fs";
import http from "http";
import { Agent, fetch as undiciFetch } from "undici";

async function main() {
  let failures = 0;
  const check = (n: string, c: boolean, d = "") => {
    console.log(`${c ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`);
    if (!c) failures++;
  };

  // ── 1. structural: the route must use undici's fetch, not global fetch, for the Gemini call ──
  const src = readFileSync("src/app/api/videos/tts-gemini/route.ts", "utf8");
  check("imports `fetch as undiciFetch` from undici", /import\s*\{[^}]*\bfetch as undiciFetch\b[^}]*\}\s*from\s*["']undici["']/.test(src));
  check("Gemini call uses undiciFetch(", /await undiciFetch\(/.test(src));
  check("no bare global fetch(url ...) for the Gemini call", !/await fetch\(url/.test(src));

  // ── 2. runtime: undici fetch + same-module Agent honors the dispatcher both ways ──
  // NOTE: undici checks timeouts on a coarse (~1s) timer wheel, so a sub-second headersTimeout
  // fires at the next tick (~1s), not on the exact ms. We only need to prove the dispatcher's
  // timeout takes effect at all (vs falling back to undici's ~300s default).
  const SERVER_MS = 2500;
  const srv = http.createServer((_req, res) => { setTimeout(() => { try { res.end('{"ok":true}'); } catch { /* client gone */ } }, SERVER_MS); });
  await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as { port: number }).port;

  // long timeout (> server delay) → waits for the slow response → success (this is what 600s buys us)
  const okRes = await undiciFetch(`http://127.0.0.1:${port}/`, { dispatcher: new Agent({ headersTimeout: 6000, bodyTimeout: 6000 }) });
  check("undici fetch + long dispatcher → waits for slow response (success)", ((await okRes.json()) as { ok: boolean }).ok === true);

  // short timeout (< server delay) → honored → throws BEFORE the slow server responds.
  // If the dispatcher were ignored (undici's ~300s default), it would instead succeed at SERVER_MS.
  let threw = false; let ms = 0; const t0 = Date.now();
  try {
    await undiciFetch(`http://127.0.0.1:${port}/`, { dispatcher: new Agent({ headersTimeout: 800, bodyTimeout: 800 }) });
  } catch { ms = Date.now() - t0; threw = true; }
  check("undici fetch + short dispatcher → honored (throws before slow server, not 300s default)", threw && ms < SERVER_MS - 200, `${ms}ms < ${SERVER_MS}ms`);

  srv.close();
  console.log(failures === 0 ? "\n✅ ALL TTS-GEMINI DISPATCHER CHECKS PASSED" : `\n❌ ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
