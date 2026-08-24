// เฉพาะเส้นทาง "เสียงโคลน" (user_* voices) เท่านั้น — ก่อนส่งสคริปต์เข้า TTS
// ให้ Gemini แปลงข้อความเป็นภาษาไทยล้วนสำหรับอ่านออกเสียง (ทับศัพท์คำต่างชาติ,
// เลข/สัญลักษณ์เป็นคำอ่านไทย) เพราะโมเดลโคลนอ่านตัวอักษรละติน/เลขจากเสียง
// อ้างอิงภาษาไทยไม่ได้ ผลคือข้ามคำหรืออ่านเพี้ยน
// ห้าม import จากงานเสียงปกติ (Hero Voice preset) — สโคปนี้เป็นของโคลนเท่านั้น

import { geminiGenerateText } from "@/lib/gemini";
import { resolveGeminiKey } from "@/lib/gemini-key";

const PROMPT_HEADER = `แปลงข้อความต่อไปนี้ให้เป็น "ภาษาไทยล้วนสำหรับอ่านออกเสียง" ตามกฎเคร่งครัด:
1. คำภาษาอังกฤษ/ภาษาต่างประเทศ → เขียนทับศัพท์เป็นคำอ่านภาษาไทย (เช่น "marketing" → "มาร์เก็ตติ้ง", "AI" → "เอไอ") ห้ามแปลความหมาย
2. ตัวเลข เปอร์เซ็นต์ สกุลเงิน วันที่ เวลา → เขียนเป็นคำอ่านภาษาไทย (เช่น "25%" → "ยี่สิบห้าเปอร์เซ็นต์")
3. คำภาษาไทยเดิม ลำดับคำ และเครื่องหมายวรรคตอน คงไว้ทุกตัว ห้ามเพิ่ม ห้ามตัด ห้ามเรียบเรียงใหม่
4. ตอบเฉพาะข้อความที่แปลงแล้วเท่านั้น ห้ามมีคำอธิบายหรือหมายเหตุใด ๆ

ข้อความ:
`;

/**
 * Fail-open เสมอ: ไม่มี Gemini key / เรียกล่ม / คำตอบดูเพี้ยน → คืนข้อความเดิม
 * เพื่อไม่ให้ขั้นเสริมนี้กลายเป็นจุดพังใหม่ของการโคลนเสียง
 */
export async function thaiifyCloneScript(
  user: { geminiKey: string | null; plan: string },
  text: string,
): Promise<string> {
  const source = text.trim();
  if (!source) return text;
  try {
    const { key } = resolveGeminiKey(user);
    const converted = (await geminiGenerateText(key, `${PROMPT_HEADER}${source}`, 4096)).trim();
    if (!converted) return text;
    // sanity guard: ความยาวหลุดช่วงสมเหตุสมผล = โมเดลตอบนอกสคริปต์ → ทิ้ง
    if (converted.length < source.length * 0.5 || converted.length > source.length * 3) {
      console.warn(`[clone-thai] length guard rejected (${source.length} -> ${converted.length} chars)`);
      return text;
    }
    return converted;
  } catch (error) {
    console.warn("[clone-thai] thaiify skipped:", error instanceof Error ? error.message : error);
    return text;
  }
}
