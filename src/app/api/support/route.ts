import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notifyAdmins, createNotification } from "@/lib/notifications";
import { apiError } from "@/lib/api-error";

export const maxDuration = 30;

// POST /api/support — submit support ticket
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.formData();
    const message = body.get("message") as string | null;
    const imageFile = body.get("image") as File | null;

    if (!message?.trim()) {
      return NextResponse.json({ error: "กรุณาระบุปัญหา" }, { status: 400 });
    }

    // Read image as base64 if provided
    let imageBase64: string | null = null;
    let imageName: string | null = null;
    if (imageFile && imageFile.size > 0) {
      const buf = await imageFile.arrayBuffer();
      imageBase64 = Buffer.from(buf).toString("base64");
      imageName = imageFile.name;
    }

    // Save ticket to database
    const ticket = await prisma.supportTicket.create({
      data: {
        userId: session.user.id,
        message: message.trim(),
        imageBase64,
        imageName,
      },
    });

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { name: true, email: true, plan: true },
    });

    // Notify all admins
    await notifyAdmins({
      type: "ERROR_SYSTEM",
      title: `🎫 Support #${ticket.id.slice(-6)}: ${user?.name ?? "User"}`,
      body: [
        `👤 ${user?.name ?? "?"} (${user?.email ?? "?"}) · ${user?.plan ?? "?"}`,
        `🆔 ${session.user.id}`,
        ``,
        message.trim(),
        imageName ? `📎 ${imageName}` : "",
      ].filter(Boolean).join("\n"),
    });

    // Confirm to user
    await createNotification({
      userId: session.user.id,
      type: "VIDEO_COMPLETED",
      title: "ส่งคำร้องสำเร็จ",
      body: "ทีมงานได้รับแจ้งปัญหาของคุณแล้ว จะติดต่อกลับทาง Email โดยเร็ว",
    });

    return NextResponse.json({ ok: true, ticketId: ticket.id });
  } catch (error) {
    return apiError({ route: "POST /api/support", error });
  }
}
