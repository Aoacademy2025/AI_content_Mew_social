// Proof of the HeyGen poll mapping contract (PR-1, the "kapokja hole").
// Pure logic — no DB. Run: npx tsx scripts/verify-heygen-poll-map.ts
import { mapHeygenPollResponse } from "../src/lib/heygen-poll";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

// 401 → terminal invalid_key (old route returned 200 'unknown' and the client spun 30 min)
const k = mapHeygenPollResponse({ httpStatus: 401, body: { code: 400112, message: "Unauthorized" } });
assert(k.status === "failed" && k.error?.code === "invalid_key", "401 → failed/invalid_key");
assert(k.error!.userAction === "แก้ HeyGen API key ใน Settings", "invalid_key carries the Settings userAction");

// HeyGen application code 400112 even with HTTP 200 → invalid_key
const k2 = mapHeygenPollResponse({ httpStatus: 200, body: { code: 400112, message: "Unauthorized" } });
assert(k2.status === "failed" && k2.error?.code === "invalid_key", "200 + body code 400112 → failed/invalid_key");

// 404 → terminal not_found
const nf = mapHeygenPollResponse({ httpStatus: 404, body: null });
assert(nf.status === "failed" && nf.error?.code === "not_found", "404 → failed/not_found");

// 402 → terminal insufficient_credit
const credit = mapHeygenPollResponse({ httpStatus: 402, body: null });
assert(credit.status === "failed" && credit.error?.code === "insufficient_credit", "402 → failed/insufficient_credit");

// 429 → keep polling, honor Retry-After
const rl = mapHeygenPollResponse({ httpStatus: 429, body: null, retryAfterHeader: "12" });
assert(rl.status === "pending" && rl.retryAfterSec === 12, "429 → pending with Retry-After honored");
const rl2 = mapHeygenPollResponse({ httpStatus: 429, body: null, retryAfterHeader: null });
assert(rl2.status === "pending" && rl2.retryAfterSec === 30, "429 without header → pending, default 30s");

// 5xx and network timeout → pending (polling continues)
assert(mapHeygenPollResponse({ httpStatus: 503, body: null }).status === "pending", "503 → pending");
assert(mapHeygenPollResponse({ httpStatus: 0, body: null }).status === "pending", "network timeout (httpStatus 0) → pending");

// any other 4xx → terminal provider_failed (must NOT spin forever)
const bad = mapHeygenPollResponse({ httpStatus: 400, body: { code: 40001, message: "Bad request" } });
assert(bad.status === "failed" && bad.error?.code === "provider_failed", "unknown 4xx → failed/provider_failed");

// healthy passthrough
const ok = mapHeygenPollResponse({ httpStatus: 200, body: { code: 100, data: { status: "processing" } } });
assert(ok.status === "processing" && !ok.error, "200 processing → passthrough, no error");
const done = mapHeygenPollResponse({ httpStatus: 200, body: { code: 100, data: { status: "completed", video_url: "https://x/y.mp4" } } });
assert(done.status === "completed" && done.videoUrl === "https://x/y.mp4", "200 completed → videoUrl passthrough");

// HeyGen-reported failure with a structured error object in data.error
const hf = mapHeygenPollResponse({ httpStatus: 200, body: { code: 100, data: { status: "failed", error: { code: 40119, message: "Avatar not allowed" } } } });
assert(hf.status === "failed" && hf.error?.code === "provider_failed" && (hf.errorMsg ?? "").includes("Avatar not allowed"), "200 status=failed → failed with HeyGen detail");

// 200 with unparseable body (e.g. nginx HTML page) → pending, NOT failed
assert(mapHeygenPollResponse({ httpStatus: 200, body: null }).status === "pending", "200 + non-JSON body → pending");

console.log(`\n✅ ALL ${passed} HEYGEN POLL MAP CHECKS PASSED`);
