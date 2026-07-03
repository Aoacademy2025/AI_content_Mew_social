import { cleanScriptLine } from "../_lib/preprocess-script";

/**
 * v2 display estimates — นับจากข้อความที่ CLEAN แล้ว (ตรงกับสิ่งที่ TTS จะอ่านจริง)
 *
 * อัตราพูด: legacy `estimateScriptDurationSec` (~2 ตัวอักษรไทย/วิ) เป็นสูตร "เผื่อเกิน"
 * ไว้คำนวณจำนวน keyword — เผื่อจริง ~6× จนเคยทำ duration gate ผิดมาแล้ว (ถูกถอดออก)
 * จอ v2 ต้องโชว์ความยาวคลิปที่ใกล้จริง: ~11 ตัวอักษรไทย/วิ + ~2.5 คำอังกฤษ/วิ
 * (ค่าโดยประมาณ — ความยาวจริงรู้หลัง TTS เสมอ)
 */

export function cleanForCount(text: string): string {
  return text.split("\n").map(cleanScriptLine).join(" ").trim();
}

/** ความยาวคลิป (วินาที) โดยประมาณของข้อความ 1 ก้อน (clean ก่อนนับ) */
export function estimateClipSecV2(text: string): number {
  const cleaned = cleanForCount(text);
  const thaiChars = (cleaned.match(/[฀-๿]/g) ?? []).length;
  const engWords = cleaned.replace(/[฀-๿]/g, " ").split(/\s+/).filter(Boolean).length;
  return thaiChars / 11 + engWords / 2.5;
}

/** จำนวน "คำ" โดยประมาณ (ไทย ≈ 4 ตัวอักษร/คำ) จากข้อความที่ clean แล้ว */
export function countWordsV2(text: string): number {
  const cleaned = cleanForCount(text);
  const thaiChars = (cleaned.match(/[฀-๿]/g) ?? []).length;
  const engWords = cleaned.replace(/[฀-๿]/g, " ").split(/\s+/).filter(Boolean).length;
  return Math.round(thaiChars / 4) + engWords;
}

/**
 * ประมาณเครดิตที่ preset "ผสม AI" จะใช้ต่อ 1 คลิป — PURE (ไม่มี side effect, ไม่มี hook).
 * ใช้โดยจอ Render Receipt (Task 5) และ label ปุ่ม preset.
 *
 * b-roll แบ่งเป็น "windows" ~4 วิ/ช่วง (ตรงกับ NEXT_PUBLIC_BROLL_WINDOW_SEC=4 ของ
 * pipeline); สัดส่วนที่เป็นภาพ AI = ai / (video+photo+ai) (กัน div-by-zero: ถ้าน้ำหนัก
 * รวมเป็น 0 → share = 0); เครดิต = ceil(windows × share) × เครดิตต่อภาพ.
 *
 * @param estSec           ความยาวคลิปโดยประมาณ (วินาที) — จาก estimateClipSecV2
 * @param preset           น้ำหนัก {video,photo,ai} ของ preset ที่เลือก
 * @param perImageCredits  เครดิตต่อภาพ AI 1 รูป (ตามโมเดล kie ที่ใช้)
 */
export function estimatePresetCredits(
  estSec: number,
  preset: { video: number; photo: number; ai: number },
  perImageCredits: number,
): number {
  const windows = Math.ceil(estSec / 4);
  const totalWeight = preset.video + preset.photo + preset.ai;
  const aiShare = totalWeight === 0 ? 0 : preset.ai / totalWeight;
  return Math.ceil(windows * aiShare) * perImageCredits;
}
