/**
 * Publish the user-facing v1.4.2 stability update after production smoke passes.
 *
 * Dry-run: npx tsx scripts/publish-v1.4.2-stability-update.ts
 * Apply:   RUN=1 npx tsx scripts/publish-v1.4.2-stability-update.ts
 */
import { prisma } from "../src/lib/prisma";

const VERSION = "v1.4.2";
const RUN = process.env.RUN === "1";

const TITLE = "v1.4.2 — Session เสถียรขึ้น · จำ Voice/Avatar · Editor ทำงานเบาลง";
const SUMMARY =
  "แก้ปัญหา Unauthorized ระหว่างสร้างสคริปต์ เพิ่มการบันทึก Voice/Avatar เริ่มต้น " +
  "และลดคำขอซ้ำเพื่อให้ Editor ตอบสนองและทำงานต่อเนื่องขึ้น";

const BODY = `อัปเดตรอบนี้ต่อจาก v1.4.1 โดยนำข้อมูลจากการใช้งานจริงและ support ticket มาปรับความเสถียร ประสิทธิภาพ และความชัดเจนในการใช้งาน โดยยังรักษาระบบบันทึกโปรเจกต์ คุณภาพวิดีโอ และมาตรฐานเดิมไว้ครบถ้วน

🔐 สร้างสคริปต์ต่อได้เมื่อ Session สะดุด

• แก้ปัญหา Unauthorized ที่อาจเกิดขึ้นชั่วคราวระหว่างสร้างหรือบันทึกสคริปต์
• ระบบจะต่ออายุ session และลองคำขอเดิมให้อัตโนมัติหนึ่งครั้ง โดยไม่สร้างงานซ้ำ
• ครอบคลุม HERO Script, Video Editor, การแจ้งเตือน และรายการเสียง/อวตารที่ต้องยืนยันตัวตน

🎙️ จำ Voice และ Avatar สำหรับโปรเจกต์ใหม่

• เพิ่มปุ่ม “บันทึกเสียงนี้เป็นค่าเริ่มต้น” สำหรับ ElevenLabs Voice ID
• เพิ่มปุ่ม “บันทึกอวตารนี้เป็นค่าเริ่มต้น” สำหรับ HeyGen Avatar ID
• เมื่อรับสคริปต์เข้ามาสร้างโปรเจกต์ใหม่ ระบบจะเติมค่าที่บันทึกไว้ให้อัตโนมัติ
• โปรเจกต์เดิมยังคงค่าของตัวเอง ไม่ถูกค่าเริ่มต้นใหม่เขียนทับ

⚡ Editor ทำงานเบาลงและลดคำขอซ้ำ

• รวมคำขอตรวจเครดิตและโควตาที่เกิดพร้อมกันให้เหลือคำขอเดียว
• ป้องกันการตรวจสถานะงานซ้อนกัน และลดความถี่เมื่อซ่อนแท็บ
• เมื่อกลับมาที่หน้า Editor ระบบจะตรวจสถานะงานให้อีกครั้งทันที
• ระบบ autosave และการป้องกันข้อมูลชนกันยังทำงานตามมาตรฐานเดิม

🛡️ เพิ่มเกราะความเสถียรของระบบ

• การอัปเดตระบบจะตรวจ Web และฐานข้อมูลก่อนเปิดใช้เวอร์ชันใหม่
• หากเวอร์ชันใหม่ไม่ผ่าน health check ระบบสามารถย้อนกลับเวอร์ชันก่อนหน้าได้อัตโนมัติ
• ปรับระบบเฝ้าระวังพื้นที่ดิสก์ให้ retry และแจ้ง failure ได้ถูกต้องขึ้น

ขอบคุณสมาชิกที่ส่งรายละเอียดและภาพประกอบผ่าน support ticket ครับ ทุกเคสช่วยให้เราปรับ HERO AI ให้เสถียรและใช้งานได้ดีขึ้นอย่างต่อเนื่อง 🙌`;

async function main() {
  const existing = await prisma.productUpdate.findFirst({ where: { version: VERSION } });
  if (existing) {
    console.log(`[publish] ${VERSION} already exists (id=${existing.id}, state=${existing.state}) — skipping`);
    return;
  }

  console.log(`[publish] ${RUN ? "apply" : "dry-run"} ${VERSION}`);
  console.log(TITLE);
  console.log(SUMMARY);
  console.log(BODY);
  if (!RUN) return;

  const created = await prisma.productUpdate.create({
    data: {
      version: VERSION,
      title: TITLE,
      summary: SUMMARY,
      body: BODY,
      category: "FIX",
      importance: "BANNER",
      state: "PUBLISHED",
      isPinned: true,
      publishedAt: new Date(),
      ctaLabel: "ไปที่ Video Editor",
      ctaHref: "/video-editor",
    },
  });
  console.log(`[publish] published ${created.version} (id=${created.id}) — pinned, PUBLISHED`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error("[publish] failed:", error);
    await prisma.$disconnect();
    process.exit(1);
  });
