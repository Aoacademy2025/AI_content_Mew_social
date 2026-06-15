/**
 * TDD verify for src/lib/provider-errors.ts (design doc §8 taxonomy).
 * Run: npx tsx scripts/verify-provider-errors.ts
 * Must FAIL before src/lib/provider-errors.ts exists, PASS after.
 */
import assert from "node:assert/strict";
import {
  providerError,
  isProviderError,
  isRetryable,
  toUserMessage,
  classifyHttpStatus,
  httpStatusForCode,
  toErrorResponse,
  type ProviderErrorCode,
} from "../src/lib/provider-errors";

// ── classification of upstream HTTP statuses ──
assert.equal(classifyHttpStatus(401), "invalid_key");
assert.equal(classifyHttpStatus(402), "quota");
assert.equal(classifyHttpStatus(403), "quota");
assert.equal(classifyHttpStatus(429), "rate_limit");
assert.equal(classifyHttpStatus(500), "transient");
assert.equal(classifyHttpStatus(502), "transient");
assert.equal(classifyHttpStatus(503), "transient");
assert.equal(classifyHttpStatus(400), "fatal");
assert.equal(classifyHttpStatus(404), "fatal");

// ── HTTP statuses OUR routes return per code (§8: 401/402/429/503/500) ──
assert.equal(httpStatusForCode("invalid_key"), 401);
assert.equal(httpStatusForCode("quota"), 402);
assert.equal(httpStatusForCode("rate_limit"), 429);
assert.equal(httpStatusForCode("transient"), 503);
assert.equal(httpStatusForCode("fatal"), 500);

// ── retryable flags follow the taxonomy ──
const flags: Record<ProviderErrorCode, boolean> = {
  invalid_key: false,
  quota: false,
  rate_limit: true,
  transient: true,
  fatal: false,
};
for (const [code, expected] of Object.entries(flags) as [ProviderErrorCode, boolean][]) {
  const e = providerError(code, "test", "boom");
  assert.equal(e.retryable, expected, `${code}.retryable === ${expected}`);
  assert.equal(isRetryable(e), expected, `isRetryable(${code}) === ${expected}`);
}

// ── providerError builds a real Error carrying every field ──
const err = providerError("invalid_key", "heygen", "HeyGen returned 401", { status: 401 });
assert.ok(err instanceof Error);
assert.equal(err.name, "ProviderError");
assert.equal(err.code, "invalid_key");
assert.equal(err.provider, "heygen");
assert.equal(err.message, "HeyGen returned 401");
assert.equal(err.status, 401);
assert.ok(err.userAction && err.userAction.includes("Settings"), "invalid_key userAction points to Settings");

// ── guards ──
assert.equal(isProviderError(err), true);
assert.equal(isProviderError(new Error("x")), false);
assert.equal(isProviderError(null), false);
assert.equal(isRetryable(new Error("x")), false);

// ── Thai user messages exist for every code ──
for (const code of ["invalid_key", "quota", "rate_limit", "transient", "fatal"] as const) {
  assert.ok(toUserMessage(code).length > 10, `toUserMessage(${code}) non-trivial`);
}

// ── route response shape ──
const { body, status } = toErrorResponse(err);
assert.equal(status, 401);
assert.equal(body.code, "invalid_key");
assert.equal(body.provider, "heygen");
assert.equal(body.missingKey, "heygen"); // opens the existing fix-your-key modal
// Legacy client gate: handleMissingKey() in video-creator/video-editor SKIPS the
// key modal whenever `retryable === false` (checked BEFORE missingKey) —
// invalid_key must therefore OMIT the legacy field, not set it to false.
assert.equal(body.retryable, undefined);
assert.equal(body.error, body.userAction); // legacy `error` key kept for current clients
const t = toErrorResponse(providerError("transient", "pexels", "503 from pexels", { status: 503 }));
assert.equal(t.status, 503);
assert.equal(t.body.missingKey, undefined);
assert.equal(t.body.retryable, true); // non-invalid_key codes DO carry the flag

console.log("verify-provider-errors: ALL PASS");
