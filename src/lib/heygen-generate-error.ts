import { classifyHttpStatus, providerError, toErrorResponse } from "@/lib/provider-errors";

const WORKSPACE_REASON = "SPACE_ENCRYPTION_DISABLED";
const WORKSPACE_ACTION = "พื้นที่ทำงาน HeyGen ที่เชื่อมอยู่ยังไม่พร้อมสร้าง Avatar — ให้ผู้ดูแลบัญชีตรวจสอบการตั้งค่าพื้นที่ทำงาน หรือติดต่อ HeyGen แล้วลองใหม่ หรือปิด Avatar เพื่อสร้างวิดีโอต่อ";
const AVATAR_NOT_FOUND = /avatar look not found/i;
const AVATAR_NOT_FOUND_REASON = "HEYGEN_AVATAR_NOT_FOUND";
const AVATAR_NOT_FOUND_ACTION = "ไม่สามารถใช้ Avatar ที่เลือกในบัญชี HeyGen นี้ได้ กรุณาเลือก Avatar ใหม่หรือลองปิด Avatar แล้วสร้างวิดีโออีกครั้ง";

/** Parse the provider's generate response before it crosses the pipeline boundary. */
export function heygenGenerateFailureResponse(status: number, body: unknown) {
  const serialized = JSON.stringify(body);
  const reason = serialized.includes(WORKSPACE_REASON)
    ? WORKSPACE_REASON
    : AVATAR_NOT_FOUND.test(serialized)
      ? AVATAR_NOT_FOUND_REASON
      : undefined;
  const userAction = reason === WORKSPACE_REASON
    ? WORKSPACE_ACTION
    : reason === AVATAR_NOT_FOUND_REASON
      ? AVATAR_NOT_FOUND_ACTION
      : undefined;
  return toErrorResponse(providerError(
    classifyHttpStatus(status),
    "heygen",
    `HeyGen generate failed (${status}): ${serialized.slice(0, 300)}`,
    { status, ...(reason ? { reason } : {}), ...(userAction ? { userAction } : {}) },
  ));
}
