// Publish the Hero Script launch announcement to /updates.
// Run on production only AFTER the paid rollout + public preview flags are live:
//   cd /var/www/ai-content && RUN=1 npx tsx scripts/publish-v1.5.0-hero-script.ts
//
// /updates renders body as plain text (whitespace-pre-wrap), not Markdown.
// Without RUN=1 this is a read-only preview. A deterministic ID makes concurrent
// invocations safe even though the legacy ProductUpdate.version column is not unique.
import { prisma } from "../src/lib/prisma";

const UPDATE_ID = "product-update-v1-5-0-hero-script";
const VERSION = "v1.5.0";
const RUN = process.env.RUN === "1";
const TITLE = "v1.5.0 — Hero Script เขียนสคริปต์พร้อมส่งตัดต่อได้ใน flow เดียว";
const SUMMARY =
  "ฟีเจอร์ใหม่สำหรับคิดหัวข้อ เลือก Hook เขียนสคริปต์ตามโทนแบรนด์ " +
  "แก้ทีละส่วน และส่งเข้า Video Editor โดยไม่ต้องคัดลอกใหม่";

const BODY = `✍️ Hero Script เปิดให้ใช้งานแล้ว

เปลี่ยนไอเดียให้เป็นสคริปต์วิดีโอสั้นภาษาไทยที่พร้อมถ่ายและพร้อมตัดต่อ โดยทำทุกขั้นตอนต่อเนื่องในหน้าเดียว

💡 คิดหัวข้อให้ตรงแบรนด์

• สร้างไอเดียตามนิช กลุ่มเป้าหมาย และหัวข้อที่เคยเขียน
• บันทึก Brand Profile เพื่อกำหนดโทน คำที่ห้ามใช้ และรูปแบบ CTA
• เลือกความยาว 30, 60 หรือ 90 วินาที

🪝 เลือก Hook ก่อนเขียนเต็ม

• สร้าง Hook จากสูตรเปิดคลิปหลายรูปแบบ
• เลือกและแก้ประโยคเปิดด้วยคำของคุณเองก่อนสร้างสคริปต์

📝 แก้สคริปต์ได้ทีละส่วน

• แยก Hook เนื้อหา และ CTA ให้ตรวจง่าย
• กดเขียนใหม่เฉพาะส่วนที่ยังไม่ใช่ โดยไม่ต้องทิ้งทั้งฉบับ
• บันทึกร่างอัตโนมัติและกลับมาเปิดจาก “สคริปต์ของฉัน” ได้

🎬 ส่งเข้า Video Editor ในคลิกเดียว

• เมื่อสคริปต์พร้อม กด “ส่งไปตัดต่อ” เพื่อสร้างโปรเจกต์และทำวิดีโอต่อได้ทันที

👋 ใช้ครั้งแรก

หน้า Hero Script มีแถบเริ่มต้น 5 ขั้นตอนให้ทำตาม และมีคู่มือฉบับเต็มที่เมนู “วิธีใช้งาน” → “เขียนสคริปต์ด้วย Hero Script”

สมาชิกแบบชำระเงินที่แพ็กเกจยังใช้งานอยู่จะได้รับสิทธิ์เต็ม ส่วนบัญชีอื่นจะเห็นหน้า Preview ระหว่างการทยอยเปิดใช้งาน หากชำระเงินแล้วแต่สิทธิ์ยังไม่อัปเดตภายใน 5 นาที กรุณาส่ง ticket พร้อมอีเมลบัญชีและเวลาที่ชำระ โดยไม่ต้องส่งข้อมูลบัตร

ลองเริ่มจากคลิป 30–60 วินาทีหนึ่งหัวข้อ แล้วส่ง feedback หรือแจ้งปัญหาได้จากปุ่ม Support ในระบบครับ`;

async function main() {
  const matches = await prisma.productUpdate.findMany({ where: { version: VERSION }, take: 2 });
  if (matches.length > 1) {
    throw new Error(`${VERSION} has duplicate ProductUpdate rows; resolve them before publishing`);
  }
  const existing = matches[0] ?? null;
  if (existing?.state === "PUBLISHED") {
    console.log(`[publish] ${VERSION} is already published (id=${existing.id}) — skipping.`);
    return;
  }

  console.log(`[publish] ${RUN ? "apply" : "dry-run"} ${VERSION}`);
  console.log(TITLE);
  console.log(SUMMARY);
  console.log(BODY);
  if (!RUN) return;

  const data = {
      version: VERSION,
      title: TITLE,
      summary: SUMMARY,
      body: BODY,
      category: "FEATURE",
      importance: "BANNER",
      state: "PUBLISHED",
      isPinned: true,
      // null = announce across authenticated product surfaces; CTA still lands
      // directly on Hero Script.
      targetPath: null,
      publishedAt: new Date(),
      ctaLabel: "ลองเขียนสคริปต์",
      ctaHref: "/hero-script",
  } as const;
  const created = existing
    ? await prisma.productUpdate.update({ where: { id: existing.id }, data })
    : await prisma.productUpdate.upsert({
        where: { id: UPDATE_ID },
        create: { id: UPDATE_ID, ...data },
        update: data,
      });
  console.log(`[publish] published ${created.version} (id=${created.id}) — pinned BANNER.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error("[publish] failed:", error);
    await prisma.$disconnect();
    process.exit(1);
  });
