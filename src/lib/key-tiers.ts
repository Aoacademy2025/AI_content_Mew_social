export type KeyId = "gemini" | "pexels" | "pixabay" | "elevenlabs" | "heygen" | "kie" | "unsplash" | "flickr";
export type KeyTier = "required" | "advanced" | "admin";
export type ApiKeysField = "geminiKey" | "pexelsKey" | "pixabayKey" | "elevenlabsKey" | "heygenKey" | "kieKey" | "unsplashKey" | "flickrKey";

export interface KeyDef {
  id: KeyId;
  apiKeysField: ApiKeysField;
  testKeyType: string;          // body.keyType สำหรับ POST /api/user/test-key
  tier: KeyTier;
  group: "gemini" | "stock" | "voice" | "avatar" | "image";
  label: string;
  desc: string;                 // คำอธิบาย 1 บรรทัด (ภาษาคน)
  skipNote?: string;            // ป้าย "ไม่ใส่ก็ใช้งานได้" สำหรับ tier advanced
  getUrl: string;
  free: boolean;
  adminOnly?: boolean;          // tier "admin" — ทดลองภายใน, ซ่อนจาก user ทั่วไป + ไม่อยู่ใน onboarding
}

export const KEY_TIERS: KeyDef[] = [
  {
    id: "gemini", apiKeysField: "geminiKey", testKeyType: "gemini",
    tier: "required", group: "gemini",
    label: "Gemini API Key",
    desc: "สมองของระบบ — เขียน/วิเคราะห์สคริปต์, เสียงพากย์ AI และหาคีย์เวิร์ด B-roll",
    getUrl: "https://aistudio.google.com/app/apikey", free: true,
  },
  {
    id: "pexels", apiKeysField: "pexelsKey", testKeyType: "pexels",
    tier: "required", group: "stock",
    label: "Pexels API Key",
    desc: "คลังวิดีโอ B-roll ฟรี — ไม่มี B-roll = วิดีโอไม่มีภาพประกอบ",
    getUrl: "https://www.pexels.com/api/", free: true,
  },
  {
    id: "pixabay", apiKeysField: "pixabayKey", testKeyType: "pixabay",
    tier: "required", group: "stock",
    label: "Pixabay API Key",
    desc: "คลังวิดีโอ B-roll ฟรี (อีกแหล่ง) — มี Pexels หรือ Pixabay อย่างน้อย 1 ก็พอ",
    getUrl: "https://pixabay.com/api/docs/", free: true,
  },
  {
    id: "elevenlabs", apiKeysField: "elevenlabsKey", testKeyType: "elevenlabs",
    tier: "advanced", group: "voice",
    label: "ElevenLabs API Key",
    desc: "เสียงพากย์โคลน/พรีเมียม",
    skipNote: "ไม่ใส่ก็ใช้งานได้ — ระบบใช้เสียง Gemini แทน",
    getUrl: "https://elevenlabs.io/app/settings/api-keys", free: false,
  },
  {
    id: "heygen", apiKeysField: "heygenKey", testKeyType: "heygen",
    tier: "advanced", group: "avatar",
    label: "HeyGen API Key",
    desc: "พิธีกร AI (avatar) ในคลิป",
    skipNote: "ไม่ใส่ก็ใช้งานได้ — คลิปจะเป็นเสียง + ภาพ B-roll ปกติ",
    getUrl: "https://app.heygen.com/settings?nav=API", free: false,
  },
  // tier "admin" — แหล่งภาพ B-roll ทดลอง (kie.ai AI image + Unsplash/Flickr photo fallback).
  // adminOnly: ซ่อนจาก user ทั่วไป + ไม่อยู่ใน onboarding (REQUIRED/ADVANCED filter ไม่ดึง tier นี้).
  {
    id: "kie", apiKeysField: "kieKey", testKeyType: "kie",
    tier: "admin", group: "image", adminOnly: true,
    label: "kie.ai API Key",
    desc: "AI Image-to-Video (GPT Image + Kling) — แม่นยำกว่า stock, ผู้ใช้จ่ายเครดิตเอง",
    getUrl: "https://kie.ai/api-key", free: false,
  },
  {
    id: "unsplash", apiKeysField: "unsplashKey", testKeyType: "unsplash",
    tier: "admin", group: "image", adminOnly: true,
    label: "Unsplash Access Key",
    desc: "แหล่งภาพ B-roll สำรอง (Ken Burns)",
    getUrl: "https://unsplash.com/oauth/applications", free: true,
  },
  {
    id: "flickr", apiKeysField: "flickrKey", testKeyType: "flickr",
    tier: "admin", group: "image", adminOnly: true,
    label: "Flickr API Key",
    desc: "แหล่งภาพ B-roll สำรอง — Creative Commons (Ken Burns)",
    getUrl: "https://www.flickr.com/services/apps/create/apply/", free: true,
  },
];

export type KeyStatus = Record<KeyId, boolean> & { tier1Complete: boolean };

export function isTier1Complete(s: { gemini: boolean; pexels: boolean; pixabay: boolean }): boolean {
  return s.gemini && (s.pexels || s.pixabay);
}

export function computeKeyStatus(present: Partial<Record<KeyId, boolean>>, isManagedMode = false): KeyStatus {
  const base = {
    gemini: !!present.gemini || isManagedMode, pexels: !!present.pexels, pixabay: !!present.pixabay,
    elevenlabs: !!present.elevenlabs, heygen: !!present.heygen,
    kie: !!present.kie, unsplash: !!present.unsplash, flickr: !!present.flickr,
  };
  return { ...base, tier1Complete: isTier1Complete(base) };
}

export const REQUIRED_KEYS = KEY_TIERS.filter((k) => k.tier === "required");
export const ADVANCED_KEYS = KEY_TIERS.filter((k) => k.tier === "advanced");

export function requiredKeysFor(managed: boolean): KeyDef[] {
  return REQUIRED_KEYS.filter((k) => !(managed && k.id === "gemini"));
}

/**
 * What the dashboard's key checklist should show — pure, so the "no key needed"
 * case is a tested invariant rather than a JSX accident.
 *
 * With MANAGED_STOCK on (#297 Amendment 2026-08-26) the stock key stops being a
 * requirement for EVERY plan, and with MANAGED_GEMINI on Gemini is server-side
 * too. When both hold, an account needs no key at all and `render` is false —
 * the card must not present a blocker that no longer exists.
 */
export type KeySetupChecklistPlan = {
  /** false → render nothing. */
  render: boolean;
  geminiRequired: boolean;
  stockRequired: boolean;
  stockDone: boolean;
  totalRequired: number;
  doneCount: number;
};

export function planKeySetupChecklist(input: {
  status: Pick<KeyStatus, "gemini" | "pexels" | "pixabay" | "tier1Complete">;
  managedGemini: boolean;
  managedStock: boolean;
}): KeySetupChecklistPlan {
  const stockDone = input.status.pexels || input.status.pixabay;
  const geminiRequired = !input.managedGemini;
  const stockRequired = !input.managedStock;
  const totalRequired = (geminiRequired ? 1 : 0) + (stockRequired ? 1 : 0);
  const doneCount = (geminiRequired && input.status.gemini ? 1 : 0) + (stockRequired && stockDone ? 1 : 0);
  return {
    render: !input.status.tier1Complete && totalRequired > 0 && doneCount < totalRequired,
    geminiRequired,
    stockRequired,
    stockDone,
    totalRequired,
    doneCount,
  };
}
