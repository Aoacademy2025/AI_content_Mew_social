// One-off: publish the v1.0.0 product update to /updates.
//
// RUN ON PROD *AFTER DEPLOY* (so the Avatar framing-WYSIWYG feature announced in the
// "🎭 จัดตำแหน่ง Avatar" highlight is actually live):
//
//   cd /var/www/ai-content && npx tsx scripts/publish-v1.0.0-update.ts
//
// Idempotent: if a v1.0.0 ProductUpdate already exists it skips (safe to re-run).
import { prisma } from "../src/lib/prisma";

const VERSION = "v1.0.0";

const TITLE =
  "v1.0.0 — ไม่ต้องใส่ Gemini Key เองแล้ว! + นับโควตาเป็นนาที + จัด Avatar เห็นยังไงได้อย่างนั้น 🎉";

const SUMMARY =
  'อัปเดตใหญ่: ระบบจัดการ Gemini ให้เลย เริ่มสร้างวิดีโอได้ทันที (ไม่ต้องหา/ใส่ key เอง), ' +
  'เปลี่ยนมานับโควตาเป็น "นาที" + เติมนาทีเพิ่มได้, และจัดตำแหน่ง Avatar แบบพรีวิวตรงกับผลจริง';

const BODY = `## 🎉 ของใหญ่รอบนี้

**🤖 ไม่ต้องใส่ Gemini Key เองอีกต่อไป**
เมื่อก่อนต้องไปสมัคร + เปิด Gemini API + เอา key มาใส่เอง (ติดขั้นนี้กันเยอะมาก) —
ตอนนี้ **ระบบจัดการ Gemini ให้เลย** เริ่มสร้างวิดีโอได้ทันที เหลือแค่ใส่ Pexels หรือ
Pixabay (ฟรี อย่างน้อย 1 อัน) ไว้ดึง B-roll เท่านั้น

**⏱️ เปลี่ยนมานับโควตาเป็น "นาที"**
จากเดิมนับเป็นจำนวนคลิป ตอนนี้นับเป็น **นาที** ตรงไปตรงมากว่า — เห็นนาทีคงเหลือได้
ทั้งแดชบอร์ด หน้าตั้งค่า และหน้าแก้ไข · PRO 80 นาที/เดือน · Business 150 นาที/เดือน
(≈ 80 / 150 คลิปที่ความยาว ~1 นาที)

**💎 เติมนาทีเพิ่มได้เมื่อใช้หมด**
ใช้นาทีหมดก่อนรอบรีเซ็ต? เติมเพิ่มได้เลย ไม่ต้องรอรอบใหม่หรืออัปเกรดแพ็กเกจ —
เลือกแพ็กเติมได้ที่หน้าตั้งค่า > Billing

**🎭 จัดตำแหน่ง Avatar แล้วเห็นยังไงได้อย่างนั้น**
ตั้งตำแหน่ง/ขนาด Avatar ในเอดิเตอร์ **แล้วผลที่เรนเดอร์ออกมาตรงกับที่เห็น** กด Save/Lock
ครั้งเดียว ระบบจำไว้ใช้ซ้ำอัตโนมัติทั้งในเว็บและตอนสั่งผ่านแชท (MCP) · พรีวิว Avatar
ก็เร็วและเสถียรขึ้นมาก

## ✨ ปรับปรุง & แก้บัค

- **🎬 B-roll ตรงเนื้อหายิ่งขึ้น** — จับคู่ภาพประกอบเป็นช่วงตามเนื้อหา เปลี่ยนทุก ~3–5 วิ ซ้ำน้อยลง
- **🖼️ Gallery สะอาดขึ้น** — เอาคลิปที่หมดอายุ/เล่นไม่ได้ออก + แสดงภาพตัวอย่างดีขึ้น
- **👤 รูปโปรไฟล์เซฟง่ายขึ้น** — อัปโหลดแล้วกด Save Changes ปุ่มเดียวจบ
- **💳 ประวัติการชำระเงินอ่านง่ายขึ้น** — ซ่อนรายการ checkout ที่ไม่ได้ทำต่อ ไม่รกอีกต่อไป
- **⚙️ หน้าตั้งค่าเรียบขึ้น** — ซ่อนช่อง Gemini key (ไม่ต้องใช้แล้ว) เหลือเฉพาะที่จำเป็น

ขอบคุณที่ใช้งาน HERO AI 🙌 ติชม/แจ้งปัญหาผ่านปุ่มแจ้งปัญหาในแอปได้เลยครับ`;

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
      ctaLabel: "เริ่มสร้างวิดีโอ",
      ctaHref: "/video-creator",
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
