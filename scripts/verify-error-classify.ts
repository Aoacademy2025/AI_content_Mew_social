// Run with: npx tsx scripts/verify-error-classify.ts
// Proves failed-job classification separates OUR plan caps (quota) from customer-key (byok) and
// real system bugs — and that under managed Gemini a 429 is OUR key (system), not a customer key.
// Order under test: noise → quota → managed-rate-limit → byok → system.
import { classifyJobError, quotaReasonFromText } from "../src/app/api/admin/insights/route";

let passed = 0;
function assert(c: boolean, m: string) {
  if (!c) { console.error("❌ FAIL " + m); process.exit(1); }
  console.log("✓ PASS " + m);
  passed++;
}

// The real 409 body shape thrown by our minute cap (src/app/api/videos/tts-gemini/route.ts).
const QUOTA_MINUTES_409 = JSON.stringify({ code: "QUOTA_MINUTES", message: "เกินโควต้านาทีของแผน PRO" });
const QUOTA_CLIPS_409 = JSON.stringify({ code: "QUOTA_CLIPS", message: "เกินโควต้าคลิป" });

// Plan cap = quota, regardless of managed flag (checked before byok AND before the managed rule).
assert(classifyJobError(QUOTA_MINUTES_409, false) === "quota", "QUOTA_MINUTES 409 body → quota (managed=false)");
assert(classifyJobError(QUOTA_MINUTES_409, true) === "quota", "QUOTA_MINUTES 409 body → quota (managed=true)");
assert(classifyJobError(QUOTA_CLIPS_409, false) === "quota", "QUOTA_CLIPS 409 body → quota");
assert(classifyJobError("เกินโควต้านาที", false) === "quota", "Thai minute-cap message → quota");

// A plan cap must NEVER read as a customer-key (byok) error.
assert(classifyJobError(QUOTA_MINUTES_409, false) !== "byok", "QUOTA_MINUTES is NOT byok");

// Customer key faults = byok.
assert(classifyJobError("Gemini error: API_KEY_INVALID", false) === "byok", "API_KEY_INVALID → byok");
assert(classifyJobError("api key not valid. Please pass a valid API key.", false) === "byok", "invalid api key text → byok");
assert(classifyJobError("This account needs billing enabled (ผูกบัตร)", false) === "byok", "billing/ผูกบัตร → byok");

// 429 / rate limit: OUR managed key when managed=on (system), the customer's key when off (byok).
assert(classifyJobError("Error 429: too many requests", true) === "system", "429 + managed=true → system (our key)");
assert(classifyJobError("Error 429: too many requests", false) === "byok", "429 + managed=false → byok (customer key)");
assert(classifyJobError("RESOURCE_EXHAUSTED", true) === "system", "RESOURCE_EXHAUSTED + managed=true → system");
assert(classifyJobError("RESOURCE_EXHAUSTED", false) === "byok", "RESOURCE_EXHAUSTED + managed=false → byok");

// byokReasonFromText also treats 503 and "too many requests" as rate-limit — the managed branch
// must match the SAME set, so a managed-key 503/"too many requests" never falls through to byok.
assert(classifyJobError("Error 503: Service Unavailable", true) === "system", "503 + managed=true → system (our key)");
assert(classifyJobError("Error 503: Service Unavailable", false) === "byok", "503 + managed=false → byok (customer key)");
assert(classifyJobError("too many requests, please retry", true) === "system", "too many requests + managed=true → system (our key)");
assert(classifyJobError("too many requests, please retry", false) === "byok", "too many requests + managed=false → byok (customer key)");

// Noise (superseded / cancel) wins over everything.
assert(classifyJobError("__SUPERSEDED__", false) === "noise", "__SUPERSEDED__ → noise");
assert(classifyJobError("job was cancelled by user", false) === "noise", "cancelled → noise");
assert(classifyJobError("AbortError: The operation was aborted", true) === "noise", "AbortError → noise (even managed)");

// Real system bugs → system (default bucket).
assert(classifyJobError("TypeError: cannot read property 'x' of undefined", true) === "system", "plain render crash → system");
assert(classifyJobError("ffmpeg exited with code 1", false) === "system", "ffmpeg crash → system");
assert(classifyJobError(null, false) === "system", "null message → system (no evidence of quota/byok)");
assert(classifyJobError("", true) === "system", "empty message → system");

// quotaReasonFromText direct checks: matches our codes, ignores a bare 429.
assert(quotaReasonFromText("QUOTA_MINUTES") !== null, "quotaReasonFromText matches QUOTA_MINUTES");
assert(quotaReasonFromText("Error 429 rate limit") === null, "quotaReasonFromText does NOT match a bare 429 (that's byok/rate-limit)");

console.log(`\n${passed} checks passed`);
