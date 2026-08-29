/**
 * Reply to and close the three verified video-stability tickets only after the
 * #403/#404 release is live and production checks pass.
 *
 * Dry-run: npx tsx scripts/ops-close-2026-08-29-video-stability-tickets.ts
 * Apply:   RUN=1 npx tsx scripts/ops-close-2026-08-29-video-stability-tickets.ts
 *
 * Idempotent: an already replied/closed ticket is left untouched. Unexpected
 * intermediate state fails closed instead of overwriting a human response.
 */
import { prisma } from "../src/lib/prisma";
import { createNotification } from "../src/lib/notifications";
import { sendSupportReplyEmail } from "../src/lib/send-email";

const RUN = process.env.RUN === "1";

const TICKETS = [
  {
    id: "cmtdys0wk00sllchdq4x905ee",
    severity: "MEDIUM",
    reply: `สวัสดีครับ ขอบคุณที่แจ้งเรื่องวิดีโอแบบอัปโหลด Avatar ใช้เวลาส่งออกนานครับ

ทีมตรวจสอบประวัติงานแล้วพบว่างานก่อนหน้าหยุดก่อนเสร็จ แต่การสร้างและส่งออกครั้งถัดมาของบัญชีเสร็จสมบูรณ์แล้ว และไม่พบงานเดิมค้างอยู่ในคิว ณ เวลาที่ตรวจสอบ

เราได้เพิ่มการป้องกันงาน Avatar ที่ยาวเกินขอบเขตที่รองรับก่อนเริ่มใช้บริการภายนอก และเพิ่มการกู้คืน subtitle alignment ที่ล้มชั่วคราวโดยอัตโนมัติหนึ่งครั้ง เพื่อลดกรณีงานค้างหรือต้องเริ่มใหม่ทั้งคลิป

แนะนำให้รีเฟรช Video Editor ก่อนสร้างงานครั้งถัดไป หากยังพบว่างานค้างนานผิดปกติ สามารถแจ้งกลับพร้อมเวลาที่เริ่มงานได้ทันทีครับ`,
    auditNote:
      "Production audit found earlier avatar attempts canceled near completion; later create and export jobs completed. The 2026-08-29 release adds full-avatar admission control and bounded subtitle-alignment recovery.",
    impactNote:
      "The reported attempt did not complete, but subsequent create/export work on the same account completed and no original job remained queued at audit time.",
  },
  {
    id: "cmte9tffk01gflcp36vnhq6wm",
    severity: "HIGH",
    reply: `สวัสดีครับ ขอบคุณที่แจ้งปัญหาคลิปประมาณ 5 นาทีรันไม่สำเร็จครับ

ทีมตรวจสอบยืนยันว่าเป็นงาน Full Avatar ที่เสียงจริงยาวประมาณ 5 นาที 51 วินาที ซึ่งเกินขอบเขตที่เส้นทางประมวลผลนี้รองรับและจบด้วย timeout ส่วนงานที่ลองใหม่ด้วยโหมด Bookend เสร็จสมบูรณ์แล้ว

เราแก้ไขและอัปเดตขึ้นระบบแล้ว ตอนนี้ Full Avatar รองรับคลิปไม่เกิน 5 นาที หากสคริปต์ยาวกว่านั้นระบบจะหยุดก่อนสร้างเสียงหรือเริ่มใช้ HeyGen พร้อมแนะนำให้เปลี่ยนเป็น Bookend แบบเปิดคลิปหรือเปิด+ปิด จึงไม่เสียเวลาหรือค่า provider ไปกับงานที่ระบบรองรับไม่ไหว

สำหรับคลิปยาวเกิน 5 นาที กรุณาใช้ Bookend หากยังรันไม่สำเร็จสามารถแจ้งกลับมาได้ทันทีครับ`,
    auditNote:
      "Confirmed a 350.8s full-avatar job reached COMPOSITE_TIMEOUT after expensive upstream work. A later bookend retry completed. Fixed with a five-minute pre-spend admission envelope and exact post-TTS backstop.",
    impactNote:
      "The original full-avatar request consumed significant processing time before failing; the user's later bookend retry completed successfully.",
  },
  {
    id: "cmte9tu7t01h4lcp31q3yigfl",
    severity: "MEDIUM",
    reply: `สวัสดีครับ ทีมตรวจสอบรูปที่ส่งมาแล้ว และนำไปตรวจร่วมกับคำร้องเรื่องคลิปประมาณ 5 นาทีรันไม่สำเร็จครับ

สาเหตุคือคลิป Full Avatar มีเสียงจริงประมาณ 5 นาที 51 วินาที ซึ่งเกินขอบเขตของเส้นทางประมวลผลเดิม ส่วนงานที่เปลี่ยนเป็น Bookend ภายหลังเสร็จสมบูรณ์แล้ว

เราอัปเดตระบบให้ตรวจตั้งแต่ก่อนเริ่มงานแล้ว: Full Avatar รองรับไม่เกิน 5 นาที และคลิปที่ยาวกว่าจะได้รับคำแนะนำให้เปลี่ยนเป็น Bookend ก่อนใช้เวลาและค่า provider หากยังพบอาการเดิมหลังรีเฟรช Video Editor สามารถแจ้งกลับมาได้ทันทีครับ`,
    auditNote:
      "Screenshot-only follow-up correlated with the same 350.8s full-avatar COMPOSITE_TIMEOUT incident. The later bookend retry completed; the release now rejects unsupported full-avatar duration before spend.",
    impactNote:
      "This ticket supplied supporting evidence for the same long full-avatar failure; no separate unresolved production job was identified.",
  },
] as const;

let emailFailures = 0;

async function closeTicket(config: (typeof TICKETS)[number]) {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: config.id },
    include: { user: { select: { name: true, email: true } } },
  });
  if (!ticket) throw new Error(`support ticket not found: ${config.id}`);
  if (ticket.status === "CLOSED" && ticket.adminReply === config.reply) {
    console.log(`[support] skip ${config.id}: already closed with the expected reply`);
    return;
  }
  if (ticket.status !== "OPEN" || ticket.adminReply) {
    throw new Error(
      `unexpected ticket state ${config.id}: status=${ticket.status} replied=${Boolean(ticket.adminReply)}`,
    );
  }

  console.log(
    `[support] ${RUN ? "apply" : "dry-run"} ${config.id} severity=${config.severity} email=${Boolean(ticket.user.email)}`,
  );
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
    title: "ทีมงานตรวจสอบและแก้ไขคำร้องของคุณแล้ว",
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
      emailFailures += 1;
      console.error(`[support] email failed ${config.id}:`, error);
    }
  }
  console.log(`[support] replied and closed ${config.id}`);
}

async function main() {
  for (const ticket of TICKETS) await closeTicket(ticket);

  if (!RUN) {
    console.log(`[support] complete mode=dry-run tickets=${TICKETS.length}`);
    return;
  }

  const savedTickets = await prisma.supportTicket.findMany({
    where: { id: { in: TICKETS.map((ticket) => ticket.id) } },
    select: {
      id: true,
      userId: true,
      status: true,
      adminReply: true,
      repliedAt: true,
      category: true,
      severity: true,
      recommendedAction: true,
      auditNote: true,
      impactNote: true,
    },
    orderBy: { id: "asc" },
  });
  const expectedById = new Map<string, (typeof TICKETS)[number]>(
    TICKETS.map((ticket) => [ticket.id, ticket]),
  );
  const verification = await Promise.all(
    savedTickets.map(async (ticket) => {
      const expected = expectedById.get(ticket.id);
      const notificationCount = await prisma.notification.count({
        where: {
          userId: ticket.userId,
          title: "ทีมงานตรวจสอบและแก้ไขคำร้องของคุณแล้ว",
          body: ticket.adminReply ?? "",
        },
      });
      return {
        id: ticket.id,
        status: ticket.status,
        replied: ticket.adminReply === expected?.reply,
        repliedAt: ticket.repliedAt?.toISOString() ?? null,
        category: ticket.category,
        severity: ticket.severity,
        recommendedAction: ticket.recommendedAction,
        auditNoteSaved: ticket.auditNote === expected?.auditNote,
        impactNoteSaved: ticket.impactNote === expected?.impactNote,
        notificationCount,
      };
    }),
  );
  console.log(`[support] verify ${JSON.stringify(verification)}`);

  if (
    verification.length !== TICKETS.length
    || verification.some((ticket) => (
      ticket.status !== "CLOSED"
      || !ticket.replied
      || !ticket.repliedAt
      || ticket.category !== "BUG_CONFIRMED"
      || ticket.recommendedAction !== "FIX"
      || !ticket.auditNoteSaved
      || !ticket.impactNoteSaved
      || ticket.notificationCount < 1
    ))
  ) {
    throw new Error("support ticket verification failed");
  }
  console.log(
    `[support] complete mode=apply tickets=${TICKETS.length} emailFailures=${emailFailures}`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
