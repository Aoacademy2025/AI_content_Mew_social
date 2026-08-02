/**
 * Reply to and close the two 2026-08-02 stability tickets after v1.4.2 is live.
 *
 * Dry-run: npx tsx scripts/ops-close-2026-08-02-stability-tickets.ts
 * Apply:   RUN=1 npx tsx scripts/ops-close-2026-08-02-stability-tickets.ts
 */
import { prisma } from "../src/lib/prisma";
import { createNotification } from "../src/lib/notifications";
import { sendSupportReplyEmail } from "../src/lib/send-email";

const RUN = process.env.RUN === "1";

const TICKETS = [
  {
    id: "cmsbpve5b02belchyr87rqyyj",
    severity: "HIGH",
    reply: `สวัสดีครับ ขอบคุณที่แจ้งปัญหาเรื่องกดสร้างสคริปต์ไม่ได้เข้ามาครับ

ทีมตรวจสอบแล้วพบว่าเป็นปัญหา session หลุดชั่วคราว ทำให้ระบบตอบ Unauthorized ระหว่างสร้างสคริปต์ ไม่ได้เกิดจากหัวข้อที่กรอก โมเดล AI หรือโควตาของบัญชี

เราแก้ไขและอัปเดตขึ้นระบบแล้ว ตอนนี้หาก session หมดอายุระหว่างใช้งาน ระบบจะต่ออายุ session และลองคำขอเดิมให้อัตโนมัติหนึ่งครั้ง โดยไม่สร้างงานซ้ำ พร้อมปรับข้อความแจ้งเตือนให้ชัดเจนขึ้น

แนะนำให้รีเฟรชหน้า HERO Script หนึ่งครั้งก่อนใช้งาน หากยังพบอาการเดิมสามารถตอบกลับ ticket นี้ได้ทันทีครับ`,
    auditNote:
      "Confirmed transient Clerk session/authentication failure. Script generation returned 401 before any model or quota work. Fixed in v1.4.2 with one-shot forced token refresh, safe request replay, and recovery telemetry.",
    impactNote:
      "The user could not generate a script during a short session-authentication window. The later retry succeeded; no model failure, quota loss, or duplicate script was found.",
  },
  {
    id: "cmsblpwyu01y4lchyptzt4evo",
    severity: "MEDIUM",
    reply: `สวัสดีคุณ Thitima ขอบคุณที่แจ้งเรื่อง Voice ID และ HeyGen Avatar ID ค่ะ

ทีมตรวจสอบแล้วพบว่าเป็นบัคของ Video Editor รุ่นใหม่จริง เดิมระบบบันทึกค่าลงในโปรเจกต์ปัจจุบันได้ แต่ยังไม่มีปุ่มบันทึกค่าที่เลือกเป็นค่าเริ่มต้นของบัญชี จึงทำให้โปรเจกต์ใหม่ที่รับสคริปต์เข้ามาต้องกรอก ID ซ้ำ

เราแก้ไขและอัปเดตขึ้นระบบแล้ว ในขั้น “เสียงและองค์ประกอบ” สามารถกด “บันทึกเสียงนี้เป็นค่าเริ่มต้น” และ “บันทึกอวตารนี้เป็นค่าเริ่มต้น” ได้ หลังบันทึกแล้วโปรเจกต์ใหม่จะเติมค่าให้โดยอัตโนมัติ ส่วนโปรเจกต์เดิมยังคงใช้ค่าที่บันทึกไว้ในโปรเจกต์นั้น ไม่ถูกเขียนทับค่ะ

รบกวนเลือก Voice/Avatar ที่ต้องการแล้วกดบันทึกเป็นค่าเริ่มต้นอย่างละหนึ่งครั้ง หากยังพบว่าค่าไม่ติดสามารถแจ้งกลับมาได้ทันทีค่ะ`,
    auditNote:
      "Confirmed Editor V2 account-default persistence gap. Project drafts saved correctly, but V2 exposed no account-level write action. Fixed in v1.4.2 with explicit voice/avatar default controls, validated persistence, and auth recovery for provider/default APIs.",
    impactNote:
      "Current-project values were preserved, but fresh projects seeded without the user's preferred ElevenLabs voice and HeyGen avatar, requiring repeated manual entry.",
  },
] as const;

async function closeTicket(config: typeof TICKETS[number]) {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: config.id },
    include: { user: { select: { name: true, email: true } } },
  });
  if (!ticket) throw new Error(`support ticket not found: ${config.id}`);
  if (ticket.status === "CLOSED" && ticket.adminReply) {
    console.log(`[support] skip ${config.id}: already closed and replied`);
    return;
  }

  console.log(`[support] ${RUN ? "apply" : "dry-run"} ${config.id}`);
  console.log(config.reply);
  if (!RUN) return;

  const repliedAt = new Date();
  await prisma.supportTicket.update({
    where: { id: config.id },
    data: {
      adminReply: config.reply,
      repliedAt,
      status: "CLOSED",
      category: "BUG_CONFIRMED",
      severity: config.severity,
      recommendedAction: "FIX",
      auditNote: config.auditNote,
      impactNote: config.impactNote,
      auditedAt: repliedAt,
    },
  });
  await createNotification({
    userId: ticket.userId,
    type: "VIDEO_COMPLETED",
    title: "ทีมงานแก้ไขคำร้องของคุณแล้ว",
    body: config.reply,
  });

  if (ticket.user.email) {
    try {
      await sendSupportReplyEmail({
        userEmail: ticket.user.email,
        userName: ticket.user.name ?? "User",
        ticketId: ticket.id,
        adminReply: config.reply,
        originalMessage: ticket.message,
      });
      console.log(`[support] email sent ${config.id}`);
    } catch (error) {
      console.error(`[support] email failed ${config.id}:`, error);
    }
  }
  console.log(`[support] replied and closed ${config.id}`);
}

async function main() {
  for (const ticket of TICKETS) await closeTicket(ticket);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
