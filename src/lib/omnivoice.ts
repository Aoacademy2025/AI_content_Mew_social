/**
 * OmniVoice TTS — self-hosted voice server (FastAPI, see API_DOCS.md ฝั่ง omnivoice repo).
 * ไม่ใช่ BYOK: server เป็นของระบบเอง ผู้ใช้ทุกคนเรียกผ่าน proxy ของเราได้เลย
 * URL ตั้งผ่าน env OMNIVOICE_URL (default = dev localhost)
 */

export function omnivoiceBaseUrl(): string {
  return (process.env.OMNIVOICE_URL || "http://localhost:8000").replace(/\/+$/, "");
}

/** Header สำหรับเรียก OmniVoice server — ทุก endpoint ยกเว้น /health ต้องใช้ */
export function omnivoiceAuthHeaders(): Record<string, string> {
  const key = process.env.OMNIVOICE_API_KEY;
  return key ? { "X-API-Key": key } : {};
}

export interface OmniVoiceInfo {
  voice_id: string;
  desc: string;
  instruct: string;
  preview_url: string;
}

export interface OmniTtsResponse {
  voice_id: string;
  text: string;
  audio_base64: string;
  format: string;       // "wav"
  sample_rate: number;  // 24000
  duration: number;     // seconds
  generation_time: number;
}

/** voice_id จากภายนอกต้อง sanitize ก่อนต่อเข้า URL (กัน path traversal ไปยัง server ภายใน) */
export function isValidOmniVoiceId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

const THAI_DIGITS = ["ศูนย์", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"];

/** เลขไทยแบบอ่านทีละหลัก (เช่น "ซอย 15" → "หนึ่งห้า") ตรงกับที่คนไทยอ่านเลขที่/ซอย/รหัส */
function digitsToThaiWords(digits: string): string {
  return digits.split("").map((d) => THAI_DIGITS[Number(d)]).join("");
}

// คำนำหน้าที่คนไทยอ่านเลขต่อท้ายทีละหลัก (ระบุตำแหน่ง/รหัส ไม่ใช่ปริมาณ) — ตรงข้ามกับ
// ปี/เดือน/เวลา/จำนวนที่อ่านเป็นเลขรวม ต้อง whitelist เพราะแยกด้วย pattern ทั่วไปไม่ได้
const DIGIT_BY_DIGIT_PREFIXES = ["ซอย", "เลขที่", "ห้อง", "ชั้น", "แยก", "ถนน", "ทางหลวง"];
const DIGIT_BY_DIGIT_RE = new RegExp(
  `(${DIGIT_BY_DIGIT_PREFIXES.join("|")})(\\s*)(\\d+)(?!\\.\\d|[:\\d])`,
  "g",
);

/**
 * OmniVoice (เหมือน TTS หลายตัว) ออกเสียงเลขอารบิกเดี่ยวๆที่แปะอยู่ติดคำไทยผิด
 * (พบจริง: "ซอย 1" → "ซอยมน") — แปลงเป็นคำไทยทีละหลักก่อนส่งเข้าโมเดลเพื่อเลี่ยงจุดที่ตีความผิด
 * จำกัดเฉพาะคำนำหน้าที่รู้ชัดว่าอ่านทีละหลัก (ซอย/เลขที่/ห้อง ฯลฯ) — ไม่แตะปี/เดือน/เวลา/
 * จำนวนนับที่อ่านเป็นเลขรวม (เช่น "ปี 2568", "100 คน") เพราะกฎการอ่านตรงข้ามกัน
 */
export function normalizeNumbersForTts(text: string): string {
  return text.replace(DIGIT_BY_DIGIT_RE, (_m, prefix: string, space: string, digits: string) => `${prefix}${space}${digitsToThaiWords(digits)}`);
}

/**
 * แกะ PCM ออกจาก WAV buffer โดย walk RIFF chunks จริง (header ไม่ใช่ 44 bytes เสมอ)
 * คืน sampleRate จาก fmt chunk ด้วย — ใช้คำนวณ duration แบบ arithmetic
 */
export function pcmFromWav(wav: Buffer): { pcm: Buffer; sampleRate: number } {
  let sampleRate = 24000;
  if (wav.length >= 12 && wav.toString("ascii", 0, 4) === "RIFF" && wav.toString("ascii", 8, 12) === "WAVE") {
    let off = 12;
    let pcm: Buffer | null = null;
    while (off + 8 <= wav.length) {
      const id = wav.toString("ascii", off, off + 4);
      const size = wav.readUInt32LE(off + 4);
      if (id === "fmt " && off + 8 + 16 <= wav.length) sampleRate = wav.readUInt32LE(off + 12);
      if (id === "data") { pcm = wav.subarray(off + 8, Math.min(off + 8 + size, wav.length)); break; }
      off += 8 + size + (size % 2); // chunks are word-aligned
    }
    if (pcm) return { pcm, sampleRate };
  }
  // ไม่ใช่ RIFF มาตรฐาน → เดา 44-byte header (layout ที่ server เราเขียนเอง)
  return { pcm: wav.subarray(44), sampleRate };
}
