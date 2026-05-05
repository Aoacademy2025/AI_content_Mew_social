import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<boolean> {
  if (!process.env.RESEND_API_KEY) {
    console.warn("[send-email] RESEND_API_KEY not set — reset URL:", resetUrl);
    return false;
  }

  const fromEmail = process.env.RESEND_FROM ?? "onboarding@resend.dev";

  const { error } = await resend.emails.send({
    from: `AI Content Studio <${fromEmail}>`,
    to,
    subject: "รีเซ็ตรหัสผ่าน — AI Content Studio",
    html: `
<!DOCTYPE html>
<html lang="th">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0f0f0f;font-family:sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f0f;padding:40px 0;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#1a1a1a;border-radius:12px;padding:40px;border:1px solid #333;">
        <tr><td style="text-align:center;padding-bottom:24px;">
          <h1 style="color:#fff;margin:0;font-size:22px;">ลืมรหัสผ่าน?</h1>
          <p style="color:#aaa;margin:8px 0 0;font-size:14px;">คุณได้ร้องขอการรีเซ็ตรหัสผ่าน</p>
        </td></tr>
        <tr><td style="text-align:center;padding:16px 0 24px;">
          <a href="${resetUrl}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;">
            รีเซ็ตรหัสผ่าน
          </a>
        </td></tr>
        <tr><td style="color:#666;font-size:12px;text-align:center;line-height:1.6;">
          <p>ลิงก์นี้จะหมดอายุใน <strong style="color:#aaa;">1 ชั่วโมง</strong></p>
          <p>หากคุณไม่ได้ร้องขอ กรุณาละเว้นอีเมลนี้</p>
          <p style="margin-top:16px;word-break:break-all;color:#555;">${resetUrl}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });

  if (error) {
    console.error("[send-email] Resend error:", error);
    return false;
  }

  return true;
}
