import type { OmniVoiceInfo } from "@/lib/tts-providers";
import voiceManifest from "../../services/omnivoice-runpod/assets/voices/voices.json";

export type RunpodHeroVoicePreview = {
  voiceId: string;
  desc: string;
  instruct: string;
  filename: string;
};

// upstream 10649b5: preview_text ถูกถอดออกจาก manifest — พรีวิวสตรีมไฟล์ ref โดยตรง
export const RUNPOD_HERO_VOICE_PREVIEWS: readonly RunpodHeroVoicePreview[] = voiceManifest.map((voice) => ({
  voiceId: voice.id,
  desc: voice.desc,
  instruct: voice.instruct,
  filename: voice.ref_audio,
}));

const previewByVoiceId = new Map<string, RunpodHeroVoicePreview>(
  RUNPOD_HERO_VOICE_PREVIEWS.map((voice) => [voice.voiceId, voice]),
);

// บรีฟสั้นๆ ของแต่ละเสียง (เขียนจาก instruct ใน manifest) — โชว์ตัวเล็กใต้ชื่อใน dropdown
// เป็นข้อมูลฝั่งแอปล้วนๆ ไม่แตะ manifest ที่ sync มาจาก upstream
const VOICE_BRIEFS: Record<string, string> = {
  voice_01: "ชายหนุ่ม โทนปกติ เป็นกันเอง",
  voice_02: "หญิงสาว โทนปกติ สุภาพ",
  voice_03: "ชายเสียงสูง สดใส กระตือรือร้น",
  voice_04: "หญิงเสียงต่ำ นุ่มนวล น่าเชื่อถือ",
  voice_05: "ชายเสียงต่ำมาก หนักแน่น ทรงพลัง",
  voice_06: "หญิงเสียงสูงมาก สดใส ร่าเริง",
  voice_07: "เด็กเล็ก น่ารัก ไร้เดียงสา",
  voice_08: "วัยรุ่นหญิง สดใส เป็นธรรมชาติ",
  voice_09: "วัยรุ่นชาย มีพลัง กระฉับกระเฉง",
  voice_10: "หญิงวัยทำงาน มั่นใจ มืออาชีพ",
  voice_11: "ชายวัยทำงาน มั่นใจ คล่องแคล่ว",
  voice_12: "ชายวัยกลางคน สุขุม น่าเชื่อถือ",
  voice_13: "หญิงวัยกลางคน อบอุ่น เป็นผู้ใหญ่",
  voice_14: "ลุงสูงวัย อบอุ่น ใจดี",
  voice_15: "ยายสูงวัย ใจดี เหมือนเล่านิทาน",
  voice_17: "เด็กชาย ซุกซน สดใส",
  voice_18: "เด็กหญิง น่ารัก อ่อนหวาน",
  voice_19: "ชาย โทนกลาง เรียบนิ่ง ฟังง่าย",
  voice_20: "หญิง โทนกลาง เรียบร้อย ชัดเจน",
  voice_21: "วัยรุ่นชาย เสียงสูง สนุกสนาน",
  voice_22: "ชายหนุ่ม เสียงต่ำ นุ่มลึก เท่",
  voice_23: "หญิงสาว เสียงสูง สดใส มีชีวิตชีวา",
  voice_24: "ชายวัยกลางคน เสียงต่ำมาก ขรึม",
  voice_25: "ปู่สูงวัย เสียงต่ำลึก เหมือนผู้เฒ่าเล่าเรื่อง",
  voice_26: "ยายสูงวัย เสียงสูง กระฉับกระเฉง",
  voice_34: "วัยรุ่นหญิง เสียงต่ำ ชิลๆ สบายๆ",
  voice_35: "วัยรุ่นชาย โทนกลาง เป็นธรรมชาติ",
  voice_36: "หญิงวัยกลางคน เสียงสูง มีชีวิตชีวา",
  voice_37: "เด็กเล็ก เสียงสูงใส น่ารักมาก",
  voice_44: "ชายหนุ่ม เสียงสูงมาก ตื่นเต้น มีพลัง",
  voice_45: "หญิงสาว เสียงต่ำมาก นุ่มลึก มีเสน่ห์",
  voice_46: "ชายวัยกลางคน เสียงสูง กระตือรือร้น",
  voice_47: "ยายสูงวัย เสียงต่ำมาก ขรึม ใจเย็น",
  // คลังลาว (assets/voices_lao) — โผล่เฉพาะ backend ที่ดึงคลังสดจาก worker
  lao_01: "ชายลาว โทนปกติ เป็นกันเอง",
  lao_02: "หญิงลาว โทนปกติ สุภาพ",
  lao_03: "ชายลาววัยทำงาน มั่นใจ",
  lao_04: "หญิงลาว เสียงสูง สดใส",
  lao_05: "ชายลาวสูงวัย เสียงต่ำลึก ใจดี",
  lao_06: "วัยรุ่นหญิงลาว สดใส เป็นธรรมชาติ",
  lao_07: "หญิงลาววัยกลางคน สง่างาม",
};

/** บรีฟสั้นๆ ของเสียงสต็อก (ไทย + ลาว) — undefined ถ้าไม่รู้จัก voice id */
export function heroVoiceBrief(voiceId: string): string | undefined {
  return VOICE_BRIEFS[voiceId];
}

export const RUNPOD_HERO_VOICES: readonly OmniVoiceInfo[] = RUNPOD_HERO_VOICE_PREVIEWS.map((voice) => ({
  voice_id: voice.voiceId,
  desc: voice.desc,
  instruct: voice.instruct,
  brief: VOICE_BRIEFS[voice.voiceId],
  preview_url: `/api/omnivoice/preview/${encodeURIComponent(voice.voiceId)}`,
}));

/** Resolve only server-owned filenames from the fixed voice catalog. */
export function runpodHeroVoicePreviewFilename(voiceId: string): string | null {
  return previewByVoiceId.get(voiceId)?.filename ?? null;
}
