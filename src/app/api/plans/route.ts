import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const DEFAULTS = {
  free_price: "0",
  free_features: "2 คลิป/เดือน|ความยาววิดีโอสูงสุด 2 นาทีต่อคลิป|จัดเก็บวิดีโอบนระบบนาน 3 วัน|สร้างคอนเทนต์ด้วย AI (จำกัด 5 ชิ้น)|ใช้ Gemini API key ของตัวเอง|Font พื้นฐานเท่านั้น",
  pro_price: "599",
  pro_features: "100 คลิป/เดือน ไม่จำกัดจำนวนต่อวัน|ความยาววิดีโอสูงสุด 6 นาทีต่อคลิป|จัดเก็บวิดีโอบนระบบนาน 7 วัน|รองรับ Avatar ทุกรูปแบบ รวมถึง HeyGen|Text-to-Speech ครบทุกผู้ให้บริการ (ElevenLabs, Gemini, HeyGen)|เลือกใช้ Font ได้ครบทุก Style|ลบพื้นหลังอัตโนมัติด้วย AI (Background Removal)|เพิ่มเพลงประกอบวิดีโอ|ปรับแต่ง Subtitle Style ได้ทุกรูปแบบ|Video Editor ขั้นสูงครบฟีเจอร์|สร้างคอนเทนต์ด้วย AI ไม่จำกัดจำนวน|Support ทาง Email — ทีมงานตอบสนองภายใน 48 ชั่วโมง",
  business_price: "990",
  business_features: "ทุกอย่างในแผน PRO และเพิ่มเติม:|300 คลิป/เดือน ไม่จำกัดจำนวนต่อวัน|ความยาววิดีโอสูงสุด 10 นาทีต่อคลิป|จัดเก็บวิดีโอบนระบบนาน 14 วัน|Priority Support — ทีมงานตอบสนองภายใน 24 ชั่วโมง|เหมาะสำหรับทีมงานและองค์กรธุรกิจ",
};

async function getCfg(key: string, fallback: string): Promise<string> {
  try {
    const row = await prisma.siteConfig.findUnique({ where: { key } });
    return row?.value || fallback;
  } catch { return fallback; }
}

export async function GET() {
  const [freePrice, freeFeatures, proPrice, proFeatures, businessPrice, businessFeatures] = await Promise.all([
    getCfg("plan_free_price", DEFAULTS.free_price),
    getCfg("plan_free_features", DEFAULTS.free_features),
    getCfg("plan_pro_price", DEFAULTS.pro_price),
    getCfg("plan_pro_features", DEFAULTS.pro_features),
    getCfg("plan_business_price", DEFAULTS.business_price),
    getCfg("plan_business_features", DEFAULTS.business_features),
  ]);

  return NextResponse.json({
    free: { price: parseInt(freePrice, 10), features: freeFeatures.split("|").map(f => f.trim()).filter(Boolean) },
    pro: { price: parseInt(proPrice, 10), features: proFeatures.split("|").map(f => f.trim()).filter(Boolean) },
    business: { price: parseInt(businessPrice, 10), features: businessFeatures.split("|").map(f => f.trim()).filter(Boolean) },
  });
}
