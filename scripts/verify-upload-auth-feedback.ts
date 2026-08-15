import assert from "node:assert/strict";
import {
  probeUploadSession,
  uploadErrorMessage,
} from "../src/lib/avatar-upload-error";

assert.equal(
  uploadErrorMessage(401, {}, "active"),
  "อัปโหลดใช้เวลานานเกินไป กรุณาลองอีกครั้งได้เลยโดยไม่ต้องเข้าสู่ระบบใหม่",
);
assert.equal(
  uploadErrorMessage(401, {}, "expired"),
  "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่แล้วลองอีกครั้ง",
);
assert.equal(
  uploadErrorMessage(401, {}, "unknown"),
  "ตรวจสอบเซสชันไม่สำเร็จ กรุณารีเฟรชหน้าแล้วลองอีกครั้ง",
);
assert.equal(uploadErrorMessage(413, {}, "unknown"), "ไฟล์ใหญ่เกิน 500 MB");
assert.equal(uploadErrorMessage(500, { error: "upstream failed" }, "unknown"), "upstream failed");

async function main() {
  assert.equal(
    await probeUploadSession(async () => new Response("{}", { status: 200 })),
    "active",
  );
  assert.equal(
    await probeUploadSession(async () => new Response("{}", { status: 401 })),
    "expired",
  );
  assert.equal(
    await probeUploadSession(async () => new Response("{}", { status: 500 })),
    "unknown",
  );
  assert.equal(
    await probeUploadSession(async () => { throw new Error("offline"); }),
    "unknown",
  );

  console.log("PASS upload auth feedback distinguishes a live session from a real expiry");
}

void main();
