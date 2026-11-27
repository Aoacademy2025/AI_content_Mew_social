/**
 * Publish the user-facing v1.10.0 voice update.
 *
 * Dry-run:
 *   npx tsx scripts/publish-v1.10.0-update.ts
 * Apply:
 *   RUN=1 npx tsx scripts/publish-v1.10.0-update.ts
 *
 * The deterministic ID and version guard make repeat invocations safe even
 * though ProductUpdate.version is not unique in the legacy schema.
 */
import { prisma } from "../src/lib/prisma";

const UPDATE_ID = "product-update-v1-10-0-gemini-38-elevenlabs-v4";
const VERSION = "v1.10.0";
const RUN = process.env.RUN === "1";

const TITLE = "v1.10.0 — เสียง Gemini 3.8 · เลือก ElevenLabs v4 ได้";
const SUMMARY =
  "เสียง Gemini แบบปกติใช้โมเดล 3.8 ล่าสุด และเลือกน้ำเสียงได้ " +
  "ถ้าใช้ ElevenLabs เลือกเสียงใหม่ v4 ได้ที่ตั้งค่า ด้วย Voice ID เดิม";

const BODY = `ต่อจาก v1.9.1 วันที่ 29 กันยายน รอบนี้ปรับเสียงพากย์ให้เลือกโมเดลได้ชัดขึ้น

เสียง Gemini 3.8 ล่าสุด
• เสียงแบบปกติใช้ Gemini 3.8 ซึ่งเป็นโมเดลเสียงล่าสุด หากโมเดลนั้นไม่พร้อม ระบบจะใช้ Gemini 2.5 ให้เอง
• เปิด «เลือกเสียงอื่น» แล้วเลือกน้ำเสียงได้ 5 แบบ: ปกติ, ร่าเริง, จริงจัง, อบอุ่น, ตื่นเต้น
• น้ำเสียงอื่นที่ไม่ใช่ปกติใช้ Gemini 2.5 เพื่อไม่ให้อ่านคำสั่งน้ำเสียงออกมาเป็นเสียง
• ใต้ช่องน้ำเสียงมีข้อความบอกว่าแต่ละแบบใช้โมเดลไหน

ElevenLabs v4
• ไปที่ ตั้งค่า → API Keys → เปิดส่วนขั้นสูง ใต้คีย์ ElevenLabs
• เสียงเดิม · v3 คือโมเดลที่ใช้อยู่ตอนนี้
• เสียงใหม่ · v4 (ล่าสุด) ใช้ Voice ID เดิม ไม่ต้อง clone ใหม่
• เลือกแล้วมีผลกับคลิปถัดไป ทั้งบนหน้าเว็บและงานที่สั่งผ่าน MCP
• บัญชีที่ยังไม่ได้เลือกจะอยู่ที่ v3 เหมือนเดิม

ภาพประกอบจาก MCP
• ตอนสั่งสร้างวิดีโอผ่าน MCP เลือกภาพได้ 3 แบบ: วิดีโอสต็อกฟรี, Hero AI Image และ AutoMix
• ถ้าแผนยังใช้ภาพ AI ไม่ได้ ระบบจะบอกก่อนสร้างงาน`;

const publishedData = {
  version: VERSION,
  title: TITLE,
  summary: SUMMARY,
  body: BODY,
  category: "FEATURE",
  importance: "MODAL",
  state: "PUBLISHED",
  isPinned: true,
  targetPath: null,
  ctaLabel: "ลองเสียง Gemini",
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

  console.log(`[publish] published ${published.version} (id=${published.id}) — pinned MODAL`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error("[publish] failed:", error);
    await prisma.$disconnect();
    process.exit(1);
  });
