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

const DEFAULTS: Record<string, string> = {
  free_price: "0",
  free_name: "Free",
  free_badge: "",
  free_tagline: "ทดลองฟรี ก่อนตัดสินใจ",
  free_features:
    "ทดลอง PRO ฟรี 7 วัน|2 คลิป/เดือน · ยาวสุด 2 นาที|ซับไทย + B-roll อัตโนมัติ|เก็บวิดีโอ 3 วัน",

  pro_price: "599",
  pro_name: "Pro",
  pro_badge: "แนะนำ",
  pro_tagline: "คุ้มสุดสำหรับครีเอเตอร์ที่โพสต์ประจำ",
  pro_features:
    "100 คลิป/เดือน · ยาวสุด 6 นาที|AI Avatar พิธีกร (HeyGen) — หรือทำ Faceless|เสียง AI ไทย + ใช้เสียงโคลนจาก ElevenLabs|ซับไทยตรงเสียงเป๊ะ (ยาว / keyword ไวรัล)|B-roll เปลี่ยนทุก 3–5 วิ + เพลง + Sound FX|ตัดต่อในเว็บ + ลบพื้นหลัง + ฟอนต์พรีเมียม|สั่งสร้างผ่านแชท Claude (MCP)|เก็บวิดีโอ 7 วัน",

  business_price: "990",
  business_name: "Business",
  business_badge: "",
  business_tagline: "สำหรับทีม/เอเจนซีที่ผลิตเยอะ",
  business_features:
    "ทุกอย่างใน PRO|300 คลิป/เดือน (3 เท่าของ PRO)|คลิปยาวสุด 10 นาที|เก็บวิดีโอ 14 วัน|Priority Support ตอบไวกว่า",
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
    getCfg(`plan_${t}_price`, DEFAULTS[`${t}_price`]),
    getCfg(`plan_${t}_name`, DEFAULTS[`${t}_name`]),
    getCfg(`plan_${t}_badge`, DEFAULTS[`${t}_badge`]),
    getCfg(`plan_${t}_tagline`, DEFAULTS[`${t}_tagline`]),
    getCfg(`plan_${t}_features`, DEFAULTS[`${t}_features`]),
  ]);
  return {
    price: parseInt(price, 10) || 0,
    name: name || DEFAULTS[`${t}_name`],
    badge: badge.trim() || null,
    tagline,
    features: features.split("|").map((f) => f.trim()).filter(Boolean),
  };
}

export async function getPlanConfig(): Promise<PlanConfig> {
  const [free, pro, business] = await Promise.all([tier("free"), tier("pro"), tier("business")]);
  return { free, pro, business };
}
