// One-off: publish the v1.1.0 product update (Editor v2 launch) to /updates.
//
// RUN ON PROD *AFTER DEPLOY* (so the redesigned editor + cutaway are actually live):
//   cd /var/www/ai-content && npx tsx scripts/publish-v1.1.0-editor-v2.ts
//
// NOTE: /updates renders `body` as PLAIN TEXT (whitespace-pre-wrap) — NOT markdown.
// So body uses emoji + blank lines for structure, no ## / ** syntax.
// Idempotent: if a v1.1.0 ProductUpdate already exists it skips (safe to re-run).
import { prisma } from "../src/lib/prisma";

const VERSION = "v1.1.0";

const TITLE =
  "v1.1.0 — Video Editor โฉมใหม่หมด! เรนเดอร์เบื้องหลัง + สตูดิโอแต่งซับ + อัปคลิปตัวเอง 🚀";

const SUMMARY =
  "อัปเดตครั้งใหญ่ที่สุดตั้งแต่เปิดตัว — ยกเครื่องหน้าตัดต่อใหม่ทั้งหมด: เรนเดอร์เบื้องหลัง, " +
  "สตูดิโอแต่งซับ, ไทม์ไลน์ และอัปคลิปตัวเองให้เติมซับ + B-roll อัตโนมัติ";

const BODY = `🎉 อัปเดตครั้งใหญ่ที่สุดตั้งแต่เปิดตัว
ยกเครื่องหน้าตัดต่อวิดีโอใหม่ทั้งหมด — ใช้ง่ายขึ้น เร็วขึ้น คุมงานได้ละเอียดขึ้น

🎬 เรนเดอร์เบื้องหลัง
กดเรนเดอร์แล้วปิดแท็บไปทำอย่างอื่นได้เลย งานทำต่อให้เบื้องหลัง กลับมาเปิดใหม่งานเสร็จรออยู่ (มีป้ายเตือนที่ Dashboard)

📝 สตูดิโอแต่งซับ
เลือกสไตล์ซับได้หลายแบบ ปรับสี ฟอนต์ ขนาด ตำแหน่ง แก้ข้อความรายการ์ด รวม/แยกการ์ด และเห็นตัวอย่างสด ๆ ทันทีทุกครั้งที่แก้

🎞️ ไทม์ไลน์เต็มรูปแบบ
ลากปรับจังหวะซับเองได้ (มี Undo Ctrl+Z) เห็นครบทุกแทร็ก — เสียง B-roll เพลง และพิธีกร AI

🆕 อัปคลิปตัวเอง → ซับ + B-roll อัตโนมัติ
มีคลิปแนวตั้งอยู่แล้ว? อัปโหลดเข้ามา ระบบเติมซับไทยตรงเสียง + แทรก B-roll สลับให้ โดยเสียงต้นฉบับต่อเนื่อง

🖥️ แรงขึ้น
อัปเกรดเซิร์ฟเวอร์ใหม่ เรนเดอร์ลื่นและเสถียรขึ้น

————————————————

👋 เพิ่งเข้ามาใช้ครั้งแรก?
อ่านวิธีใช้งานทีละขั้นได้ที่ "คู่มือการใช้งาน" (เมนู Docs หรือไปที่ /docs) — ตั้งแต่ใส่คีย์ ถึงส่งออกวิดีโอแรก

ลองเอดิเตอร์ใหม่ได้เลยที่หน้า "ตัดต่อวิดีโอ" 🎉 ติชม/แจ้งปัญหาผ่านปุ่มแจ้งปัญหาในแอปได้ตลอดครับ 🙌`;

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
      ctaLabel: "ลองเอดิเตอร์ใหม่",
      ctaHref: "/video-editor",
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
