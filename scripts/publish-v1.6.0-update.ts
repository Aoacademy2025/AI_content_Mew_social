/**
 * Publish the user-facing v1.6.0 Studio workflow update.
 *
 * Dry-run:
 *   npx tsx scripts/publish-v1.6.0-update.ts
 * Apply:
 *   RUN=1 npx tsx scripts/publish-v1.6.0-update.ts
 *
 * The deterministic ID and version guard make repeat invocations safe even
 * though ProductUpdate.version is not unique in the legacy schema.
 */
import { prisma } from "../src/lib/prisma";

const UPDATE_ID = "product-update-v1-6-0-brand-visual-editor-flow";
const VERSION = "v1.6.0";
const RUN = process.env.RUN === "1";

const TITLE =
  "v1.6.0 — ภาพทั้งคลิปเป็นแนวเดียวกัน · แก้ B-roll รายฉาก · กลับมาแก้งานต่อได้";
const SUMMARY =
  "Video Editor วิเคราะห์เนื้อหาและแนะนำแนวภาพที่เหมาะกับคลิป " +
  "ช่วยคุมภาพ AI ให้ไปในทิศทางเดียวกัน แก้ B-roll เฉพาะฉากได้ " +
  "และเก็บค่าล่าสุดไว้เมื่อกลับมาแก้งานหลังส่งออก";

const BODY = `ตั้งแต่ v1.5.3 วันที่ 13 สิงหาคม รอบนี้เราเน้นให้การสร้างวิดีโอไปถึงงานที่พร้อมใช้งานได้ง่ายขึ้น พร้อมลดเวลาที่ต้องเริ่มแก้ใหม่เมื่ออยากปรับงานภายหลัง

🎨 ภาพ AI เป็นแนวเดียวกันตลอดทั้งคลิป

• Video Editor อ่านภาพรวมของเนื้อหา แล้วแนะนำ “รูปแบบภาพ” และ “แนวเล่าเรื่อง” ที่เหมาะกับคลิป
• เลือกได้จากภาพสมจริงแบบหนัง, ภาพวาดเล่าเรื่อง, คอมิก, อินโฟกราฟิก และภาพย้อนยุค
• มีแนวเล่าเรื่องพร้อมใช้ เช่น ผู้เชี่ยวชาญอธิบายชัด, ธุรกิจและเทค, ดราม่าชีวิตไทย, ข่าวสืบสวน และหนังผีไทย
• เปลี่ยนแนวเฉพาะคลิปนี้ได้ หรือบันทึกแนวที่ชอบไว้ใน “แบรนด์ของฉัน” เพื่อใช้กับคลิปใหม่
• คลิปเดิมจะยังใช้แนวภาพเดิม ไม่ถูกเปลี่ยนตามการแก้แบรนด์ในภายหลัง

🖼️ แก้ B-roll เฉพาะฉากได้มากขึ้น

• ฉากที่เป็นภาพ AI สามารถกด “ลองภาพนี้ใหม่” โดยยังคงแนวภาพของแบรนด์และเนื้อหาของฉากเดิม
• ฉากที่ใช้ภาพสต็อกจากเว็บสามารถเลือกสร้างภาพ AI ใหม่แทนได้ทันที
• ระบบแสดงสิทธิ์ทดลองหรือเครดิตที่ต้องใช้ก่อนเริ่มสร้าง และคืนสิทธิ์หรือเครดิตหากสร้างไม่สำเร็จ
• ไฟล์ที่อัปโหลดเองจะไม่ถูกเปลี่ยนเป็น AI อัตโนมัติ เพื่อป้องกันการแทนที่ภาพที่ตั้งใจเลือกไว้

✂️ ส่งออกแล้วกลับมาแก้งานต่อได้

• ตั้งแต่งานที่ส่งออกหลังอัปเดตนี้ เมื่อกด “แก้ซับต่อ” ระบบจะคืนข้อความซับ รูปแบบซับ การแบ่งการ์ด และค่าที่ปรับรายใบกลับมาตามตอนส่งออก
• คลิกซับบน Timeline เพื่อหยุดวิดีโอ เลื่อนไปยังช่วงนั้น และเริ่มแก้ข้อความได้ทันที
• ปรับการรวมซับภาษาไทยให้รักษาช่องว่างและวลีเดิม ลดการตัดคำที่ทำให้อ่านสะดุด
• การพิมพ์และเว้นวรรคใน Headline ลื่นขึ้น โดยเคอร์เซอร์ไม่กระโดดระหว่างแก้ข้อความ

🎙️ เริ่มสร้างและส่งออกได้ติดขัดน้อยลง

• บัญชีใหม่เริ่มต้นด้วยเสียง Gemini ที่ระบบดูแลให้ จึงสร้างวิดีโอได้โดยไม่ต้องซื้อหรือตั้งค่า ElevenLabs ก่อน
• การอัปโหลดไฟล์ใหญ่เสถียรขึ้น และระบบจะแจ้งข้อจำกัดความยาวคลิปก่อนเริ่มประมวลผล
• การถอดเสียงสามารถกู้คืนช่วงที่ประมวลผลไม่ครบได้ดีขึ้น ลดโอกาสต้องเริ่มอัปโหลดใหม่
• หากนาทีในแพ็กเกจไม่พอแต่มีเครดิตเพียงพอ ระบบจะแสดงค่าใช้จ่ายล่วงหน้าและให้เรนเดอร์งานต่อได้

หมายเหตุ: งานที่ส่งออกก่อนอัปเดตนี้ยังไม่มีข้อมูลสถานะการแก้ไขย้อนหลัง จึงอาจเปิดด้วยค่าเริ่มต้น รบกวนปรับและส่งออกใหม่หนึ่งครั้ง หลังจากนั้นระบบจะจำค่าล่าสุดให้ครับ`;

const publishedData = {
  version: VERSION,
  title: TITLE,
  summary: SUMMARY,
  body: BODY,
  category: "FEATURE",
  importance: "BANNER",
  state: "PUBLISHED",
  isPinned: true,
  targetPath: null,
  ctaLabel: "ลองสร้างวิดีโอ",
  ctaHref: "/video-editor",
} as const;

function matchesApprovedContent(update: {
  title: string;
  summary: string;
  body: string | null;
  category: string;
  importance: string;
  state: string;
  isPinned: boolean;
  targetPath: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
}) {
  return update.title === TITLE
    && update.summary === SUMMARY
    && update.body === BODY
    && update.category === publishedData.category
    && update.importance === publishedData.importance
    && update.state === publishedData.state
    && update.isPinned === publishedData.isPinned
    && update.targetPath === publishedData.targetPath
    && update.ctaLabel === publishedData.ctaLabel
    && update.ctaHref === publishedData.ctaHref;
}

async function main() {
  const matches = await prisma.productUpdate.findMany({
    where: { version: VERSION },
    take: 2,
  });
  if (matches.length > 1) {
    throw new Error(`${VERSION} has duplicate ProductUpdate rows; resolve them before publishing`);
  }

  const existing = matches[0] ?? null;
  if (existing?.state === "PUBLISHED") {
    if (!matchesApprovedContent(existing)) {
      throw new Error(`${VERSION} is already published with content that differs from the approved update`);
    }
    console.log(`[publish] ${VERSION} is already published (id=${existing.id}) — skipping`);
    return;
  }

  console.log(`[publish] ${RUN ? "apply" : "dry-run"} ${VERSION}`);
  console.log(TITLE);
  console.log(SUMMARY);
  console.log(BODY);
  if (!RUN) return;

  const data = {
    ...publishedData,
    publishedAt: new Date(),
  };
  const published = existing
    ? await prisma.productUpdate.update({ where: { id: existing.id }, data })
    : await prisma.productUpdate.upsert({
        where: { id: UPDATE_ID },
        create: { id: UPDATE_ID, ...data },
        update: data,
      });

  console.log(`[publish] published ${published.version} (id=${published.id}) — pinned BANNER`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error("[publish] failed:", error);
    await prisma.$disconnect();
    process.exit(1);
  });
