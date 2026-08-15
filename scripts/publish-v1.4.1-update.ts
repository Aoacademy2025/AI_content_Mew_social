// One-off: publish the user-facing v1.4.1 product update to /updates.
//
// Run on production after the related changes are live:
//   cd /var/www/ai-content && npx tsx scripts/publish-v1.4.1-update.ts
//
// /updates renders body as plain text (whitespace-pre-wrap), not Markdown.
// Idempotent: an existing v1.4.1 row is left untouched.
import { prisma } from "../src/lib/prisma";

const VERSION = "v1.4.1";

const TITLE =
  "v1.4.1 — พรีเซ็ตจำจำนวนคำ · B-roll ไม่หาย · Hero AI และเครดิตเสถียรขึ้น";

const SUMMARY =
  "แก้พรีเซ็ตซับให้จำจำนวนคำที่เลือก รักษา B-roll ที่แก้ไว้ระหว่างส่งออก " +
  "เพิ่มความเสถียรของ Hero AI พร้อมแสดงและคืนเครดิตได้ถูกต้องกว่าเดิม";

const BODY = `อัปเดตรอบนี้รวบรวมการแก้ไขสำคัญหลัง v1.4.0 จากการใช้งานจริงและ support ticket เพื่อให้งานที่ตั้งไว้ถูกนำกลับมาใช้ตรงเดิม และลดความกังวลเรื่องงานหรือเครดิตหาย

💬 พรีเซ็ตซับจำจำนวนคำแล้ว

• พรีเซ็ตซับจะบันทึกทั้งรูปแบบ สี เอฟเฟกต์ และความยาวการ์ดที่เลือก เช่น ≤4 คำ, ≤3 คำ, ≤2 คำ หรือ 1 คำ
• เมื่อใช้พรีเซ็ตกับคลิปใหม่ การ์ดซับจะถูกจัดกลุ่มตามค่าที่บันทึกไว้ ไม่ย้อนกลับเป็น “1 ประโยค”
• พรีเซ็ตที่สร้างก่อนอัปเดตนี้ยังใช้งานได้ แต่ต้องเลือกจำนวนคำแล้วบันทึกทับหนึ่งครั้ง เพื่อเพิ่มค่าที่ระบบเดิมยังไม่ได้เก็บ

🎞️ แก้ B-roll ต่อได้โดยงานไม่หาย

• การเปลี่ยนหรืออัปโหลด B-roll ที่ยังรออัปเดตจะไม่หายเมื่อกดส่งออกหรือเปลี่ยนขั้นตอน
• ปรับข้อความสถานะให้ชัดขึ้นว่า B-roll ใดกำลังรอนำไปใช้ ลดความสับสนว่าโปรเจกต์ถูกปิดหรือสร้างใหม่
• แผงแก้ B-roll อยู่ในขอบหน้าจอมากขึ้น ใช้งานบนจอเล็กและมือถือได้สะดวกกว่าเดิม

🖼️ Hero AI Image เข้าใจฉากและเสถียรขึ้น

• การวางแผนภาพใช้บริบทจากสคริปต์ทั้งเรื่องมากขึ้น ช่วยให้ภาพของแต่ละฉากต่อเนื่องและตรงเนื้อหา
• เพิ่มความทนทานของเส้นทางสร้างภาพและการลองใหม่ ลดงานล้มเหลวจากปัญหาชั่วคราวของระบบ
• งานที่สร้างไม่สำเร็จจะจบด้วยสถานะและเหตุผลชัดเจน ไม่ค้างเงียบ

💳 เครดิตเห็นชัดและคืนให้อัตโนมัติ

• แสดงเครดิตคงเหลือใน Video Editor ก่อนเริ่มสร้าง ช่วยตัดสินใจได้โดยไม่ต้องออกไปหน้าตั้งค่า
• หากงานวิดีโอหรือ AI ล้มเหลวก่อนสำเร็จ ระบบจะคืนเครดิตที่จองไว้ให้อัตโนมัติ
• ปรับการคำนวณค่าใช้จ่ายของงานรูปหลายฉากให้ตรงกับสิ่งที่สร้างจริงมากขึ้น

☁️ ไฟล์โปรเจกต์ปลอดภัยและเปิดต่อได้มั่นใจขึ้น

• เพิ่มระบบสำรองไฟล์วิดีโอและสื่อบน Cloudflare R2 แบบทยอยเปิดใช้งาน พร้อมตรวจสอบความครบถ้วนก่อนย้ายไฟล์
• หากไฟล์สำเนาในเครื่องถูกล้างเพื่อคืนพื้นที่ ระบบสามารถอ่านสำเนาที่ตรวจสอบแล้วจากคลาวด์ได้
• ปรับ deployment ให้แท็บที่เปิดค้างไว้ยังโหลดไฟล์หน้าเว็บรุ่นก่อนหน้าได้ ลดอาการหน้าพังหรือไฟล์หายหลังระบบอัปเดต

ขอบคุณทุก support ticket และตัวอย่างงานที่ส่งเข้ามาครับ หลายจุดในรอบนี้แก้จากอาการที่ผู้ใช้พบจริงโดยตรง 🙌`;

async function main() {
  const existing = await prisma.productUpdate.findFirst({
    where: { version: VERSION },
  });
  if (existing) {
    console.log(
      `[publish] ${VERSION} already exists (id=${existing.id}, state=${existing.state}) — skipping.`,
    );
    return;
  }

  const created = await prisma.productUpdate.create({
    data: {
      version: VERSION,
      title: TITLE,
      summary: SUMMARY,
      body: BODY,
      category: "IMPROVEMENT",
      importance: "BANNER",
      state: "PUBLISHED",
      isPinned: true,
      publishedAt: new Date(),
      ctaLabel: "ไปที่ Video Editor",
      ctaHref: "/video-editor",
    },
  });
  console.log(
    `[publish] published ${created.version} (id=${created.id}) — pinned, PUBLISHED.`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error("[publish] failed:", error);
    await prisma.$disconnect();
    process.exit(1);
  });
