import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { notifyAdmins, createNotification } from "@/lib/notifications";
import { apiError } from "@/lib/api-error";
import { sendSupportTicketEmail } from "@/lib/send-email";

export const maxDuration = 30;

// POST /api/support — submit support ticket
export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.formData();
    const message = body.get("message") as string | null;
    const imageFile = body.get("image") as File | null;

    if (!message?.trim()) {
      return NextResponse.json({ error: "กรุณาระบุปัญหา" }, { status: 400 });
    }

    // Read image as base64 if provided
    let imageBase64: string | null = null;
    let imageName: string | null = null;
    let imageBuffer: Buffer | null = null;
    let imageContentType: string | null = null;
    if (imageFile && imageFile.size > 0) {
      const buf = await imageFile.arrayBuffer();
      imageBuffer = Buffer.from(buf);
      imageBase64 = imageBuffer.toString("base64");
      imageName = imageFile.name;
      imageContentType = imageFile.type || "application/octet-stream";
    }

    // Save ticket to database
    const ticket = await prisma.supportTicket.create({
      data: {
        userId: authUser.id,
        message: message.trim(),
        imageBase64,
        imageName,
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
        message.trim(),
        imageName ? `📎 ${imageName}` : "",
      ].filter(Boolean).join("\n"),
    });

    // Send email to all support inboxes (comma-separated in env/DB)
    const supportEmail = process.env.SUPPORT_EMAIL;
    const adminEmails = supportEmail ? supportEmail.split(",").map(e => e.trim()).filter(Boolean) : [];
    if (adminEmails.length > 0) {
      await sendSupportTicketEmail({
        adminEmail: adminEmails,
        ticketId: ticket.id,
        userName: user?.name ?? "User",
        userEmail: user?.email ?? "",
        userPlan: user?.plan ?? "FREE",
        message: message.trim(),
        imageName,
        imageBuffer,
        imageContentType,
      });
    }

    // Forward to n8n webhook (fire-and-forget — never block the user response)
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
          message: message.trim(),
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
