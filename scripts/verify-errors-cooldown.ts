import assert from "node:assert/strict";
import { classifyJobError } from "../src/lib/job-failure-class";
import {
  classifyFailure,
  failureViewCopy,
  type FailureJobLike,
} from "../src/app/(dashboard)/video-editor/_v2/failure-view";

function job(overrides: Partial<FailureJobLike> = {}): FailureJobLike {
  return {
    errorCode: null,
    errorMessage: null,
    errorProvider: null,
    currentStep: null,
    ...overrides,
  };
}

// The local hourly gate supplies an exact wait. A missing bound stays deliberately vague.
const limited = job({
  errorCode: "RATE_LIMITED",
  errorMessage: "Hero AI Image ใช้ครบโควต้าต่อชั่วโมงแล้ว ลองใหม่ได้ในอีก ~121 วินาที",
});
assert.equal(classifyFailure(limited), "rate-limited");
assert.deepEqual(failureViewCopy("rate-limited", limited, false), {
  heading: "สร้างภาพครบขีดจำกัดชั่วคราว",
  body: "รออีกประมาณ 3 นาที แล้วลองสร้างใหม่ได้",
});
assert.equal(
  failureViewCopy("rate-limited", job({ errorCode: "RATE_LIMITED" }), false).body,
  "กรุณารอสักครู่แล้วลองใหม่",
);

// The managed audio ceiling is a plan quota, never a system incident.
assert.equal(
  classifyJobError("ใช้เสียง AI (สร้างเสียง/ถอดเสียง) ครบเพดานรอบนี้แล้ว (Pro: 30 นาที/30 วัน)", true),
  "quota",
);

console.log("verify-errors-cooldown: PASS");
