import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { notifyAdmins, createNotification } from "@/lib/notifications";
import { apiError } from "@/lib/api-error";
import { sendSupportTicketEmail, sendSupportAckEmail } from "@/lib/send-email";

export const maxDuration = 30;

const MAX_MESSAGE_CHARS = 1000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FORM_OVERHEAD_BYTES = 256 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const ALLOWED_IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function imageMimeFromName(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return null;
}

function isAllowedImage(file: File) {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  // Require a real image EXTENSION (the part we control when serving), and if the
  // client declared a content-type it must also be an allowed image type. The
  // previous `type OR ext` let an HTML payload through as e.g. "evil.png" with
  // type text/html, which was then served back and ran as script (stored XSS).
  return ALLOWED_IMAGE_EXTS.has(ext) && (file.type === "" || ALLOWED_IMAGE_TYPES.has(file.type));
}

// POST /api/support — submit support ticket
export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const contentLength = Number(req.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES + MAX_FORM_OVERHEAD_BYTES) {
      return NextResponse.json({ error: "รูปภาพต้องไม่เกิน 5 MB" }, { status: 413 });
    }

    const body = await req.formData();
    const message = body.get("message") as string | null;
    const imageFile = body.get("image") as File | null;
    const cleanMessage = message?.trim() ?? "";

    if (!cleanMessage) {
      return NextResponse.json({ error: "กรุณาระบุปัญหา" }, { status: 400 });
    }
    if (cleanMessage.length > MAX_MESSAGE_CHARS) {
      return NextResponse.json({ error: `ข้อความต้องไม่เกิน ${MAX_MESSAGE_CHARS} ตัวอักษร` }, { status: 400 });
    }

    // Read image as base64 if provided
    let imageBase64: string | null = null;
    let imageName: string | null = null;
    let imageBuffer: Buffer | null = null;
    let imageContentType: string | null = null;
    if (imageFile && imageFile.size > 0) {
      if (!isAllowedImage(imageFile)) {
        return NextResponse.json({ error: "รองรับเฉพาะรูป jpg, png, webp หรือ gif" }, { status: 400 });
      }
      if (imageFile.size > MAX_IMAGE_BYTES) {
        return NextResponse.json({ error: "รูปภาพต้องไม่เกิน 5 MB" }, { status: 413 });
      }
      const buf = await imageFile.arrayBuffer();
      imageBuffer = Buffer.from(buf);
      imageBase64 = imageBuffer.toString("base64");
      imageName = imageFile.name;
      // Store the MIME derived from the (allowlisted) extension only — never the
      // uploader-controlled file.type, which could be text/html and become stored
      // XSS when the admin views it.
      imageContentType = imageMimeFromName(imageFile.name) ?? "image/jpeg";
    }

    // Save ticket to database
    const ticket = await prisma.supportTicket.create({
      data: {
        userId: authUser.id,
        message: cleanMessage,
        imageBase64,
        imageName,
        imageMimeType: imageContentType,
      },
    });

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { name: true, email: true, plan: true },
    });

    // Notify all admins (in-app)
    await notifyAdmins({
      type: "ERROR_SYSTEM",
      title: `🎫 Support #${ticket.id.slice(-6)}: ${user?.name ?? "User"}`,
      body: [
        `👤 ${user?.name ?? "?"} (${user?.email ?? "?"}) · ${user?.plan ?? "?"}`,
        `🆔 ${authUser.id}`,
        ``,
        cleanMessage,
        imageName ? `📎 ${imageName}` : "",
      ].filter(Boolean).join("\n"),
    });

    // Resolve support inboxes (comma-separated). Prefer the value set in
    // Admin → Settings (DB), fall back to env.
    const supportConfig = await prisma.siteConfig.findUnique({ where: { key: "support_email" } });
    const supportEmail = supportConfig?.value || process.env.SUPPORT_EMAIL;
    const adminEmails = supportEmail ? supportEmail.split(",").map(e => e.trim()).filter(Boolean) : [];

    // Email notifications via the in-app sender (Resend). Fire-and-forget — never
    // block the user response; the ticket is already saved and admins are notified
    // in-app, so an email failure only skips the email (logged, not fatal).
    if (adminEmails.length > 0) {
      void sendSupportTicketEmail({
        adminEmail: adminEmails,
        ticketId: ticket.id,
        userName: user?.name ?? "User",
        userEmail: user?.email ?? "",
        userPlan: user?.plan ?? "FREE",
        message: cleanMessage,
        imageName,
        imageBuffer,
        imageContentType,
      }).then((ok) => { if (!ok) console.error("[support] team email failed for", ticket.id); });
    }
    if (user?.email) {
      void sendSupportAckEmail({
        userEmail: user.email,
        userName: user.name ?? "User",
        ticketId: ticket.id,
        message: cleanMessage,
      }).then((ok) => { if (!ok) console.error("[support] ack email failed for", ticket.id); });
    }

    // Confirm to user
    await createNotification({
      userId: authUser.id,
      type: "VIDEO_COMPLETED",
      title: "ส่งคำร้องสำเร็จ",
      body: "ทีมงานได้รับแจ้งปัญหาของคุณแล้ว จะติดต่อกลับทาง Email โดยเร็ว",
    });

    return NextResponse.json({ ok: true, ticketId: ticket.id });
  } catch (error) {
    return apiError({ route: "POST /api/support", error });
  }
}
