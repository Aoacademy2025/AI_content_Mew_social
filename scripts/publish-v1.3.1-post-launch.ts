// One-off: publish the user-facing v1.3.1 product update to /updates.
//
// Run on production after the related changes are live:
//   cd /var/www/ai-content && npx tsx scripts/publish-v1.3.1-post-launch.ts
//
// /updates renders body as plain text (whitespace-pre-wrap), not Markdown.
// Idempotent: an existing v1.3.1 row is left untouched.
import { prisma } from "../src/lib/prisma";

const VERSION = "v1.3.1";

const TITLE = "v1.3.1 — Hero Voice กำลังมา · เห็นลำดับคิว · เปิดงานต่อได้มั่นใจขึ้น";

const SUMMARY =
  "เริ่มทดสอบ Hero Voice กับผู้ใช้บางส่วน พร้อมแสดงลำดับคิวเรนเดอร์ จำเสียงและ Avatar ที่ตั้งไว้ " +
  "ปรับ B-roll ให้ต่อเนื่องขึ้น และแจ้งปัญหา Avatar ชัดเจนกว่าเดิม";

const BODY = `อัปเดตรอบนี้เน้นให้การสร้างคลิปเข้าใจง่ายและไว้ใจได้มากขึ้น ตั้งแต่เริ่มโปรเจกต์ รอเรนเดอร์ ไปจนถึงกลับมาเปิดงานเดิม

🎙️ Hero Voice กำลังมาเร็ว ๆ นี้

• เพิ่มตัวเลือกเสียงใหม่ “Hero Voice” ที่ทีม HERO AI พัฒนาขึ้นสำหรับงานวิดีโอ
• ตอนนี้อยู่ระหว่างทดสอบกับผู้ใช้บางบัญชี เพื่อเก็บคุณภาพเสียงและความเสถียรก่อนเปิดให้ทุกคน
• ผู้ใช้ทั่วไปจะเห็นป้าย “เร็ว ๆ นี้” และเราจะทยอยเปิดใช้งานเมื่อระบบพร้อม
• เสียง Gemini และ ElevenLabs ที่ใช้อยู่เดิมยังทำงานเหมือนเดิม ไม่ถูกเปลี่ยนหรือปิด

⏳ รู้แล้วว่างานกำลังรออะไร

• เมื่อมีหลายงานพร้อมกัน หน้าสร้างวิดีโอจะแสดงลำดับคิว เช่น “อยู่ในคิว #2”
• งานจะเริ่มอัตโนมัติเมื่อถึงลำดับ ไม่ต้องกดซ้ำหรือเปิดหน้าจอค้างไว้
• แยกได้ชัดขึ้นระหว่าง “กำลังรอคิว” กับ “เริ่มสร้างแล้ว” ลดความสับสนตอนเปอร์เซ็นต์ยังอยู่ที่ 0%

⚙️ โปรเจกต์ใหม่จำค่าที่คุณใช้ประจำ

• เสียง Gemini หรือ ElevenLabs ที่บันทึกไว้ในบัญชีจะถูกเลือกให้ในโปรเจกต์ใหม่โดยอัตโนมัติ
• Avatar ที่ตั้งไว้จะถูกนำมาใช้เป็นค่าเริ่มต้น ไม่ต้องเลือกซ้ำทุกครั้ง
• ค่าเดิมของแต่ละโปรเจกต์ยังอยู่ครบ ระบบไม่เปลี่ยนงานเก่าย้อนหลัง

🎞️ B-roll ต่อเนื่องและดูเป็นธรรมชาติขึ้น

• ปรับการกระจาย B-roll ให้ครอบคลุมตามความยาวเสียงได้ดีขึ้น รวมถึงช่วงต้นและช่วงท้ายคลิป
• ลดจังหวะเปลี่ยนภาพถี่เกินไป ทำให้ดูต่อเนื่องและไม่กระพริบรบกวนสายตา
• งานที่อัปโหลดคลิปตัวเองได้รับการปรับจังหวะ B-roll แบบเดียวกัน

📁 กลับมาเปิดงานเดิมได้มั่นใจขึ้น

• ปรับการกู้สถานะโปรเจกต์หลังรีเฟรชหน้าเว็บหรืออินเทอร์เน็ตสะดุด ลดโอกาสเห็นข้อมูลเก่าทับงานล่าสุด
• ระบบตรวจงานเดิมก่อนส่งคำสั่งสร้างหรือส่งออกซ้ำ ช่วยลดงานซ้ำโดยไม่ตั้งใจ
• การลบโปรเจกต์ทำงานแน่นอนขึ้น และรายการโปรเจกต์อัปเดตทันที

🎭 ปัญหา Avatar บอกสาเหตุชัดขึ้น

• ตรวจความพร้อมของ HeyGen ก่อนเริ่มสร้าง Avatar
• หากเครดิต HeyGen ไม่พอ ระบบจะแจ้งตรง ๆ พร้อมทางเลือกให้เติมเครดิตหรือเปลี่ยนเป็นคลิปแบบไม่มี Avatar
• ลดอาการงานค้างโดยไม่รู้สาเหตุ และช่วยให้กลับไปแก้แล้วลองใหม่ได้เร็วขึ้น

ขอบคุณทุกคนที่ส่ง feedback และคลิปตัวอย่างเข้ามาครับ การปรับหลายจุดในรอบนี้มาจากการใช้งานจริงโดยตรง 🙌`;

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
      category: "IMPROVEMENT",
      importance: "BANNER",
      state: "PUBLISHED",
      isPinned: true,
      publishedAt: new Date(),
      ctaLabel: "ไปที่ Video Editor",
      ctaHref: "/video-editor",
    },
  });
  console.log(`[publish] published ${created.version} (id=${created.id}) — pinned, PUBLISHED.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[publish] failed:", error);
    process.exit(1);
  });
