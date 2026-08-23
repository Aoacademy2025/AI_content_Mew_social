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
    "ทดลอง PRO ฟรี 7 วัน — ใช้ความสามารถครบแบบ Pro · 15 นาทีช่วงทดลอง|หลังทดลอง: 5 นาที/เดือน · คลิปสั้น 2 นาที · เก็บ 3 วัน|ระบบเตรียม AI ให้พร้อมใช้ — ไม่ต้องสมัครหรือใส่รหัสเชื่อมต่อ AI เอง|ใส่ซับไทยและเลือกภาพประกอบจากคลังให้อัตโนมัติ",

  pro_price: "599",
  pro_name: "Pro",
  pro_badge: "แนะนำ",
  pro_tagline: "คุ้มสุดสำหรับครีเอเตอร์ที่โพสต์ประจำ",
  pro_features:
    "ทุกอย่างใน Free — รวม AI พร้อมใช้ ซับไทย และภาพประกอบอัตโนมัติ|ช่วยคิดและเขียนสคริปต์ได้ไม่จำกัด · บันทึกข้อมูลแบรนด์ได้สูงสุด 5 แบรนด์|คุมภาพทุกฉากให้ตรงกับแบรนด์ของคุณ|สร้างและเลือกภาพประกอบให้อัตโนมัติ · ใช้ภาพจากคลัง ภาพถ่าย หรือภาพที่สร้างด้วย AI (ภาพ AI 2 เครดิต/ภาพ)|80 นาที/เดือน · สูงสุด 100 คลิป · ยาวสุด 6 นาที|ใช้พิธีกร AI หรือทำคลิปแบบไม่ต้องออกกล้อง|ใช้เสียงพากย์ AI ภาษาไทย หรือสร้างเสียงพากย์จากตัวอย่างเสียงของคุณ|ใส่ซับไทยตรงเสียง เน้นคำสำคัญ พร้อมภาพและเสียงประกอบตลอดคลิป|อัปโหลดคลิปที่ถ่ายเอง แล้วให้ระบบใส่ซับและแทรกภาพประกอบให้อัตโนมัติ|ปรับจังหวะบนหน้าตัดต่อ เลือกซับ 17 รูปแบบ และลบพื้นหลัง|สั่งสร้างงานผ่านผู้ช่วย AI ที่คุณใช้อยู่ เช่น Claude หรือ Codex|เติมเครดิตเมื่อใช้เกินโควต้า · เก็บวิดีโอ 7 วัน",

  business_price: "990",
  business_name: "Business",
  business_badge: "",
  business_tagline: "สำหรับทีม/เอเจนซีที่ผลิตเยอะ",
  business_features:
    "ทุกอย่างใน Pro — รวมการเขียนสคริปต์ คุมภาพตามแบรนด์ สร้างภาพ และเลือกภาพประกอบอัตโนมัติ|บันทึกข้อมูลแบรนด์ได้ไม่จำกัด สำหรับหลายแบรนด์หรือหลายลูกค้า|150 นาที/เดือน · สูงสุด 300 คลิป|คลิปยาวสุด 10 นาที|เก็บวิดีโอ 14 วัน|บริการช่วยเหลือแบบเร่งด่วน",
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
