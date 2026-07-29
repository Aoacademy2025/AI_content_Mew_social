import { geminiGenerateText } from "@/lib/gemini";
import { resolveGeminiKey } from "@/lib/gemini-key";
import { reserveAiTextCall } from "@/lib/ai-text-limits";

// Silent pre-TTS polish: rewrite the script for read-aloud flow BEFORE it is
// chunked/normalized, so the polished text is the single source for BOTH the
// spoken audio and the timing segments (subtitles) — the iron rule (spoken ==
// displayed) holds because everything downstream derives from one string.
//
// FAIL-OPEN at every step: no Gemini key, quota hit, timeout, or a degenerate
// rewrite → the original script is used untouched. Generation must never
// break because of this enhancement.

const POLISH_TIMEOUT_MS = 25_000;

const POLISH_PROMPT_HEADER = `คุณคือผู้กำกับเสียง (voice director) มืออาชีพ เกลาสคริปต์ภาษาไทยข้างล่างให้เหมาะกับการอ่านออกเสียงด้วย AI

━━━ สิ่งที่ต้องทำ ━━━
1. คงความหมาย ข้อเท็จจริง ตัวเลข และชื่อเฉพาะเดิมทุกจุด — ห้ามเพิ่มข้อมูลใหม่ ห้ามตัดสาระทิ้ง
2. ปรับคำที่อ่านออกเสียงยากหรือกำกวมให้ลื่นขึ้น (ภาษาพูดที่เป็นธรรมชาติ)
3. เขียนตัวย่อทุกตัวเป็นคำเต็มที่ใช้อ่านออกเสียง เช่น จนท. → เจ้าหน้าที่ · รพ. → โรงพยาบาล · ตร. → ตำรวจ · กทม. → กรุงเทพมหานคร · ปชช. → ประชาชน · ชม. → ชั่วโมง · ชื่อเดือนย่อ (ก.ค. → กรกฎาคม) — ห้ามเหลือตัวย่อที่ลงท้ายด้วยจุดในผลลัพธ์
4. แบ่งจังหวะหายใจด้วยการขึ้นบรรทัดใหม่ — หนึ่งบรรทัดต่อหนึ่งประโยคหรือหนึ่งใจความ
5. ประโยคยาวเกินหนึ่งลมหายใจ ให้แตกเป็นวลีสั้น ๆ คั่นด้วยเว้นวรรค
6. ความยาวโดยรวมต้องใกล้เคียงต้นฉบับ (±20%)

━━━ ข้อห้าม ━━━
- ห้ามใส่ markdown หัวข้อ อีโมจิ เครื่องหมาย / หรือคำอธิบายใด ๆ
- ห้ามใส่คำนำหน้าเช่น "สคริปต์:" — ตอบกลับเป็นเนื้อสคริปต์ล้วน ๆ เท่านั้น

SCRIPT:
`;

export interface TtsScriptPolishResult {
  text: string;
  polished: boolean;
}

export async function polishScriptForTts(
  user: { id: string; geminiKey: string | null; plan: string },
  text: string,
  maxChars: number,
): Promise<TtsScriptPolishResult> {
  const original = { text, polished: false };
  try {
    const { key, mode } = resolveGeminiKey(user); // throws when no key → fail-open
    const textReserve = await reserveAiTextCall(user.id, { enforce: mode === "managed" });
    if (!textReserve.allowed) return original;

    const raw = await Promise.race([
      geminiGenerateText(key, `${POLISH_PROMPT_HEADER}${text}`, 8192, 0.4),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("tts polish timeout")), POLISH_TIMEOUT_MS);
      }),
    ]);
    const polished = raw.trim();
    if (!polished) return original;
    // A rewrite that balloons, collapses, or busts the plan cap means the
    // model ignored the brief — keep the user's own words instead.
    if (polished.length > maxChars) return original;
    if (polished.length > text.length * 2 || polished.length < text.length * 0.4) return original;
    return { text: polished, polished: true };
  } catch {
    return original;
  }
}
