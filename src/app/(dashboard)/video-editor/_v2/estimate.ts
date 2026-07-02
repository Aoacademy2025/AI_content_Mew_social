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
