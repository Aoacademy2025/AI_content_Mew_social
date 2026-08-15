/** Customer-owned copy for failed AI Studio jobs.
 * Durable errorMessage remains diagnostic evidence and must never be rendered. */

export interface CustomerGenerationFailureLike {
  kind: "image" | "voice";
  provider: string;
  errorCode: string | null;
  chargeState: string;
  creditCost: number;
}

export function customerGenerationErrorCopy(job: CustomerGenerationFailureLike): string {
  if (job.errorCode === "invalid_key") {
    return "API Key ของบริการที่เลือกใช้ไม่ได้หรือหมดอายุ — อัปเดต Key ใน Settings แล้วลองใหม่";
  }
  if (job.errorCode === "quota" || job.errorCode === "INSUFFICIENT_CREDITS") {
    return "โควต้าหรือเครดิตของบริการที่เลือกไม่เพียงพอ — ตรวจสอบยอดคงเหลือแล้วลองใหม่";
  }
  if (job.errorCode === "RATE_LIMITED") {
    return "มีการสร้างงานถี่เกินไปชั่วคราว — รอสักครู่แล้วลองใหม่";
  }
  if (job.kind === "image") {
    if (job.chargeState === "refunded") {
      return "สร้างภาพรอบนี้ไม่สำเร็จ ระบบคืนเครดิตหรือสิทธิ์ของงานนี้แล้ว — กดลองใหม่ได้";
    }
    return "สร้างภาพรอบนี้ไม่สำเร็จ — กดลองใหม่อีกครั้ง";
  }
  return "สร้างเสียงรอบนี้ไม่สำเร็จ — กดลองใหม่อีกครั้ง";
}
