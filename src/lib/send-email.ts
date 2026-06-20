import { google } from "googleapis";
import { Resend } from "resend";

// ── Gmail API (primary) ──────────────────────────────────────────────────────
function getGmailTransport() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_USER } =
    process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN || !GMAIL_USER)
    return null;

  const oauth2 = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return { gmail: google.gmail({ version: "v1", auth: oauth2 }), user: GMAIL_USER };
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;       // raw binary
  contentType?: string;  // e.g. "image/png"
}

function makeRaw(opts: {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
}) {
  const boundary = `=_HeroAI_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const hasAttachments = opts.attachments && opts.attachments.length > 0;

  const headers = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    opts.replyTo ? `Reply-To: ${opts.replyTo}` : "",
    `Subject: =?UTF-8?B?${Buffer.from(opts.subject).toString("base64")}?=`,
    "MIME-Version: 1.0",
  ].filter(Boolean);

  let body: string;
  if (!hasAttachments) {
    headers.push('Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64");
    body = Buffer.from(opts.html).toString("base64");
  } else {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts: string[] = [
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(opts.html).toString("base64"),
    ];
    for (const att of opts.attachments!) {
      parts.push(
        `--${boundary}`,
        `Content-Type: ${att.contentType ?? "application/octet-stream"}; name="${att.filename}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${att.filename}"`,
        "",
        att.content.toString("base64"),
      );
    }
    parts.push(`--${boundary}--`);
    body = parts.join("\r\n");
  }
  const msg = [...headers, "", body].join("\r\n");
  return Buffer.from(msg).toString("base64url");
}

async function sendViaGmail(opts: {
  to: string | string[];
  replyTo?: string;
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
}): Promise<boolean> {
  const transport = getGmailTransport();
  if (!transport) return false;
  const recipients = Array.isArray(opts.to) ? opts.to.join(", ") : opts.to;
  try {
    const raw = makeRaw({
      from: transport.user,
      to: recipients,
      replyTo: opts.replyTo,
      subject: opts.subject,
      html: opts.html,
      attachments: opts.attachments,
    });
    await transport.gmail.users.messages.send({ userId: "me", requestBody: { raw } });
    console.log(`[send-email] Gmail API sent → ${recipients}${opts.attachments?.length ? ` (+${opts.attachments.length} attachment)` : ""}`);
    return true;
  } catch (e) {
    console.error("[send-email] Gmail API failed:", e);
    return false;
  }
}

// ── Resend (fallback) ────────────────────────────────────────────────────────
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const RESEND_FROM = process.env.RESEND_FROM ?? "onboarding@resend.dev";

async function sendViaResend(opts: {
  to: string | string[];
  replyTo?: string;
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
}): Promise<boolean> {
  if (!resend) return false;
  try {
    const result = await resend.emails.send({
      from: RESEND_FROM,
      to: opts.to,
      replyTo: opts.replyTo || undefined,
      subject: opts.subject,
      html: opts.html,
      attachments: opts.attachments?.map(a => ({ filename: a.filename, content: a.content })),
    });
    console.log("[send-email] Resend result:", JSON.stringify(result));
    return !result.error;
  } catch (e) {
    console.error("[send-email] Resend failed:", e);
    return false;
  }
}

// Gmail first, Resend as fallback
async function sendEmail(opts: {
  to: string | string[];
  replyTo?: string;
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
}): Promise<boolean> {
  if (await sendViaGmail(opts)) return true;
  return sendViaResend(opts);
}

// ── Email templates ──────────────────────────────────────────────────────────

const BRAND = "Hero AI Creator Studio";
const APP_URL = process.env.NEXTAUTH_URL?.replace(/\/$/, "") ?? "";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Wrap content in a premium-looking email shell with logo header + footer */
function emailShell(opts: { title: string; previewText?: string; body: string; accent?: string }): string {
  const accent = opts.accent ?? "#22d3ee";
  const preview = opts.previewText ? `<div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:#fff;line-height:1px;mso-hide:all">${escapeHtml(opts.previewText)}</div>` : "";
  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(opts.title)}</title></head>
<body style="margin:0;padding:0;background:#0a0a14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Sarabun',Roboto,sans-serif;color:#e5e7eb;line-height:1.5">
  ${preview}
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0a0a14;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:linear-gradient(180deg,#14141f 0%,#0e0e16 100%);border:1px solid rgba(124,58,237,0.25);border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.5)">

        <!-- Header -->
        <tr><td style="padding:24px 28px 20px;background:linear-gradient(135deg,rgba(124,58,237,0.18) 0%,rgba(34,211,238,0.08) 100%);border-bottom:1px solid rgba(124,58,237,0.18)">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
            <td style="vertical-align:middle">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                <td style="background:linear-gradient(135deg,#0080ff,#7c3aed);width:32px;height:32px;border-radius:8px;text-align:center;color:#fff;font-weight:900;font-size:16px;line-height:32px">✦</td>
                <td style="padding-left:10px;color:#fff;font-size:15px;font-weight:700;letter-spacing:-0.2px">${BRAND}</td>
              </tr></table>
            </td>
            <td style="text-align:right;color:#71717a;font-size:11px">${new Date().toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" })}</td>
          </tr></table>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:28px">${opts.body}</td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 28px;background:rgba(0,0,0,0.25);border-top:1px solid rgba(255,255,255,0.04);color:#52525b;font-size:11px;text-align:center">
          อีเมลนี้ส่งโดย <span style="color:${accent}">${BRAND}</span><br>
          ${APP_URL ? `<a href="${APP_URL}" style="color:#71717a;text-decoration:none">${APP_URL.replace(/^https?:\/\//, "")}</a>` : ""}
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

function premiumButton(opts: { href: string; label: string; color?: string }): string {
  const color = opts.color ?? "linear-gradient(135deg,#7c3aed,#22d3ee)";
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0"><tr><td style="border-radius:10px;background:${color};box-shadow:0 6px 20px rgba(124,58,237,0.35)"><a href="${opts.href}" style="display:inline-block;padding:11px 22px;color:#fff;font-weight:700;font-size:13px;text-decoration:none;letter-spacing:0.2px">${escapeHtml(opts.label)}</a></td></tr></table>`;
}

// ── Public API ───────────────────────────────────────────────────────────────
export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<boolean> {
  return sendEmail({
    to,
    subject: `รีเซ็ตรหัสผ่าน — ${BRAND}`,
    html: emailShell({
      title: "รีเซ็ตรหัสผ่าน",
      previewText: "คลิกลิงก์ภายใน 1 ชั่วโมงเพื่อรีเซ็ตรหัสผ่านของคุณ",
      body: `
<h1 style="margin:0 0 8px;color:#fff;font-size:20px;font-weight:700">รีเซ็ตรหัสผ่าน</h1>
<p style="margin:0 0 18px;color:#a1a1aa;font-size:14px">คลิกปุ่มด้านล่างเพื่อตั้งรหัสผ่านใหม่ — ลิงก์มีอายุ <b style="color:#fff">1 ชั่วโมง</b></p>
${premiumButton({ href: resetUrl, label: "ตั้งรหัสผ่านใหม่" })}
<p style="margin:20px 0 0;color:#71717a;font-size:11px">หากปุ่มกดไม่ได้ คัดลอกลิงก์นี้:<br><span style="color:#a1a1aa;word-break:break-all">${escapeHtml(resetUrl)}</span></p>
<hr style="border:none;border-top:1px solid rgba(255,255,255,0.05);margin:24px 0">
<p style="margin:0;color:#52525b;font-size:11px">หากคุณไม่ได้ขอรีเซ็ตรหัสผ่าน ไม่ต้องดำเนินการใดๆ — บัญชีของคุณยังคงปลอดภัย</p>
`.trim(),
    }),
  });
}

export async function sendSupportTicketEmail(opts: {
  adminEmail: string | string[];
  ticketId: string;
  userName: string;
  userEmail: string;
  userPlan: string;
  message: string;
  imageName?: string | null;
  imageBuffer?: Buffer | null;
  imageContentType?: string | null;
}): Promise<boolean> {
  const recipients = Array.isArray(opts.adminEmail) ? opts.adminEmail : opts.adminEmail.split(",").map(e => e.trim()).filter(Boolean);
  console.log("[send-email] Sending ticket email → TO:", recipients);

  const isPaid = opts.userPlan === "PRO" || opts.userPlan === "BUSINESS";
  const planColor = opts.userPlan === "BUSINESS" ? "#a78bfa" : opts.userPlan === "PRO" ? "#fbbf24" : "#a1a1aa";
  const planBg    = opts.userPlan === "BUSINESS" ? "rgba(167,139,250,0.15)" : opts.userPlan === "PRO" ? "rgba(251,191,36,0.15)" : "rgba(161,161,170,0.12)";
  const priorityBadge = isPaid
    ? `<span style="display:inline-block;background:linear-gradient(135deg,rgba(124,58,237,0.25),rgba(34,211,238,0.18));border:1px solid rgba(124,58,237,0.4);color:#c4b5fd;padding:3px 9px;border-radius:99px;font-size:11px;font-weight:700;letter-spacing:0.3px">⚡ PRIORITY</span>`
    : "";
  const adminLink = APP_URL ? `${APP_URL}/admin?tab=support&ticket=${opts.ticketId}` : "";

  const attachments: EmailAttachment[] = [];
  if (opts.imageBuffer && opts.imageName) {
    attachments.push({
      filename: opts.imageName,
      content: opts.imageBuffer,
      contentType: opts.imageContentType ?? "application/octet-stream",
    });
  }

  return sendEmail({
    to: recipients,
    replyTo: opts.userEmail,
    subject: `${isPaid ? `[${opts.userPlan}] ` : ""}🎫 #${opts.ticketId.slice(-6)} · ${opts.userName}`,
    attachments,
    html: emailShell({
      title: "Support Ticket ใหม่",
      previewText: opts.message.slice(0, 120),
      accent: planColor,
      body: `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
  <td style="vertical-align:middle">
    <span style="color:#71717a;font-size:11px;letter-spacing:1.5px;text-transform:uppercase">Support Ticket</span>
    <h1 style="margin:4px 0 0;color:#fff;font-size:22px;font-weight:700">#${opts.ticketId.slice(-6)}</h1>
  </td>
  <td style="text-align:right;vertical-align:middle">${priorityBadge}</td>
</tr></table>

<div style="margin:18px 0;padding:16px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:12px">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
    <td style="vertical-align:middle">
      <div style="color:#fff;font-size:14px;font-weight:600">${escapeHtml(opts.userName)}</div>
      <div style="color:#71717a;font-size:12px;margin-top:2px"><a href="mailto:${opts.userEmail}" style="color:#71717a;text-decoration:none">${escapeHtml(opts.userEmail)}</a></div>
    </td>
    <td style="text-align:right;vertical-align:middle">
      <span style="display:inline-block;background:${planBg};color:${planColor};padding:4px 10px;border-radius:99px;font-size:11px;font-weight:700">${opts.userPlan}</span>
    </td>
  </tr></table>
</div>

<div style="margin:0 0 8px;color:#71717a;font-size:11px;letter-spacing:1px;text-transform:uppercase">ข้อความ</div>
<div style="padding:18px;background:rgba(0,0,0,0.3);border-left:3px solid ${planColor};border-radius:8px;color:#e5e7eb;font-size:14px;white-space:pre-wrap;word-wrap:break-word">${escapeHtml(opts.message)}</div>

${opts.imageName ? `
<div style="margin:18px 0 0;padding:12px 14px;background:rgba(34,211,238,0.06);border:1px solid rgba(34,211,238,0.2);border-radius:10px;color:#a5f3fc;font-size:12px">
  📎 <b style="color:#fff">ไฟล์แนบ:</b> ${escapeHtml(opts.imageName)} ${opts.imageBuffer ? "<span style=\"color:#71717a\">(แนบในอีเมล)</span>" : ""}
</div>` : ""}

${adminLink ? `<div style="margin:24px 0 8px">${premiumButton({ href: adminLink, label: "เปิดใน Admin Panel →" })}</div>` : ""}

<hr style="border:none;border-top:1px solid rgba(255,255,255,0.05);margin:24px 0 16px">
<p style="margin:0;color:#52525b;font-size:11px">💡 ตอบกลับอีเมลนี้โดยตรงเพื่อส่งข้อความถึง user (Reply-To ตั้งไว้แล้ว) หรือเปิดใน Admin Panel เพื่อตอบผ่านระบบ</p>
`.trim(),
    }),
  });
}

/** Acknowledgement to the user right after they submit a ticket. */
export async function sendSupportAckEmail(opts: {
  userEmail: string;
  userName: string;
  ticketId: string;
  message: string;
}): Promise<boolean> {
  return sendEmail({
    to: opts.userEmail,
    subject: `ได้รับคำร้องของคุณแล้ว #${opts.ticketId.slice(-6)} — ${BRAND}`,
    html: emailShell({
      title: "ได้รับคำร้องแล้ว",
      previewText: "ทีมงานได้รับคำร้องของคุณแล้ว จะติดต่อกลับโดยเร็ว",
      body: `
<span style="color:#71717a;font-size:11px;letter-spacing:1.5px;text-transform:uppercase">Support · #${opts.ticketId.slice(-6)}</span>
<h1 style="margin:4px 0 14px;color:#fff;font-size:22px;font-weight:700">สวัสดีคุณ ${escapeHtml(opts.userName)} 👋</h1>
<p style="margin:0 0 18px;color:#a1a1aa;font-size:14px">เราได้รับคำร้องของคุณแล้ว ✅ ทีมงานจะติดต่อกลับทางอีเมลนี้โดยเร็วที่สุด (ปกติภายใน 24 ชั่วโมง)</p>

<div style="margin:0 0 8px;color:#71717a;font-size:11px;letter-spacing:1px;text-transform:uppercase">ข้อความที่คุณส่ง</div>
<div style="padding:18px;background:rgba(0,0,0,0.3);border-left:3px solid #22d3ee;border-radius:8px;color:#e5e7eb;font-size:14px;white-space:pre-wrap;word-wrap:break-word">${escapeHtml(opts.message)}</div>

<hr style="border:none;border-top:1px solid rgba(255,255,255,0.05);margin:24px 0 16px">
<p style="margin:0;color:#52525b;font-size:11px">ขอบคุณที่แจ้งเข้ามา — ทีมงาน ${BRAND}</p>
`.trim(),
    }),
  });
}

export async function sendSupportReplyEmail(opts: {
  userEmail: string;
  userName: string;
  ticketId: string;
  adminReply: string;
  originalMessage?: string;
}): Promise<boolean> {
  const ticketLink = APP_URL ? `${APP_URL}/settings?tab=billing` : "";
  return sendEmail({
    to: opts.userEmail,
    subject: `ทีมงานตอบกลับ #${opts.ticketId.slice(-6)} — ${BRAND}`,
    html: emailShell({
      title: "ทีมงานตอบกลับ",
      previewText: opts.adminReply.slice(0, 120),
      body: `
<span style="color:#71717a;font-size:11px;letter-spacing:1.5px;text-transform:uppercase">Reply · #${opts.ticketId.slice(-6)}</span>
<h1 style="margin:4px 0 14px;color:#fff;font-size:22px;font-weight:700">สวัสดีคุณ ${escapeHtml(opts.userName)} 👋</h1>
<p style="margin:0 0 18px;color:#a1a1aa;font-size:14px">ทีมงานได้ตอบกลับคำร้องของคุณแล้ว</p>

<div style="padding:18px;background:linear-gradient(135deg,rgba(34,211,238,0.08),rgba(124,58,237,0.06));border:1px solid rgba(34,211,238,0.25);border-radius:12px;color:#e5e7eb;font-size:14px;white-space:pre-wrap;word-wrap:break-word">${escapeHtml(opts.adminReply)}</div>

${opts.originalMessage ? `
<div style="margin:18px 0 0;padding:12px 14px;background:rgba(255,255,255,0.02);border-left:2px solid rgba(255,255,255,0.1);border-radius:6px">
  <div style="color:#52525b;font-size:10px;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px">คำร้องเดิมของคุณ</div>
  <div style="color:#71717a;font-size:12px;white-space:pre-wrap;word-wrap:break-word">${escapeHtml(opts.originalMessage)}</div>
</div>` : ""}

${ticketLink ? `<div style="margin:24px 0 8px">${premiumButton({ href: ticketLink, label: "เปิดระบบ Support" })}</div>` : ""}

<hr style="border:none;border-top:1px solid rgba(255,255,255,0.05);margin:24px 0 16px">
<p style="margin:0;color:#71717a;font-size:12px">มีข้อสงสัยเพิ่มเติม? ส่งคำร้องใหม่ได้จาก Sidebar → <b style="color:#fff">Support</b></p>
<p style="margin:6px 0 0;color:#52525b;font-size:11px">ขอบคุณที่ใช้บริการ — ทีมงาน ${BRAND}</p>
`.trim(),
    }),
  });
}

export async function sendRenewalReminderEmail(opts: { to: string; plan: string; daysLeft: number; pricingUrl: string }): Promise<boolean> {
  return sendEmail({
    to: opts.to,
    subject: `แพ็ก ${opts.plan} ใกล้หมดอายุ (อีก ${opts.daysLeft} วัน) — ${BRAND}`,
    html: emailShell({
      title: "ต่ออายุแพ็กเกจ",
      previewText: `แพ็ก ${opts.plan} หมดอายุในอีก ${opts.daysLeft} วัน — ต่อก่อนหมดล็อกราคาผู้ก่อตั้ง`,
      body: `
<h1 style="margin:0 0 8px;color:#fff;font-size:20px;font-weight:700">แพ็ก ${escapeHtml(opts.plan)} ใกล้หมดอายุ</h1>
<p style="margin:0 0 18px;color:#a1a1aa;font-size:14px">แพ็กเกจของคุณจะหมดอายุในอีก <b style="color:#fff">${opts.daysLeft} วัน</b> — ต่ออายุตอนนี้เพื่อใช้งานต่อแบบไม่สะดุด</p>
${premiumButton({ href: opts.pricingUrl, label: "ต่ออายุเลย" })}
<hr style="border:none;border-top:1px solid rgba(255,255,255,0.05);margin:24px 0 16px">
<p style="margin:0;color:#71717a;font-size:12px">💡 ต่อก่อนหมดอายุ = ล็อกราคาผู้ก่อตั้งไว้</p>
`.trim(),
    }),
  });
}

/** Admin alert when server disk crosses the configured threshold. */
export async function sendDiskAlertEmail(opts: {
  to: string | string[];
  mount: string;
  usedPercent: number;
  usedGb: number;
  totalGb: number;
  availableGb: number;
  breakdown: string[];
  sweptMb: number;
}): Promise<boolean> {
  const rows = opts.breakdown.map((b) => `<li style="margin:3px 0">${escapeHtml(b)}</li>`).join("");
  return sendEmail({
    to: opts.to,
    subject: `⚠️ ดิสก์เซิร์ฟเวอร์ใกล้เต็ม ${opts.usedPercent}% — ${BRAND}`,
    html: emailShell({
      title: "ดิสก์ใกล้เต็ม",
      previewText: `ใช้ไป ${opts.usedGb}/${opts.totalGb} GB (${opts.usedPercent}%) เหลือ ${opts.availableGb} GB`,
      accent: "#f59e0b",
      body: `
<h1 style="margin:0 0 8px;color:#fff;font-size:20px;font-weight:700">⚠️ ดิสก์เซิร์ฟเวอร์ใกล้เต็ม</h1>
<p style="margin:0 0 16px;color:#a1a1aa;font-size:14px">Mount <b style="color:#fff">${escapeHtml(opts.mount)}</b> ใช้ไป <b style="color:#fff">${opts.usedGb} / ${opts.totalGb} GB (${opts.usedPercent}%)</b> — เหลือ ${opts.availableGb} GB</p>
<div style="margin:0 0 8px;color:#71717a;font-size:11px;letter-spacing:1px;text-transform:uppercase">แยกตามหมวด</div>
<ul style="margin:0 0 16px;padding-left:18px;color:#e5e7eb;font-size:13px">${rows}</ul>
${opts.sweptMb > 0 ? `<p style="margin:0 0 8px;color:#34d399;font-size:12px">🧹 กวาดของขยะอัตโนมัติแล้ว ${opts.sweptMb} MB</p>` : ""}
<hr style="border:none;border-top:1px solid rgba(255,255,255,0.05);margin:20px 0 12px">
<p style="margin:0;color:#71717a;font-size:12px">ตรวจ orphan media / stock cache / swap เพิ่มเติมที่ Admin → จัดการพื้นที่ดิสก์</p>
`.trim(),
    }),
  });
}
