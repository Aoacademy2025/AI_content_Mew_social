/**
 * Reply to and close the 2026-07-30 subtitle-preset card-length support ticket.
 *
 * Dry-run:
 *   npx tsx scripts/ops-close-preset-cardlen-ticket.ts
 * Apply:
 *   RUN=1 npx tsx scripts/ops-close-preset-cardlen-ticket.ts
 *
 * Idempotent: an already replied/closed ticket is left untouched.
 */
import { prisma } from "../src/lib/prisma";
import { createNotification } from "../src/lib/notifications";
import { sendSupportReplyEmail } from "../src/lib/send-email";

const TICKET_ID = "cms7cldb601dtlcaaznt1ktk1";
const RUN = process.env.RUN === "1";

const REPLY = `สวัสดีคุณ Thitima ขอบคุณที่แจ้งรายละเอียดเข้ามาค่ะ

ทีมตรวจสอบแล้วพบว่าเป็นบัคของระบบจริง และแก้ไขขึ้นระบบเรียบร้อยแล้ว ตอนนี้พรีเซ็ตซับจะบันทึกและเรียกคืนการตั้งค่า “ตัด 3 คำ” ไปใช้กับคลิปใหม่ได้ตรงกับที่เลือก พร้อมกับรูปแบบ สี และเอฟเฟกต์อื่น ๆ

สำหรับพรีเซ็ต “Panic 2” ที่บันทึกไว้ก่อนการอัปเดต ระบบเดิมไม่ได้เก็บค่าจำนวนคำไว้ จึงรบกวนเลือก “≤3 คำ” แล้วบันทึกทับพรีเซ็ตเดิมอีกครั้งหนึ่ง หลังจากนั้นจะใช้ซ้ำกับคลิปใหม่ได้ตามปกติค่ะ

แนะนำให้รีเฟรชหน้า Video Editor 1 ครั้งก่อนลองใช้งาน หากยังพบอาการเดิมสามารถแจ้งกลับมาได้ทันทีค่ะ`;

async function main() {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: TICKET_ID },
    include: { user: { select: { name: true, email: true } } },
  });
  if (!ticket) throw new Error(`support ticket not found: ${TICKET_ID}`);
  if (ticket.status !== "OPEN" || ticket.adminReply) {
    console.log(
      `[support] skip ${TICKET_ID} status=${ticket.status} replied=${Boolean(ticket.adminReply)}`,
    );
    return;
  }

  console.log(`[support] ${RUN ? "apply" : "dry-run"} ${TICKET_ID}`);
  console.log(REPLY);
  if (!RUN) return;

  const repliedAt = new Date();
  await prisma.supportTicket.update({
    where: { id: TICKET_ID },
    data: {
      adminReply: REPLY,
      repliedAt,
      status: "CLOSED",
      category: "BUG_CONFIRMED",
      severity: "MEDIUM",
      recommendedAction: "FIX",
      auditNote:
        "Confirmed preset round-trip bug: subtitle preset contract omitted cardLen and apply restored style only. Fixed in PR #205 with regression coverage; deployed 2026-07-31.",
      impactNote:
        "Saved subtitle presets created before the fix cannot recover their original card length; users must select the desired length and save the preset once.",
      auditedAt: repliedAt,
    },
  });
  await createNotification({
    userId: ticket.userId,
    type: "VIDEO_COMPLETED",
    title: "ทีมงานตอบกลับคำร้องของคุณ",
    body: REPLY,
  });
  if (ticket.user.email) {
    await sendSupportReplyEmail({
      userEmail: ticket.user.email,
      userName: ticket.user.name ?? "User",
      ticketId: ticket.id,
      adminReply: REPLY,
      originalMessage: ticket.message,
    });
  }

  console.log(`[support] replied and closed ${TICKET_ID}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
