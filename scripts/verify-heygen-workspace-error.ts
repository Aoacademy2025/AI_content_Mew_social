import assert from "node:assert/strict";
import { providerError, toErrorResponse } from "../src/lib/provider-errors";
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

const workspaceTransport = toErrorResponse(providerError(
  "fatal",
  "heygen",
  "HeyGen rejected the request",
  {
    status: 400,
    reason: "SPACE_ENCRYPTION_DISABLED",
    userAction: "พื้นที่ทำงาน HeyGen ที่เชื่อมอยู่ยังไม่พร้อมสร้าง Avatar — ให้ผู้ดูแลบัญชีตรวจสอบการตั้งค่าพื้นที่ทำงาน หรือติดต่อ HeyGen แล้วลองใหม่ หรือปิด Avatar เพื่อสร้างวิดีโอต่อ",
  },
));
assert.equal(workspaceTransport.body.reason, "SPACE_ENCRYPTION_DISABLED");
assert.equal(workspaceTransport.body.error, workspaceTransport.body.userAction);

const workspace = job({
  currentStep: "avatar",
  errorProvider: "heygen",
  errorCode: "SPACE_ENCRYPTION_DISABLED",
  errorMessage: "SPACE_ENCRYPTION_DISABLED",
});
assert.equal(classifyFailure(workspace), "heygen-workspace-unavailable");
assert.deepEqual(failureViewCopy(classifyFailure(workspace), workspace, false), {
  heading: "เชื่อมต่อพื้นที่ทำงาน HeyGen ไม่สำเร็จ",
  body: "พื้นที่ทำงาน HeyGen ที่เชื่อมอยู่ยังไม่พร้อมสร้าง Avatar — ให้ผู้ดูแลบัญชีตรวจสอบการตั้งค่าพื้นที่ทำงาน หรือติดต่อ HeyGen แล้วลองใหม่ หรือปิด Avatar เพื่อสร้างวิดีโอต่อ",
});

assert.equal(
  classifyFailure(job({ errorProvider: "heygen", errorCode: "fatal", errorMessage: "avatar look not found" })),
  "heygen-avatar-rejected",
);
assert.equal(
  classifyFailure(job({ errorProvider: "heygen", errorCode: "fatal", errorMessage: "upstream rejected a request" })),
  "generic",
);

console.log("verify-heygen-workspace-error: PASS");
