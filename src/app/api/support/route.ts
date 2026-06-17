import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { notifyAdmins, createNotification } from "@/lib/notifications";
import { apiError } from "@/lib/api-error";

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
  return ALLOWED_IMAGE_TYPES.has(file.type) || ALLOWED_IMAGE_EXTS.has(ext);
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
      imageContentType = imageFile.type || imageMimeFromName(imageFile.name) || "image/jpeg";
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
    // Admin → Settings (DB), fall back to env. n8n owns all ticket emails
    // (team notification + user acknowledgement) — see deploy/n8n/README.md.
    const supportConfig = await prisma.siteConfig.findUnique({ where: { key: "support_email" } });
    const supportEmail = supportConfig?.value || process.env.SUPPORT_EMAIL;
    const adminEmails = supportEmail ? supportEmail.split(",").map(e => e.trim()).filter(Boolean) : [];

    // Forward to n8n webhook (fire-and-forget — never block the user response).
    // If n8n is unreachable, the ticket is still saved (DB) and admins are
    // notified in-app; only the emails are skipped.
    const n8nUrl = process.env.N8N_SUPPORT_WEBHOOK_URL || process.env.N8N_WEBHOOK_URL;
    if (n8nUrl) {
      void fetch(n8nUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "support_ticket_created",
          ticketId: ticket.id,
          ticketShort: ticket.id.slice(-6),
          createdAt: ticket.createdAt.toISOString(),
          user: {
            id: authUser.id,
            name: user?.name ?? "User",
            email: user?.email ?? "",
            plan: user?.plan ?? "FREE",
            isPaid: user?.plan === "PRO" || user?.plan === "BUSINESS",
          },
          message: cleanMessage,
          // Support inboxes the platform notifies — n8n can CC/route to these
          supportEmails: adminEmails,
          attachment: imageName
            ? {
                name: imageName,
                contentType: imageContentType,
                // data URL so n8n can decode/attach without another request
                dataUrl: imageBase64 ? `data:${imageContentType};base64,${imageBase64}` : null,
              }
            : null,
        }),
      }).catch((e) => console.error("[support] n8n webhook failed:", e));
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
