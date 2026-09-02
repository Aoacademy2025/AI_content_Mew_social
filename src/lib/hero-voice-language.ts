import type { OmniVoiceInfo } from "@/lib/tts-providers";

/** ภาษาที่ Hero Voice อ่านได้ — ตรงกับ `language` ที่ /api/videos/tts-omnivoice รับ */
export type HeroVoiceLanguage = "th" | "lo";

export const HERO_VOICE_LANGUAGE_OPTIONS: ReadonlyArray<{ value: HeroVoiceLanguage; label: string; short: string }> = [
  { value: "th", label: "🇹🇭 ไทย", short: "ไทย" },
  { value: "lo", label: "🇱🇦 ลาว", short: "ลาว" },
];

export function parseHeroVoiceLanguage(value: unknown): HeroVoiceLanguage {
  return value === "lo" ? "lo" : "th";
}

/**
 * อ่านภาษาที่ "แคตตาล็อกกำหนดไว้" ให้เสียงหนึ่งตัว
 *
 * worker ส่งมาเป็นชื่อเต็มแบบที่โมเดลใช้ ("Thai" / "Lao") ส่วน UI ใช้โค้ดสั้น
 * คืน null = เสียงกลาง ไม่ได้ผูกภาษา (ค่า `null` จากแคตตาล็อก หรือ worker
 * รุ่นเก่าที่ไม่มีฟิลด์นี้เลย)
 */
export function voiceCatalogLanguage(value: unknown): HeroVoiceLanguage | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (key === "lao" || key === "lo") return "lo";
  if (key === "thai" || key === "th") return "th";
  return null;
}

/** เสียงโคลนของผู้ใช้เอง (user_* / cv_*) — เสียงคนจริงที่อัปมาเอง ไม่ผูกภาษา
 *  จึงอยู่ในคลังทั้งไทยและลาว */
function isCloneVoice(voiceId: string): boolean {
  return voiceId.startsWith("user_") || voiceId.startsWith("cv_");
}

/**
 * เสียงสำเนียงต่างชาติ — `instruct` เขียนเป็นภาษาอังกฤษเสมอ (เช่น "female,
 * british accent") จึงเช็คจากคำว่า accent ได้ตรง ๆ ไม่ต้อง hardcode voice_id
 */
function hasForeignAccent(instruct: string): boolean {
  return /\baccent\b/i.test(instruct);
}

/**
 * กรองคลังเสียงตามภาษาที่จะให้อ่าน
 *
 * ลำดับการตัดสิน:
 * 1. **เสียงโคลนของผู้ใช้** — อยู่ทุกคลัง เป็นเสียงคนจริงที่อัปเอง ไม่ผูกภาษา
 * 2. **เสียงที่แคตตาล็อกกำกับภาษาไว้** (`language: "Lao"` / `"Thai"`) — เข้าเฉพาะ
 *    คลังภาษานั้น ห้ามข้ามคลังเด็ดขาด
 * 3. **เสียงกลาง (`language` = null)** — ขึ้นกับว่าภาษานั้นมีเสียงเฉพาะของตัวเองแล้วหรือยัง
 *    - มีแล้ว (เช่นคลังลาวที่มี lao_01..lao_07) → **ไม่ปนเสียงกลางเข้ามา** คลังจะได้
 *      แยกจากกันจริง ไม่ใช่ไทย 33 + ลาว 7 = ลาว 40
 *    - ยังไม่มี → ใช้เสียงกลางไปก่อน ไม่งั้นคลังจะว่างเปล่าใช้งานไม่ได้เลย
 *      (คลังไทยเข้าครบทุกตัว ส่วนคลังลาวตัดเสียงสำเนียงต่างชาติออก เพราะสำเนียง
 *      อังกฤษ/เกาหลี/จีน ทับข้อความลาวแล้วฟังไม่ได้)
 */
export function heroVoicesForLanguage<T extends Pick<OmniVoiceInfo, "voice_id" | "instruct" | "language">>(
  voices: readonly T[],
  language: HeroVoiceLanguage,
): T[] {
  const hasDedicatedVoices = voices.some((voice) => voiceCatalogLanguage(voice.language) === language);
  return voices.filter((voice) => {
    if (isCloneVoice(voice.voice_id)) return true;
    const tagged = voiceCatalogLanguage(voice.language);
    if (tagged) return tagged === language;
    if (hasDedicatedVoices) return false;
    if (language === "th") return true;
    return !hasForeignAccent(voice.instruct);
  });
}

/** true = คลังของสองภาษาเป็น "ชุดเดียวกันจริง ๆ" (สมาชิกตรงกันทุกตัว)
 *  ใช้ให้ UI เลิกโฆษณาว่าเป็น "คนละคลัง" ทั้งที่รายการเหมือนกันเป๊ะ
 *
 *  ต้องเทียบตัวตน ไม่ใช่จำนวน — แคตตาล็อกที่กำกับเสียงลาว 1 ตัวและเสียงไทย 1 ตัว
 *  จะได้คลังละเท่ากันแต่คนละชุด ซึ่งเป็นการแยกที่ควรบอกผู้ใช้ */
export function heroVoiceCatalogsAreIdentical<T extends Pick<OmniVoiceInfo, "voice_id" | "instruct" | "language">>(
  voices: readonly T[],
): boolean {
  const th = heroVoicesForLanguage(voices, "th");
  const lo = heroVoicesForLanguage(voices, "lo");
  if (th.length !== lo.length) return false;
  const loIds = new Set(lo.map((voice) => voice.voice_id));
  return th.every((voice) => loIds.has(voice.voice_id));
}
