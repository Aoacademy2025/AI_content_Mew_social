import {
  MAX_ACTIVE_IMPORTS,
  MAX_IMPORTS_PER_HOUR,
  MAX_UPLOAD_LINKS_PER_HOUR,
  type AdmissionCode,
} from "@/lib/media-import/imports";
import {
  MAX_ACTIVE_IMPORT_BYTES_PER_USER,
  MAX_IMPORT_BYTES_PER_DAY,
  MAX_IMPORT_BYTES_PER_HOUR,
  formatImportBytes,
} from "@/lib/media-import/limits";

/**
 * The G14 refusal copy for a Media Import admission refused by the DB caps (G25). Shared by
 * `create_upload_url` / the PUT route (Task 11) and `replace_broll_window(url)` (Task 13), and
 * kept in its own module so edit-tools.ts and media-import-tools.ts do not import each other.
 * `retryTool` is the tool the agent calls again once there is room.
 *
 * `retryAfterSeconds` (HERO-69): how long until the refusal should clear — for a rolling-window
 * cap, when enough of what it counts ages out of the window; for the active-import caps, a short
 * fixed hint (computed in imports.ts and carried through `AdmissionRefused`). When present it is
 * also surfaced as a top-level numeric field on the envelope, flat beside
 * `error`/`code`/`message`/`next` (G13/G14: one flat reply, agent-neutral) — never nested.
 * `storage_busy` never gets it (it depends on other users).
 *
 * The byte-budget codes (limits.ts) carry a short English gloss after the Thai, so an agent that
 * does not read Thai still knows which budget it hit.
 */
export function admissionRefusal(code: AdmissionCode, retryTool = "create_upload_url", retryAfterSeconds?: number) {
  const minutes = retryAfterSeconds !== undefined ? Math.max(1, Math.ceil(retryAfterSeconds / 60)) : undefined;
  const wait = minutes === undefined ? undefined : minutes > 90 ? `ประมาณ ${Math.ceil(minutes / 60)} ชั่วโมง` : `ประมาณ ${minutes} นาที`;
  const share = formatImportBytes(MAX_ACTIVE_IMPORT_BYTES_PER_USER);
  const perHour = formatImportBytes(MAX_IMPORT_BYTES_PER_HOUR);
  const perDay = formatImportBytes(MAX_IMPORT_BYTES_PER_DAY);
  const copy: Record<AdmissionCode, { message: string; next: string }> = {
    too_many_active_imports: {
      message: `มีไฟล์กำลังนำเข้าอยู่ครบ ${MAX_ACTIVE_IMPORTS} ไฟล์แล้ว`,
      next: `รอให้ไฟล์ที่กำลังนำเข้าเสร็จก่อน${wait ? ` (${wait})` : ""} แล้วค่อยเรียก ${retryTool} อีกครั้ง`,
    },
    active_import_bytes_limit: {
      message: `ไฟล์ที่กำลังนำเข้าของคุณรวมกันเกิน ${share} แล้ว (your imports in progress would exceed ${share})`,
      next: `รอให้ไฟล์ที่กำลังนำเข้าเสร็จก่อน${wait ? ` (${wait})` : ""} แล้วค่อยเรียก ${retryTool} อีกครั้ง`,
    },
    import_bytes_hourly_limit: {
      message: `นำเข้าไฟล์รวมครบ ${perHour} ในหนึ่งชั่วโมงแล้ว (import limit of ${perHour} per hour reached)`,
      next: `รอ${wait ?? "สักพัก (ไม่เกิน 1 ชั่วโมง)"} แล้วเรียก ${retryTool} อีกครั้ง หรือใช้ไฟล์ที่เล็กลง`,
    },
    import_bytes_daily_limit: {
      message: `นำเข้าไฟล์รวมครบ ${perDay} ใน 24 ชั่วโมงแล้ว (import limit of ${perDay} per 24 hours reached)`,
      next: `รอ${wait ?? "สักพัก (ไม่เกิน 24 ชั่วโมง)"} แล้วเรียก ${retryTool} อีกครั้ง หรือใช้ไฟล์ที่เล็กลง`,
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
