import assert from "node:assert/strict";
import fs from "node:fs";
import {
  classifyFailure,
  failureViewCopy,
  type FailureJobLike,
} from "../src/app/(dashboard)/video-editor/_v2/failure-view";
import { mapHeygenPollResponse } from "../src/lib/heygen-poll";
import { customerGenerationErrorCopy } from "../src/lib/customer-generation-error";
import { customerApiErrorMessage } from "../src/lib/customer-api-error";

const DEV_TEXT = /MOVIO_|INSUFFICIENT_CREDIT|Insufficient credit|provider_failed|HTTP \d{3}|manual recovery|required 'api' credits/i;

function videoJob(overrides: Record<string, unknown>): FailureJobLike {
  return {
    errorCode: null,
    errorMessage: null,
    errorProvider: null,
    currentStep: null,
    ...overrides,
  } as FailureJobLike;
}

function assertCustomerSafe(copy: { heading: string; body: string }, original: string) {
  assert.ok(copy.heading.trim().length > 0);
  assert.ok(copy.body.trim().length > 0);
  assert.notEqual(copy.body, original, "customer copy must not echo the diagnostic message");
  assert.doesNotMatch(copy.heading, DEV_TEXT);
  assert.doesNotMatch(copy.body, DEV_TEXT);
}

const realHeygenMessage = "avatar generation failed: MOVIO_PAYMENT_INSUFFICIENT_CREDIT: Insufficient credit. This operation requires 'api' credits.: Insufficient credit";
const heygenJob = videoJob({
  currentStep: "avatar",
  errorProvider: "heygen",
  errorCode: "fatal",
  errorMessage: realHeygenMessage,
});
assert.equal(classifyFailure(heygenJob), "heygen-quota");
const heygenCopy = failureViewCopy(classifyFailure(heygenJob), heygenJob, false);
assertCustomerSafe(heygenCopy, realHeygenMessage);
assert.equal(heygenCopy.heading, "เครดิต HeyGen ไม่เพียงพอ");
assert.match(heygenCopy.body, /คนละส่วนกับเครดิต Hero/);
assert.match(heygenCopy.body, /เติมเครดิต.*HeyGen|ปิด Avatar/);

const invalidKeyMessage = "HeyGen returned HTTP 401: invalid api key";
const invalidKeyJob = videoJob({
  currentStep: "avatar",
  errorProvider: "heygen",
  errorCode: "invalid_key",
  errorMessage: invalidKeyMessage,
});
assert.equal(classifyFailure(invalidKeyJob), "provider-key");
const invalidKeyCopy = failureViewCopy(classifyFailure(invalidKeyJob), invalidKeyJob, false);
assertCustomerSafe(invalidKeyCopy, invalidKeyMessage);
assert.match(invalidKeyCopy.heading, /เชื่อมต่อ HeyGen/);
assert.match(invalidKeyCopy.body, /Settings/);

const heroOutputMessage = "Hero AI Image สร้างไม่ครบ 1 ฉาก ระบบคืนเครดิตภาพของงานนี้แล้ว";
const heroOutputJob = videoJob({
  currentStep: "stock",
  errorCode: "HERO_IMAGE_OUTPUT_FAILED",
  errorMessage: heroOutputMessage,
});
assert.equal(classifyFailure(heroOutputJob), "hero-image-transient");
const heroOutputCopy = failureViewCopy(classifyFailure(heroOutputJob), heroOutputJob, false);
assert.notEqual(heroOutputCopy.body, heroOutputMessage);
assert.match(heroOutputCopy.heading, /ภาพ AI/);
assert.match(heroOutputCopy.body, /ไม่ถูกคิด|ถูกคืน/);
assert.match(heroOutputCopy.body, /ลองเรนเดอร์ใหม่/);

for (const [currentStep, expectedHeading] of [
  ["tts", "สร้างเสียงพากย์ไม่สำเร็จ"],
  ["captions", "สร้างคำบรรยายไม่สำเร็จ"],
  ["stock", "เตรียมภาพประกอบไม่สำเร็จ"],
  ["render", "ประกอบวิดีโอไม่สำเร็จ"],
  ["avatar", "สร้าง Avatar ไม่สำเร็จ"],
  ["burn", "ส่งออกวิดีโอไม่สำเร็จ"],
] as const) {
  const raw = `internal ${currentStep} provider_failed HTTP 503`;
  const job = videoJob({ currentStep, errorMessage: raw });
  const copy = failureViewCopy(classifyFailure(job), job, currentStep === "burn");
  assertCustomerSafe(copy, raw);
  assert.equal(copy.heading, expectedHeading);
}

const rateMessage = "RunPod RATE_LIMITED HTTP 429 internal provider response";
const rateJob = videoJob({ currentStep: "stock", errorCode: "RATE_LIMITED", errorMessage: rateMessage });
assertCustomerSafe(failureViewCopy(classifyFailure(rateJob), rateJob, false), rateMessage);

const poll = mapHeygenPollResponse({
  httpStatus: 200,
  body: {
    code: 100,
    data: {
      status: "failed",
      error: {
        code: "MOVIO_PAYMENT_INSUFFICIENT_CREDIT",
        message: "Insufficient credit. This operation requires 'api' credits.",
      },
    },
  },
});
assert.equal(poll.status, "failed");
assert.equal(poll.error?.code, "insufficient_credit");
assert.equal(poll.error?.message, "เครดิต HeyGen ไม่เพียงพอ");
assert.doesNotMatch(poll.errorMsg ?? "", DEV_TEXT);

assert.equal(
  customerGenerationErrorCopy({
    kind: "image",
    provider: "runpod",
    errorCode: "OUTPUT_INVALID",
    chargeState: "refunded",
    creditCost: 2,
  }),
  "สร้างภาพรอบนี้ไม่สำเร็จ ระบบคืนเครดิตหรือสิทธิ์ของงานนี้แล้ว — กดลองใหม่ได้",
);

assert.equal(
  customerApiErrorMessage(
    { error: "MOVIO_PAYMENT_INSUFFICIENT_CREDIT: HTTP 402 Insufficient credit" },
    "สร้าง Avatar ไม่สำเร็จ กรุณาลองใหม่",
  ),
  "สร้าง Avatar ไม่สำเร็จ กรุณาลองใหม่",
);
assert.equal(
  customerApiErrorMessage(
    { userAction: "เติมเครดิตในบัญชี HeyGen แล้วลองใหม่", error: "provider_failed HTTP 402" },
    "fallback",
  ),
  "เติมเครดิตในบัญชี HeyGen แล้วลองใหม่",
);

const aiStudio = fs.readFileSync("src/app/(dashboard)/ai-studio/page.tsx", "utf8");
assert.doesNotMatch(aiStudio, />\{job\.errorMessage\}<\/p>/, "AI Studio must not render durable diagnostic text directly");
assert.match(aiStudio, /customerGenerationErrorCopy\(job\)/, "AI Studio must use the customer-safe copy helper");

const previewRecovery = fs.readFileSync("src/app/(dashboard)/brands/_components/preview-recovery.ts", "utf8");
assert.doesNotMatch(previewRecovery, /value\.message \|\| value\.error/, "Brand Preview must not trust API text directly");
assert.match(previewRecovery, /customerApiErrorMessage/, "Brand Preview must filter API copy at its browser boundary");

const postEditor = fs.readFileSync("src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts", "utf8");
assert.doesNotMatch(postEditor, /throw new Error\(p\.errorMessage \?\?/, "B-roll updates must not echo VideoJob diagnostics");
assert.match(postEditor, /customerApiErrorMessage/, "B-roll updates must filter API and job failures");

console.log("verify-customer-error-copy: ALL PASS");
