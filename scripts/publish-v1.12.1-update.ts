/**
 * Publish the user-facing v1.12.1 Editor UX, Presenter Upload, and Brand/Hook defaults update.
 *
 * Dry-run:
 *   npx tsx scripts/publish-v1.12.1-update.ts
 * Apply:
 *   RUN=1 npx tsx scripts/publish-v1.12.1-update.ts
 */
import { prisma } from "../src/lib/prisma";

const UPDATE_ID = "product-update-v1-12-1-editor-ux-brand-hook-defaults";
const VERSION = "v1.12.1";
const RUN = process.env.RUN === "1";

const TITLE = "v1.12.1 — อัปคลิปพูดดูง่ายขึ้น · พาดหัวและโลโก้แบรนด์พร้อมใช้กว่าเดิม";
const SUMMARY =
  "ปรับหน้าอัปโหลดคลิปพูดให้ดูพรีวิวคู่กับตั้งค่าในหน้าเดียว แสดงชื่อไฟล์แต่ละช่วง แก้โหมดใส่ B-roll เอง " +
  "เปิดพาดหัวแล้วดึงประโยคแรกให้อัตโนมัติ และคงโลโก้เริ่มต้นของบัญชีเมื่อส่งสคริปต์จาก Hero Script";

const BODY = `ต่อจาก v1.12.0 วันที่ 17 ตุลาคม รอบนี้ปรับปรุงประสบการณ์ใช้งานโหมดอัปโหลดคลิปพูด หน้าตัดต่อวิดีโอ (Video Editor) และการส่งสคริปต์จาก Hero Script ให้ลื่นไหลและพร้อมส่งออกคลิปได้ง่ายขึ้น

📹 โหมดอัปโหลดคลิปที่ถ่ายเอง (Presenter Upload · แผน PRO / BUSINESS)
• ปรับเลย์เอาต์เป็น 2 คอลัมน์: ดูพรีวิววิดีโอ 9:16 ด้านซ้าย คู่กับการตั้งค่าจัดวางเฟรมและรายการคลิปที่ต่อเรียงด้านขวาในหน้าเดียว ไม่ต้องเลื่อนหน้าจอขึ้นลงยาว
• แสดงชื่อไฟล์จริงของแต่ละคลิปที่นำมาต่อเรียงกัน (คลิปช่วงที่ 1–5) ช่วยให้เช็กลำดับเทคก่อนกดเรนเดอร์ได้ง่ายขึ้น
• ปรับปรุงระบบ «กระชับจังหวะอัตโนมัติ (ตัดช่วงเงียบ + เร่ง 1.1x)» ให้ประมวลผลคลิปพูดที่ยาวหลายนาทีได้เร็วและเสถียรขึ้น
• แก้ไขโหมด «ใส่ B-roll เอง» สำหรับคลิปที่อัปโหลดเอง ให้เว้นช่วงสำหรับเลือกเติมภาพหรือวิดีโอ B-roll เองในไทม์ไลน์ได้ตามปกติ

✨ พาดหัว โลโก้แบรนด์ และการส่งออกวิดีโอในหน้า Editor
• เปิดสวิตช์ «พาดหัว (Headline Hook)» แล้วมีข้อความพร้อมใช้ทันที: หากเคยลบข้อความพาดหัวออกจนว่าง เมื่อกดเปิดสวิตช์พาดหัวอีกครั้ง ระบบจะดึงประโยคเปิดเรื่องจากสคริปต์/ซับมาตั้งเป็นพาดหัวให้อัตโนมัติ
• คงโลโก้เริ่มต้นของบัญชี (Default Logo) เมื่อส่งสคริปต์จาก Hero Script: หากใช้โปรไฟล์แบรนด์ที่ไม่ได้ตั้งโลโก้แยกเฉพาะแบรนด์ ระบบจะใช้โลโก้เริ่มต้นของบัญชีให้อัตโนมัติ
• เมนู «แบรนด์ของฉัน» แสดงบนแถบเมนูซ้ายตลอดเวลา ตั้งค่าแบรนด์และโลโก้ได้ทันทีตั้งแต่เริ่มสร้างคลิปแรก
• แยกสถานะ «พรีวิวพร้อมแต่ง» กับปุ่ม «ส่งออกวิดีโอ» ชัดเจนขึ้น เพื่อไม่ให้สับสนระหว่างไฟล์พรีวิวสำหรับแต่งซับกับไฟล์วิดีโอจริงที่ฝังซับความละเอียดเต็มเข้า Gallery
• เพิ่มปุ่มลัด «คิดสคริปต์คลิปถัดไป (Hero Script)» บนหน้าจอหลังส่งออกวิดีโอเสร็จ เพื่อเริ่มทำคลิปถัดไปได้ทันที

🤖 การเชื่อมต่อ AI Agent (MCP) และโควตาเสียง AI
• ปรับความเร็วการตรวจสอบสิทธิ์และเช็กสถานะงานผ่าน MCP ให้ตอบสนองไวขึ้น
• เมื่อโควตานาทีเสียง AI ของแพ็กเกจใกล้ครบเพดาน ระบบแจ้งทางเลือกให้เติมเครดิต Hero เพื่อสร้างเสียง AI ต่อได้ทันทีโดยไม่ต้องรอรอบถัดไป`;

const publishedData = {
  version: VERSION,
  title: TITLE,
  summary: SUMMARY,
  body: BODY,
  category: "IMPROVEMENT",
  importance: "BANNER",
  state: "PUBLISHED",
  isPinned: true,
  targetPath: null,
  ctaLabel: "เปิด Video Editor",
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
  if (TITLE.length > 120) throw new Error(`title is ${TITLE.length} characters`);
  if (SUMMARY.length > 280) throw new Error(`summary is ${SUMMARY.length} characters`);
  if (BODY.length > 8_000) throw new Error(`body is ${BODY.length} characters`);

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
  console.log(`title ${TITLE.length}`);
  console.log(`summary ${SUMMARY.length}`);
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
