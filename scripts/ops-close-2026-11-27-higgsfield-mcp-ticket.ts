/**
 * Reply to and close the 2026-11-27 Higgsfield + MCP integration question ticket.
 *
 * Dry-run:
 *   npx tsx scripts/ops-close-2026-11-27-higgsfield-mcp-ticket.ts
 * Apply:
 *   RUN=1 npx tsx scripts/ops-close-2026-11-27-higgsfield-mcp-ticket.ts
 *
 * Idempotent: an already replied/closed ticket is left untouched.
 */
import { prisma } from "../src/lib/prisma";
import { createNotification } from "../src/lib/notifications";
import { sendSupportReplyEmail } from "../src/lib/send-email";

const TICKET_ID = "cmwynrr1r03yjlc8kc1heue0c";
const RUN = process.env.RUN === "1";

const REPLY = `สวัสดีครับ ขอบคุณที่ติดต่อสอบถามเข้ามาครับ

สามารถใช้งานร่วมกันได้ครับ โดยทำได้ 2 รูปแบบตามความถนัดเลยครับ:

1. เชื่อมผ่านโปรแกรมตัวกลาง (เช่น Claude Desktop, Claude Code หรือ Cursor): คุณสามารถต่อ MCP ของ HERO AI Studio ควบคู่กับ MCP หรือเครื่องมือสร้างภาพ/วิดีโอภายนอกในแชตเดียวกัน แล้วสั่งให้ AI นำผลลัพธ์จากเครื่องมือนั้นมาใส่ในโปรเจกต์ของ HERO ต่อได้ทันที
2. นำไฟล์จาก Higgsfield เข้าซีนของ HERO โดยตรง: เมื่อสร้างคลิปหรือภาพจาก Higgsfield เสร็จแล้ว สามารถสั่งผ่านแชต MCP ให้ HERO สร้างลิงก์อัปโหลด (create_upload_url) หรือส่งลิงก์ไฟล์เข้ามาแทนที่ซีน B-Roll ที่ต้องการ (replace_broll_window) รวมถึงอัปโหลดเข้าหน้า Video Editor บนเว็บได้โดยตรงครับ

หากต้องการให้ทีมงานช่วยแนะนำขั้นตอนตั้งค่าในโปรแกรมที่ใช้งานอยู่ สามารถแจ้งชื่อโปรแกรมที่ต้องการเชื่อมต่อกลับมาได้เลยครับ`;

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
      category: "USER_CONFUSION",
      severity: "LOW",
      recommendedAction: "WONT_FIX",
      auditNote:
        "Pre-integration how-to question asking whether HERO MCP can be used with Higgsfield. Account jobs and AI generations are healthy; explained multi-MCP host workflow and MediaImport (create_upload_url / replace_broll_window) path.",
      impactNote:
        "No product defect; single informational inquiry resolved via workflow guidance.",
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
