import type { BrandProfileForPrompt } from "@/lib/prompts/hero-script";

export interface HeroScriptQuickPreset {
  key: string;
  label: string;
  tagline: string;
  niche: string;
  audience: string;
  tone: string;
  defaultStructure: "how-to" | "story-lesson" | "myth-bust" | "pas" | "list";
  defaultCtaStyle: "follow" | "comment" | "share" | "sell";
}

/** Built-in writing presets for creators who have not configured a Brand Profile
 *  yet (or want a quick one-off style). Never persisted as BrandProfile rows. */
export const HERO_SCRIPT_QUICK_PRESETS: readonly HeroScriptQuickPreset[] = [
  {
    key: "howto-punchy",
    label: "สอนทำ-กระชับ",
    tagline: "ตัดน้ำ เน้นขั้นตอนทำตามได้ทันที",
    niche: "สอนทำและแชร์เทคนิคที่คนดูเอาไปใช้ได้ทันที",
    audience: "คนดูทั่วไปที่อยากได้วิธีแก้ปัญหาแบบเร็วและชัดเจน",
    tone: "กระชับ เป็นกันเอง อธิบายเรื่องยากให้เข้าใจง่าย ไม่เยิ่นเย้อ",
    defaultStructure: "how-to",
    defaultCtaStyle: "share",
  },
  {
    key: "story-insight",
    label: "เล่าเรื่อง-อินไซต์",
    tagline: "เปิดกลางเหตุการณ์ มีจุดพลิกและข้อคิด",
    niche: "เล่าเรื่องจริง ประสบการณ์ และบทเรียนชีวิตหรือการทำงาน",
    audience: "คนทำงานและคนรุ่นใหม่ที่ชอบฟังเรื่องเล่าได้แง่คิด",
    tone: "เล่าเหมือนเพื่อนคุยกัน เป็นธรรมชาติ มีจังหวะชวนติดตาม",
    defaultStructure: "story-lesson",
    defaultCtaStyle: "follow",
  },
  {
    key: "contrarian-viral",
    label: "ขัดความเชื่อ-ไวรัล",
    tagline: "เปิดประเด็นชวนคิดต่าง หยุดนิ้วแรง",
    niche: "ขยี้ความเชื่อผิด ๆ และเปิดมุมมองใหม่ที่คนส่วนใหญ่ไม่รู้",
    audience: "คนเล่นโซเชียลที่เบื่อคำแนะนำซ้ำ ๆ และชอบมุมคิดแหลมคม",
    tone: "ตรงไปตรงมา มั่นใจ ชวนถกเถียงอย่างมีเหตุผล ไม่กั๊ก",
    defaultStructure: "myth-bust",
    defaultCtaStyle: "comment",
  },
  {
    key: "soft-sell",
    label: "รีวิว-ขายเนียน",
    tagline: "เริ่มจากปัญหาจริง แล้วเชื่อมไปทางออก",
    niche: "รีวิวสินค้า บริการ และแก้ปัญหาที่คนดูเจอจริง",
    audience: "คนที่กำลังเจอปัญหาและมองหาตัวช่วยที่คุ้มค่า",
    tone: "จริงใจ เล่าจากมุมคนใช้จริง ไม่ขายตรงแบบยัดเยียด",
    defaultStructure: "pas",
    defaultCtaStyle: "sell",
  },
  {
    key: "trend-update",
    label: "ข่าว-อัปเดตเทรนด์",
    tagline: "สรุปประเด็นสำคัญใน 3 ข้อ ชัด ไว",
    niche: "สรุปข่าว เทรนด์ และเรื่องน่าจับตาที่กระทบคนดูโดยตรง",
    audience: "คนที่อยากรู้ทันเรื่องสำคัญแบบประหยัดเวลา",
    tone: "กระฉับกระเฉง ทันสมัย ชัดเจน ย่อยข้อมูลเก่ง",
    defaultStructure: "list",
    defaultCtaStyle: "comment",
  },
] as const;

const PRESET_BY_KEY = new Map<string, HeroScriptQuickPreset>(
  HERO_SCRIPT_QUICK_PRESETS.map((preset) => [preset.key, preset]),
);

export function isValidQuickStylePresetKey(key: unknown): key is string {
  return typeof key === "string" && PRESET_BY_KEY.has(key.trim());
}

export function getQuickStylePreset(key: string | null | undefined): HeroScriptQuickPreset | null {
  if (!key) return null;
  return PRESET_BY_KEY.get(key.trim()) ?? null;
}

export function quickStylePresetToBrandProfile(
  key: string | null | undefined,
): BrandProfileForPrompt | null {
  const preset = getQuickStylePreset(key);
  if (!preset) return null;
  return {
    niche: preset.niche,
    audience: preset.audience,
    tone: preset.tone,
    bannedWords: [],
    analysisNotes: `โทนพรีเซ็ต "${preset.label}": ${preset.tagline}`,
  };
}

export interface HeroScriptStarterTopic {
  topic: string;
  presetKey: string;
  durationSec: 30 | 60 | 90;
}

/** Curated starter topics so first-time or zero-brand creators can try the
 *  generator in one click without facing an empty blank box. */
export const HERO_SCRIPT_STARTER_TOPICS: readonly HeroScriptStarterTopic[] = [
  {
    topic: "ทำไมเงินเดือนขึ้นทุกปี แต่เงินเก็บไม่เคยเหลือถึงสิ้นเดือน",
    presetKey: "contrarian-viral",
    durationSec: 60,
  },
  {
    topic: "3 นิสัยตอนเช้าที่ทำให้เหนื่อยทั้งวันโดยไม่รู้ตัว",
    presetKey: "howto-punchy",
    durationSec: 30,
  },
  {
    topic: "สิ่งที่มือใหม่ทำคลิปสั้นมักพลาดใน 3 วินาทีแรก",
    presetKey: "story-insight",
    durationSec: 60,
  },
] as const;
