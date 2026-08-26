/**
 * Issue #298 — Editor v2 quota_exceeded dead-end.
 *
 * `/api/videos/render` refuses with the design-doc §8 envelope
 *     { error: { code: "quota_exceeded", message, userAction, canBuyCredits? }, detail }
 * while `/api/videos/jobs` refuses with the flat legacy envelope
 *     { error: "quota_exceeded", message, userAction, remainingMinutes?, canBuyCredits? }.
 *
 * Editor v2 compared `d.error === "quota_exceeded"` — a string compare that can never
 * match the envelope — then handed `d.error` to `toast.error`, so the creator saw
 * "[object Object]" and no upgrade path. These assertions pin the parser that both
 * submit paths now share.
 *
 * Pure: no DB, no network, no React. Run with `npx tsx scripts/verify-quota-error-shape.ts`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  apiErrorCode,
  apiErrorMessage,
  parseQuotaExceeded,
  QUOTA_BUY_CREDITS_HREF,
  QUOTA_EXCEEDED_CODE,
  QUOTA_PRICING_HREF,
  quotaExceededText,
  quotaUpgradeUserAction,
} from "../src/lib/quota-error";
import {
  classifyFailure,
  failureViewCopy,
  type FailureJobLike,
} from "../src/app/(dashboard)/video-editor/_v2/failure-view";

const DIAGNOSTIC_TEXT = /MOVIO_|INSUFFICIENT_CREDIT|provider_failed|HTTP \d{3}|Prisma|ECONN/i;
const THAI_TEXT = /[ก-๙]/;

// ── Fixtures: the exact bodies the two routes send ────────────────────────────

/** /api/videos/render → quotaExceededResponse(message) with credits OFF. HTTP 403. */
const renderEnvelope = {
  error: {
    code: "quota_exceeded",
    provider: "heroai",
    message: "โควต้านาทีรอบนี้ใช้ครบแล้ว (80 นาที/เดือน)",
    userAction: "อัปเกรดแพ็กเกจที่หน้า Pricing เพื่อสร้างคลิปต่อ",
    retryable: false,
  },
  detail: "โควต้านาทีรอบนี้ใช้ครบแล้ว (80 นาที/เดือน)",
};

/** Same route with CREDITS_LIVE on — adds canBuyCredits and the top-up wording. */
const renderEnvelopeWithCredits = {
  error: {
    code: "quota_exceeded",
    provider: "heroai",
    message: "โควต้านาทีรอบนี้ใช้ครบแล้ว",
    userAction: "ซื้อเครดิตเพื่อเรนเดอร์ต่อ หรืออัปเกรดแพ็กเกจ",
    retryable: false,
    canBuyCredits: true,
  },
  detail: "โควต้านาทีรอบนี้ใช้ครบแล้ว",
};

/** /api/videos/jobs → VideoJobFundingError branch. HTTP 403. */
const jobsFlat = {
  error: "quota_exceeded",
  message: "นาทีคงเหลือไม่พอสำหรับคลิปนี้ (เหลือ 0.4 นาที)",
  userAction: "ซื้อเครดิตเพื่อเรนเดอร์ต่อ หรืออัปเกรดแพ็กเกจ",
  remainingMinutes: 0.4,
  canBuyCredits: true,
};

/** /api/videos/jobs → legacy clip-quota branch (MINUTE_QUOTA off). HTTP 403. */
const jobsFlatClipQuota = {
  error: "quota_exceeded",
  message: "ใช้สิทธิ์สร้างคลิปครบแล้วในรอบนี้",
  userAction: "อัปเกรดแพ็กเกจที่หน้า Pricing เพื่อสร้างคลิปต่อ",
  canBuyCredits: false,
};

// ── 1. Both envelopes yield the SAME code ─────────────────────────────────────

assert.equal(apiErrorCode(renderEnvelope), QUOTA_EXCEEDED_CODE, "envelope shape must yield the code");
assert.equal(apiErrorCode(jobsFlat), QUOTA_EXCEEDED_CODE, "flat shape must yield the code");
assert.equal(apiErrorCode(jobsFlatClipQuota), QUOTA_EXCEEDED_CODE);

// The regression itself: the old `d.error === "quota_exceeded"` compare against the
// envelope is false, which is why the dead-end shipped.
assert.notEqual(
  (renderEnvelope as { error: unknown }).error,
  QUOTA_EXCEEDED_CODE,
  "fixture must reproduce the shape the old string compare missed",
);

// apiErrorCode never returns a non-string, so no caller can compare against an object.
for (const body of [renderEnvelope, jobsFlat, { error: { code: 7 } }, { error: {} }, null, "boom", 42, []]) {
  const code = apiErrorCode(body);
  assert.ok(code === null || typeof code === "string", "apiErrorCode must return string | null");
}

// ── 2. Non-quota bodies must NOT be treated as quota ──────────────────────────

assert.equal(parseQuotaExceeded({ error: "too_many_jobs", message: "มีงานค้างอยู่หลายชิ้นแล้ว" }), null);
assert.equal(parseQuotaExceeded({ error: { code: "duration_exceeded", message: "คลิปยาวเกิน" } }), null);
assert.equal(parseQuotaExceeded({ error: "missing_voice_id" }), null);
assert.equal(parseQuotaExceeded(null), null, "a body that failed to parse must not look like quota");
assert.equal(parseQuotaExceeded("quota_exceeded"), null, "a bare string body is not an error envelope");
assert.equal(apiErrorCode({ error: "too_many_jobs" }), "too_many_jobs");
assert.equal(apiErrorCode({ error: "missing_voice_id" }), "missing_voice_id");

// A 409 (idempotency_conflict) is a different refusal and must stay on the generic path.
assert.equal(parseQuotaExceeded({ error: "idempotency_conflict", message: "idempotencyKey นี้ถูกใช้แล้ว" }), null);

// ── 3. Parsed facts ───────────────────────────────────────────────────────────

const fromRender = parseQuotaExceeded(renderEnvelope);
assert.ok(fromRender, "render envelope must parse");
assert.equal(fromRender.message, "โควต้านาทีรอบนี้ใช้ครบแล้ว (80 นาที/เดือน)");
assert.equal(fromRender.userAction, "อัปเกรดแพ็กเกจที่หน้า Pricing เพื่อสร้างคลิปต่อ");
assert.equal(fromRender.canBuyCredits, false, "no canBuyCredits field → must not offer a top-up");
assert.equal(fromRender.remainingMinutes, null);

const fromRenderCredits = parseQuotaExceeded(renderEnvelopeWithCredits);
assert.ok(fromRenderCredits);
assert.equal(fromRenderCredits.canBuyCredits, true);

const fromJobs = parseQuotaExceeded(jobsFlat);
assert.ok(fromJobs, "flat envelope must parse");
assert.equal(fromJobs.message, "นาทีคงเหลือไม่พอสำหรับคลิปนี้ (เหลือ 0.4 นาที)");
assert.equal(fromJobs.userAction, "ซื้อเครดิตเพื่อเรนเดอร์ต่อ หรืออัปเกรดแพ็กเกจ");
assert.equal(fromJobs.canBuyCredits, true);
assert.equal(fromJobs.remainingMinutes, 0.4);

const fromJobsClip = parseQuotaExceeded(jobsFlatClipQuota);
assert.ok(fromJobsClip);
assert.equal(fromJobsClip.canBuyCredits, false, "clip-quota refusal has no credit route out");

// canBuyCredits is strictly boolean-true gated — a truthy string must not unlock the CTA.
const spoofed = parseQuotaExceeded({ error: "quota_exceeded", message: "หมดโควต้า", canBuyCredits: "yes" });
assert.ok(spoofed);
assert.equal(spoofed.canBuyCredits, false, "only literal true may offer the buy-credits CTA");

// A quota refusal that carries nothing but `detail` still parses with usable copy.
const detailOnly = parseQuotaExceeded({ error: { code: "quota_exceeded" }, detail: "โควต้าหมดแล้ว" });
assert.ok(detailOnly);
assert.equal(detailOnly.message, "โควต้าหมดแล้ว");

// ── 4. The customer sentence — never "[object Object]" ────────────────────────

const FALLBACK = "ส่งงานไม่สำเร็จ (403)";
for (const [label, info] of [
  ["render", fromRender],
  ["render+credits", fromRenderCredits],
  ["jobs", fromJobs],
  ["jobs-clip", fromJobsClip],
] as const) {
  const text = quotaExceededText(info, FALLBACK);
  assert.equal(typeof text, "string", `${label}: must be a string`);
  assert.doesNotMatch(text, /\[object Object\]/, `${label}: the #298 symptom must be gone`);
  assert.match(text, THAI_TEXT, `${label}: must be Thai customer copy`);
  assert.doesNotMatch(text, DIAGNOSTIC_TEXT, `${label}: must not echo diagnostics`);
  assert.ok(text.includes(info.message ?? ""), `${label}: must say what ran out`);
  assert.ok(text.includes(info.userAction ?? ""), `${label}: must say what to do next`);
}

// The old dead-end, reproduced: stringifying the envelope's `error` is what the user saw.
assert.equal(String(renderEnvelope.error), "[object Object]");
assert.notEqual(quotaExceededText(fromRender, FALLBACK), String(renderEnvelope.error));

// Diagnostic text that leaks into `message` is dropped, not shown.
const leaky = parseQuotaExceeded({
  error: { code: "quota_exceeded", message: "reserveMinutes failed: Prisma P2002", userAction: "อัปเกรดแพ็กเกจ" },
});
assert.ok(leaky);
const leakyText = quotaExceededText(leaky, FALLBACK);
assert.doesNotMatch(leakyText, DIAGNOSTIC_TEXT, "diagnostic message must be filtered out");
assert.equal(leakyText, "อัปเกรดแพ็กเกจ");

// Nothing customer-safe at all → the caller's fallback, still a string.
const empty = parseQuotaExceeded({ error: { code: "quota_exceeded", message: "Prisma ECONNREFUSED" } });
assert.ok(empty);
assert.equal(quotaExceededText(empty, FALLBACK), FALLBACK);

// Duplicate message/userAction must not render as "X — X".
const duped = parseQuotaExceeded({ error: "quota_exceeded", message: "โควต้าหมดแล้ว", userAction: "โควต้าหมดแล้ว" });
assert.ok(duped);
assert.equal(quotaExceededText(duped, FALLBACK), "โควต้าหมดแล้ว");

// ── 5. apiErrorMessage: any error body, always a string ───────────────────────

assert.equal(apiErrorMessage(renderEnvelope, FALLBACK), "โควต้านาทีรอบนี้ใช้ครบแล้ว (80 นาที/เดือน)");
assert.equal(apiErrorMessage({ error: "too_many_jobs", message: "มีงานค้าง" }, FALLBACK), "มีงานค้าง");
assert.equal(apiErrorMessage({ error: "internal_error" }, FALLBACK), "internal_error");
assert.equal(apiErrorMessage(null, FALLBACK), FALLBACK);
for (const body of [renderEnvelope, jobsFlat, { error: {} }, { error: { code: "x" } }, null, [], 0]) {
  const text = apiErrorMessage(body, FALLBACK);
  assert.equal(typeof text, "string");
  assert.doesNotMatch(text, /\[object Object\]/, "apiErrorMessage must never stringify an object");
}

// ── 6. Shared upgrade wording — the two routes cannot drift ───────────────────

assert.equal(quotaUpgradeUserAction(false), "อัปเกรดแพ็กเกจที่หน้า Pricing เพื่อสร้างคลิปต่อ");
assert.equal(quotaUpgradeUserAction(true), "ซื้อเครดิตเพื่อเรนเดอร์ต่อ หรืออัปเกรดแพ็กเกจ");
assert.equal(quotaUpgradeUserAction(false), renderEnvelope.error.userAction);
assert.equal(quotaUpgradeUserAction(true), jobsFlat.userAction);
assert.equal(QUOTA_PRICING_HREF, "/pricing?source=quota_hit");
assert.equal(QUOTA_BUY_CREDITS_HREF, "/settings?tab=billing");

// ── 7. FailedView kind `plan-quota` ───────────────────────────────────────────

function videoJob(overrides: Partial<FailureJobLike>): FailureJobLike {
  return { errorCode: null, errorMessage: null, errorProvider: null, currentStep: null, ...overrides };
}

const planQuotaJob = videoJob({
  currentStep: "render",
  errorCode: "quota_exceeded",
  errorMessage: "โควต้านาทีรอบนี้ใช้ครบแล้ว",
});
assert.equal(classifyFailure(planQuotaJob), "plan-quota");

// A third-party quota is still the provider kind — the two must not collapse.
assert.equal(classifyFailure(videoJob({ errorCode: "quota", errorProvider: "elevenlabs" })), "provider-quota");
assert.equal(classifyFailure(videoJob({ errorCode: "quota", errorProvider: "heygen" })), "heygen-quota");

const planQuotaCopy = failureViewCopy("plan-quota", planQuotaJob, false);
assert.match(planQuotaCopy.heading, THAI_TEXT);
assert.match(planQuotaCopy.body, THAI_TEXT);
assert.doesNotMatch(planQuotaCopy.heading, DIAGNOSTIC_TEXT);
assert.doesNotMatch(planQuotaCopy.body, DIAGNOSTIC_TEXT);
assert.notEqual(planQuotaCopy.body, planQuotaJob.errorMessage, "must not echo the job's diagnostic message");
assert.match(planQuotaCopy.body, /อัปเกรด/, "must name the upgrade route out");

// ── 8. Wiring guards — the call sites that make the parse reach a customer ────

const shell = fs.readFileSync("src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx", "utf-8");
assert.ok(shell.includes("if (result.quota) {"), "shell must branch on the parsed quota result");
assert.ok(shell.includes('trackEvent("quota_hit"'), "shell must emit the quota_hit funnel event");
assert.ok(shell.includes("<UpgradeModal"), "shell must open UpgradeModal for a quota refusal");
assert.ok(shell.includes("pricingHref={QUOTA_PRICING_HREF}"), "upgrade CTA must carry source=quota_hit");
assert.ok(
  shell.includes("quotaModal?.canBuyCredits") && shell.includes("QUOTA_BUY_CREDITS_HREF"),
  "the top-up CTA must be gated on canBuyCredits",
);

const job = fs.readFileSync("src/app/(dashboard)/video-editor/_v2/useV2Job.ts", "utf-8");
assert.ok(!job.includes('d?.error === "quota_exceeded"'), "the string-only compare must be gone");
assert.ok(!job.includes('d?.error === "too_many_jobs"'), "sibling compares must read the parsed code too");
assert.ok(!job.includes("d?.message ?? d?.error ??"), "an object `error` must never become toast text");
assert.equal(
  (job.match(/parseQuotaExceeded\(d\)/g) ?? []).length,
  2,
  "both submit paths (create + export) must parse the quota shape",
);

console.log("verify-quota-error-shape: OK");
