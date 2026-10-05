import {
  MAX_ACTIVE_IMPORTS,
  MAX_IMPORTS_PER_HOUR,
  MAX_UPLOAD_LINKS_PER_HOUR,
  type AdmissionCode,
} from "@/lib/media-import/imports";

/**
 * The G14 refusal copy for a Media Import admission refused by the DB caps (G25). Shared by
 * `create_upload_url` / the PUT route (Task 11) and `replace_broll_window(url)` (Task 13), and
 * kept in its own module so edit-tools.ts and media-import-tools.ts do not import each other.
 * `retryTool` is the tool the agent calls again once there is room.
 *
 * `retryAfterSeconds` (HERO-69): for the two hourly-cap codes, how long until the oldest row
 * counted against the cap ages out of the rolling 1-hour window (computed in imports.ts and
 * carried through `AdmissionRefused`). When present it is also surfaced as a top-level numeric
 * field on the envelope, flat beside `error`/`code`/`message`/`next` (G13/G14: one flat reply,
 * agent-neutral) — never nested. Other refusal codes never get it.
 */
export function admissionRefusal(code: AdmissionCode, retryTool = "create_upload_url", retryAfterSeconds?: number) {
  const minutes = retryAfterSeconds !== undefined ? Math.max(1, Math.ceil(retryAfterSeconds / 60)) : undefined;
  const copy: Record<AdmissionCode, { message: string; next: string }> = {
    too_many_active_imports: {
      message: `มีไฟล์กำลังนำเข้าอยู่ครบ ${MAX_ACTIVE_IMPORTS} ไฟล์แล้ว`,
      next: `รอให้ไฟล์ที่กำลังนำเข้าเสร็จก่อน แล้วค่อยเรียก ${retryTool} อีกครั้ง`,
    },
    import_hourly_limit: {
      message: `นำเข้าไฟล์ครบ ${MAX_IMPORTS_PER_HOUR} ไฟล์ในหนึ่งชั่วโมงแล้ว`,
      next: minutes !== undefined ? `รอประมาณ ${minutes} นาทีแล้วลองใหม่` : "รอสักพัก (ไม่เกิน 1 ชั่วโมง) แล้วลองใหม่",
    },
    upload_link_hourly_limit: {
      message: `ขอลิงก์อัปโหลดครบ ${MAX_UPLOAD_LINKS_PER_HOUR} ครั้งในหนึ่งชั่วโมงแล้ว`,
      next:
        minutes !== undefined
          ? `รอประมาณ ${minutes} นาทีแล้วลองใหม่ หรือส่งลิงก์สาธารณะ (url) แทน`
          : "ใช้ลิงก์ที่ขอไว้แล้วที่ยังไม่หมดอายุ หรือส่งลิงก์สาธารณะ (url) แทน หรือรอสักพักแล้วลองใหม่",
    },
    storage_busy: {
      message: "พื้นที่รับไฟล์ของระบบเต็มชั่วคราว",
      next: `รอสักครู่ (ไม่กี่นาที) แล้วเรียก ${retryTool} อีกครั้ง`,
    },
  };
  const { message, next } = copy[code];
  return retryAfterSeconds !== undefined ? { error: code, code, message, next, retryAfterSeconds } : { error: code, code, message, next };
}
