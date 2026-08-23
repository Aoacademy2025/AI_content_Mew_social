import { prisma } from "@/lib/prisma";

// Single source of truth for pricing-tier display content.
// Admin-editable via SiteConfig keys `plan_<tier>_<field>`; values below are fallbacks.
// Used by both /api/plans (in-app pricing page) and the marketing sale page.

export type TierData = {
  price: number;
  name: string;
  badge: string | null;
  tagline: string;
  features: string[];
};
export type PlanConfig = { free: TierData; pro: TierData; business: TierData };

export const PLAN_CONFIG_DEFAULTS: Record<string, string> = {
  free_price: "0",
  free_name: "Free",
  free_badge: "",
  free_tagline: "ทดลองฟรี ก่อนตัดสินใจ",
  free_features:
    "ทดลอง PRO ฟรี 7 วัน — ครบทุกฟีเจอร์ · 15 นาทีช่วงทดลอง|หลังทดลอง: 5 นาที/เดือน · คลิปสั้น 2 นาที · เก็บ 3 วัน|ระบบจัดการ AI ให้ — ไม่ต้องใส่ Gemini key เอง|ซับไทย + Stock B-roll อัตโนมัติ",

  pro_price: "599",
  pro_name: "Pro",
  pro_badge: "แนะนำ",
  pro_tagline: "คุ้มสุดสำหรับครีเอเตอร์ที่โพสต์ประจำ",
  pro_features:
    "ทุกอย่างใน Free — รวมระบบจัดการ AI, ซับไทย และ Stock B-roll|Hero Script AI ไม่จำกัด · Brand Profiles สูงสุด 5 แบรนด์|Brand Visual System · คุมแนวภาพให้เป็นภาษาของแบรนด์เดียวกัน|Hero AI Image + AutoMix B-roll · ผสม Stock, ภาพถ่าย และภาพ AI อัตโนมัติ (ภาพ AI 2 เครดิต/ภาพ)|80 นาที/เดือน · สูงสุด 100 คลิป · ยาวสุด 6 นาที|AI Avatar พิธีกร (HeyGen) — หรือทำ Faceless|เสียง AI ไทย + โคลนเสียงจาก ElevenLabs|ซับไทยตรงเสียงเป๊ะ (ยาว/keyword ไวรัล) + B-roll ทุก 3–5 วิ + เพลง + SFX|อัปโหลดคลิปที่ถ่ายเอง → ใส่ซับ + B-roll cutaway อัตโนมัติ|ตัดต่อบนไทม์ไลน์ + แต่งซับ 17 สไตล์ + ลบพื้นหลัง|สั่งสร้างผ่านแชท AI (MCP) — Claude Cowork · Claude Code · Codex · OpenClaw · Hermes|เติมเครดิตเมื่อใช้เกินโควต้า · เก็บวิดีโอ 7 วัน",

  business_price: "990",
  business_name: "Business",
  business_badge: "",
  business_tagline: "สำหรับทีม/เอเจนซีที่ผลิตเยอะ",
  business_features:
    "ทุกอย่างใน Pro — รวม Hero Script, Brand Visual, Hero AI Image และ AutoMix|Brand Profiles ไม่จำกัด สำหรับหลายแบรนด์/หลายลูกค้า|150 นาที/เดือน · สูงสุด 300 คลิป|คลิปยาวสุด 10 นาที|เก็บวิดีโอ 14 วัน|Priority Support ตอบไวกว่า",
};

async function getCfg(key: string, fallback: string): Promise<string> {
  try {
    const row = await prisma.siteConfig.findUnique({ where: { key } });
    return row?.value ?? fallback;
  } catch {
    return fallback;
  }
}

async function tier(t: "free" | "pro" | "business"): Promise<TierData> {
  const [price, name, badge, tagline, features] = await Promise.all([
    getCfg(`plan_${t}_price`, PLAN_CONFIG_DEFAULTS[`${t}_price`]),
    getCfg(`plan_${t}_name`, PLAN_CONFIG_DEFAULTS[`${t}_name`]),
    getCfg(`plan_${t}_badge`, PLAN_CONFIG_DEFAULTS[`${t}_badge`]),
    getCfg(`plan_${t}_tagline`, PLAN_CONFIG_DEFAULTS[`${t}_tagline`]),
    getCfg(`plan_${t}_features`, PLAN_CONFIG_DEFAULTS[`${t}_features`]),
  ]);
  return {
    price: parseInt(price, 10) || 0,
    name: name || PLAN_CONFIG_DEFAULTS[`${t}_name`],
    badge: badge.trim() || null,
    tagline,
    features: features.split("|").map((f) => f.trim()).filter(Boolean),
  };
}

export async function getPlanConfig(): Promise<PlanConfig> {
  const [free, pro, business] = await Promise.all([tier("free"), tier("pro"), tier("business")]);
  return { free, pro, business };
}
