import { cleanScriptLine } from "../_lib/preprocess-script";
import { planAutoMixSources } from "@/lib/automix-plan";

/** b-roll window length (วิ/ช่วง) — SAME knob the real window planner reads
 *  (video-editor/page.tsx:56, mcp/orchestrator.ts). Default 4. Keeping the estimator on
 *  this knob stops the Receipt's credit estimate from drifting from the actual planner. */
const BROLL_WINDOW_SEC = Number(process.env.NEXT_PUBLIC_BROLL_WINDOW_SEC) || 4;

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
 * จำนวนภาพ AI ที่ AutoMix จะสร้างจริงต่อ 1 คลิป — PURE (ไม่มี side effect, ไม่มี hook).
 *
 * b-roll แบ่งเป็น "windows" ตาม NEXT_PUBLIC_BROLL_WINDOW_SEC (default 4 — ตรงกับ window
 * planner จริง) แล้ว **เรียก planAutoMixSources ตัวเดียวกับที่ server ใช้วางแผน slot**
 * (reserve 1 slot/แหล่ง แล้วค่อยกระจายที่เหลือตามน้ำหนัก) จึงนับ slot "ai" ได้ตรงกับที่
 * fetch-stock จะหักเครดิตจริง — สูตรเดิม (ceil(windows × ai/total)) เพี้ยนจากแผนจริงได้
 * เช่น 60 วิ preset "AI เด่น" (1:1:2) เดิมได้ 8 ภาพ แต่ planner สร้างจริง 7 ภาพ.
 *
 * @param estSec    ความยาวคลิปโดยประมาณ (วินาที) — จาก estimateClipSecV2
 * @param preset    น้ำหนัก {video,photo,ai} ของ preset ที่เลือก
 * @param windowSec ความยาว window (วิ) — default = NEXT_PUBLIC_BROLL_WINDOW_SEC (ทดสอบ override ได้)
 */
export function estimateAutoMixAiImageCount(
  estSec: number,
  preset: { video: number; photo: number; ai: number },
  windowSec: number = BROLL_WINDOW_SEC,
): number {
  const secPerWindow = windowSec > 0 ? windowSec : 4;
  const windows = Math.max(0, Math.ceil(estSec / secPerWindow));
  if (windows === 0 || preset.ai <= 0) return 0;
  return planAutoMixSources(windows, preset).filter((source) => source === "ai").length;
}

/**
 * ประมาณเครดิตที่ preset "ผสม AI" จะใช้ต่อ 1 คลิป — PURE.
 * ใช้โดยจอ Render Receipt (Task 5) และ label ปุ่ม preset.
 *
 * เครดิต = จำนวนภาพ AI ตามแผนจริง × เครดิตต่อภาพ (Hero AI Image — HERO_AI_IMAGE_CREDITS).
 *
 * @param perImageCredits  เครดิตต่อภาพ AI 1 รูป
 */
export function estimatePresetCredits(
  estSec: number,
  preset: { video: number; photo: number; ai: number },
  perImageCredits: number,
  windowSec: number = BROLL_WINDOW_SEC,
): number {
  return estimateAutoMixAiImageCount(estSec, preset, windowSec) * perImageCredits;
}

/**
 * จำนวนภาพ AI ที่ "แจ้งผู้ใช้ไปแล้ว" ใน Render Receipt — SINGLE SOURCE ของตัวเลขที่
 * disclose. ใช้ทั้งใน receipt (แสดงผล) และ useV2Job (ส่งเป็นเพดาน `maxAiImages` ให้ server)
 * เพื่อไม่ให้ตัวเลขที่ผู้ใช้เห็นกับเพดานที่หักเงินจริงหลุดจากกัน:
 * - กำหนดจำนวนคลิปเอง (targetClipCount > 0) → วางแผนจากจำนวนชิ้นนั้นตรง ๆ
 * - อัตโนมัติ → ประมาณจากความยาวคลิป (window cadence)
 */
export function disclosedAutoMixAiImageCount(
  estSec: number,
  preset: { video: number; photo: number; ai: number },
  targetClipCount = 0,
  windowSec: number = BROLL_WINDOW_SEC,
): number {
  const manualPieceCount = Number.isFinite(targetClipCount) && targetClipCount > 0
    ? Math.min(60, Math.floor(targetClipCount))
    : 0;
  if (manualPieceCount > 0) {
    if (preset.ai <= 0) return 0;
    return planAutoMixSources(manualPieceCount, preset).filter((source) => source === "ai").length;
  }
  return estimateAutoMixAiImageCount(estSec, preset, windowSec);
}

/**
 * Hero AI Image default count (Task 5, D8) — PURE. When the user has not set a
 * custom count yet (0/unset), default to 8 (mode "กำหนดเอง") so the very first
 * disclosed number is a concrete, budget-safe quote instead of an open-ended
 * "อัตโนมัติ" estimate. Any positive count already chosen is left untouched.
 */
export function heroDefaultTargetClipCount(current: number): number {
  return Number.isFinite(current) && current > 0 ? Math.floor(current) : 8;
}

/**
 * เวลาที่แต่ละภาพค้างจอโดยประมาณ (วิ) = ความยาวคลิป / จำนวนภาพ — PURE.
 * ใช้เตือนผู้ใช้เมื่อเลือกจำนวนภาพน้อยเกินไปเทียบกับความยาวคลิป (Task 5 ข้อ 6).
 * n<=0 หรือ durationSec ติดลบ → 0 (กัน divide-by-zero / ผลลัพธ์ไม่มีความหมาย).
 */
export function heroHoldLengthSec(durationSec: number, n: number): number {
  if (!(n > 0) || !(durationSec >= 0)) return 0;
  return Math.round(durationSec / n);
}
