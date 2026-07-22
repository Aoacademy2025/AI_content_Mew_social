// mix-presets.ts — Editor v2 "Mix Preset" (D5.1): the 3 non-admin b-roll presets that
// decide how much AI vs stock is in the AutoMix. PURE data + tiny mappers (no hooks).
//
// A preset drives THREE things consistently (see useV2Project.setMixPreset):
//   1. the AutoMix WEIGHTS sent to the server (autoMixWeights) — honored only under
//      MANAGED_KIE, with ai force-zeroed for unauthorized users (fetch-stock),
//   2. the b-roll SOURCE (stock vs auto-mix),
//   3. the AutoMix PROVIDER set (any preset other than ฟรีล้วน includes "kie-ai").
// Admins do NOT use presets — they keep the raw provider checkboxes + model picker.

import type { AutoMixImageProvider } from "../_components/types";

export type MixPreset = "free" | "recommended" | "full";

/** น้ำหนัก video:photo:ai ต่อ preset (ตรงกับ brief D5.1). ทุกค่าเป็น int 0–9 (ผ่าน
 *  parseAutoMixWeights ฝั่ง server ได้). */
export const PRESET_WEIGHTS: Record<MixPreset, { video: number; photo: number; ai: number }> = {
  free: { video: 3, photo: 2, ai: 0 },
  recommended: { video: 3, photo: 2, ai: 1 },
  // AI-forward AutoMix still contains both stock video and stock photography.
  // Pure AI belongs to the separate Hero AI Image product.
  full: { video: 1, photo: 1, ai: 2 },
};

/** ผู้ให้บริการภาพ AutoMix ที่เปิดใช้ต่อ preset. `null` = ไม่ใช่ AutoMix (สต็อกฟรีล้วน →
 *  brollSource "stock"). preset ≠ ฟรีล้วน ทุกตัวรวม "kie-ai" เสมอ (brief ข้อ 5). */
export const PRESET_PROVIDERS: Record<MixPreset, AutoMixImageProvider[] | null> = {
  free: null,
  // สต็อก (วิดีโอจริง + ภาพ Pexels/Pixabay ฟรี) + ภาพ AI แทรก
  recommended: ["video", "pexels-photo", "pixabay-photo", "kie-ai"],
  // AI เด่น แต่ยังคงเป็น AutoMix ที่มีทั้งวิดีโอและภาพสต็อก
  full: ["video", "pexels-photo", "pixabay-photo", "kie-ai"],
};

/** b-roll source ที่ preset นี้หมายถึง: ฟรีล้วน → "stock", ที่เหลือ → "automix". */
export function presetBrollSource(preset: MixPreset): "stock" | "automix" {
  return preset === "free" ? "stock" : "automix";
}

/** preset นี้ใช้ภาพ AI ไหม (ai weight > 0). */
export function presetUsesAi(preset: MixPreset): boolean {
  return PRESET_WEIGHTS[preset].ai > 0;
}
