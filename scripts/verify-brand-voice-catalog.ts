import assert from "node:assert/strict";
import { describeVoiceCatalogFailure, shouldFallBackToGemini } from "../src/lib/brand-voice-catalog";

// HERO-32 — every non-OK answer from the voice routes must become an actionable message,
// the retry button must exist only where a retry can work, and a saved voice is never
// swapped away from under the creator.

// 400: no key → Settings link, provider unusable, no retry.
const noKey = describeVoiceCatalogFailure({ provider: "elevenlabs", status: 400, body: { error: "Please add your ElevenLabs API key in Settings" } });
assert.match(noKey.message, /API key ของ ElevenLabs/);
assert.equal(noKey.action?.href, "/settings?tab=api-keys");
assert.equal(noKey.retryable, false);
assert.equal(noKey.providerUnavailable, true);

// 403: plan gate → pricing link, provider unusable.
const plan = describeVoiceCatalogFailure({ provider: "elevenlabs", status: 403, body: { error: "ElevenLabs voices are only available for Pro and Business users" } });
assert.match(plan.message, /PRO \/ BUSINESS/);
assert.equal(plan.action?.href, "/pricing?source=brand_voice");
assert.equal(plan.providerUnavailable, true);
assert.equal(plan.retryable, false);

// 404: Hero Voice cohort gate.
const cohort = describeVoiceCatalogFailure({ provider: "omnivoice", status: 404, body: { error: "Not found" } });
assert.match(cohort.message, /Hero AI Voice ยังไม่เปิดให้บัญชีนี้/);
assert.equal(cohort.providerUnavailable, true);

// 422: invalid key → the route's own message + action path; provider stays (creator has a key to fix).
const invalid = describeVoiceCatalogFailure({
  provider: "elevenlabs",
  status: 422,
  body: { error: "API Key ElevenLabs ไม่ถูกต้อง กรุณาตรวจสอบใน Settings", code: "ELEVENLABS_KEY_INVALID", action: "/settings?tab=api-keys" },
});
assert.equal(invalid.message, "API Key ElevenLabs ไม่ถูกต้อง กรุณาตรวจสอบใน Settings");
assert.equal(invalid.action?.href, "/settings?tab=api-keys");
assert.equal(invalid.providerUnavailable, false);
assert.equal(invalid.retryable, false);

// A server `action` that is not a same-origin path is ignored.
const hostile = describeVoiceCatalogFailure({ provider: "elevenlabs", status: 422, body: { error: "x", action: "https://evil.example/steal" } });
assert.equal(hostile.action?.href, "/settings?tab=api-keys");
const protocolRelative = describeVoiceCatalogFailure({ provider: "elevenlabs", status: 400, body: { action: "//evil.example" } });
assert.equal(protocolRelative.action?.href, "/settings?tab=api-keys");

// 503: upstream down → retry allowed, saved voice kept.
const down = describeVoiceCatalogFailure({ provider: "omnivoice", status: 503, body: { error: "Hero Voice ยังไม่พร้อมใช้งาน" } });
assert.equal(down.message, "Hero Voice ยังไม่พร้อมใช้งาน");
assert.equal(down.retryable, true);
assert.equal(down.providerUnavailable, false);

// 401: session → retry, no provider change.
const session = describeVoiceCatalogFailure({ provider: "elevenlabs", status: 401 });
assert.equal(session.retryable, true);
assert.equal(session.providerUnavailable, false);

// Network failure → retry, explicit "saved voice unchanged".
const network = describeVoiceCatalogFailure({ provider: "elevenlabs", status: null });
assert.equal(network.retryable, true);
assert.match(network.message, /เสียงที่บันทึกไว้ยังคงเดิม/);

// Unknown 5xx with no body → generic but still provider-labelled.
const unknown = describeVoiceCatalogFailure({ provider: "elevenlabs", status: 500, body: null });
assert.match(unknown.message, /ElevenLabs ยังไม่พร้อมใช้งานชั่วคราว/);
assert.equal(unknown.retryable, true);

// Fallback rule: only when unusable AND nothing saved on that provider.
assert.equal(shouldFallBackToGemini(noKey, null), true, "FREE/trial with no key and no saved voice → switch to Gemini");
assert.equal(shouldFallBackToGemini(plan, null), true);
assert.equal(shouldFallBackToGemini(noKey, "voice_123"), false, "a saved ElevenLabs voice is never overwritten");
assert.equal(shouldFallBackToGemini(invalid, null), false, "invalid key is fixable — keep the provider");
assert.equal(shouldFallBackToGemini(down, null), false, "outage is temporary — keep the provider");
assert.equal(shouldFallBackToGemini(network, null), false);

console.log("verify-brand-voice-catalog: PASS actionable messages per status, safe action paths, retry only when useful, saved voice preserved");
