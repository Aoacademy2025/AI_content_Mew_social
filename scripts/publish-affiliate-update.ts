// One-off: publish the affiliate program launch post to /updates.
//
// RUN ON PROD *AFTER DEPLOY* (so the affiliate program is actually live):
//
//   cd /var/www/ai-content && npx tsx scripts/publish-affiliate-update.ts
//
// Idempotent: if an affiliate-2026-07 ProductUpdate already exists it skips (safe to re-run).
import { prisma } from "../src/lib/prisma";

const VERSION = "v1.2.2";

const TITLE = "เปิดตัว HERO AI Affiliate — แนะนำเพื่อน รับค่าคอม 25% ทุกเดือน";

const SUMMARY =
  "ชวนเพื่อนมาใช้ HERO AI แล้วรับค่าคอมมิชชั่น 25% ของทุกยอดจ่าย ทุกเดือน ตลอดที่ลูกค้ายังใช้งาน";

const BODY = `เปิดตัว HERO AI Affiliate อย่างเป็นทางการ

แนะนำ HERO AI Creator Studio ให้เพื่อนหรือผู้ติดตามของคุณ แล้วรับค่าคอมมิชชั่น 25% ของยอดที่ลูกค้าจ่ายจริง ทุกเดือน ตลอดอายุการใช้งานของลูกค้า ไม่ใช่จ่ายครั้งเดียวจบ

ตัวอย่างรายได้: ลูกค้า PRO รายเดือน 1 คน = ~140 บาท/เดือน · ลูกค้า PRO รายปี 1 คน = ~1,400 บาท · มีลูกค้า active 10 คน = รายได้ประจำ ~1,400 บาท/เดือน

สมัครฟรี อนุมัติอัตโนมัติ ไม่ต้องมียอดขั้นต่ำ ใช้ลิงก์ส่วนตัวของคุณแชร์ได้ทันที ระบบติดตามยอดและจ่ายเงินให้ทุกเดือน (โอนตรง หักภาษี ณ ที่จ่าย พร้อมเอกสาร 50 ทวิ)

สมัครได้ที่ affiliate.heroaiengine.com/affiliate-program

— อัปเดตระบบล่าสุด —

นอกจากระบบ Affiliate รอบนี้เราปรับปรุงระบบเพิ่มเติม:
• ลบโปรเจกต์ที่ไม่ใช้แล้วได้จากหน้ารวมโปรเจกต์
• สลับไปทำโปรเจกต์อื่นระหว่างรอ export ได้ — งานเดินต่อไม่หลุด
• โปรเจกต์ฉบับร่างแสดงในรายการครบ ไม่หายอีกต่อไป
• แถบยืนยัน B-roll เห็นชัดขึ้นตอนแก้ทีละช่วง
• เสริมความเสถียรและความปลอดภัยของระบบเบื้องหลังหลายจุด`;

async function main() {
  const existing = await prisma.productUpdate.findFirst({ where: { version: VERSION } });
  if (existing) {
    console.log(`[publish] ${VERSION} already exists (id=${existing.id}, state=${existing.state}) — skipping.`);
    return;
  }
  const created = await prisma.productUpdate.create({
    data: {
      version: VERSION,
      title: TITLE,
      summary: SUMMARY,
      body: BODY,
      category: "FEATURE",
      importance: "BANNER",
      state: "PUBLISHED",
      isPinned: true,
      publishedAt: new Date(),
      ctaLabel: "สมัครทำ Affiliate",
      ctaHref: "https://affiliate.heroaiengine.com/affiliate-program",
    },
  });
  console.log(`[publish] published ${created.version} (id=${created.id}) — pinned, PUBLISHED.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[publish] failed:", e);
    process.exit(1);
  });
