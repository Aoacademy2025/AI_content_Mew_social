import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createNotification } from "@/lib/notifications";
import { apiError } from "@/lib/api-error";

// GET /api/admin/support — list all tickets (admin only)
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
    if (me?.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status") ?? "OPEN";

    const tickets = await prisma.supportTicket.findMany({
      where: status === "ALL" ? {} : { status: status as "OPEN" | "CLOSED" },
      include: { user: { select: { name: true, email: true, plan: true } } },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return NextResponse.json(tickets);
  } catch (error) {
    return apiError({ route: "GET /api/admin/support", error });
  }
}

// PATCH /api/admin/support — reply & close ticket
export async function PATCH(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
    if (me?.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { ticketId, reply, status } = await req.json();
    if (!ticketId) return NextResponse.json({ error: "ticketId required" }, { status: 400 });

    const ticket = await prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        adminReply: reply ?? undefined,
        repliedAt: reply ? new Date() : undefined,
        status: status ?? undefined,
      },
      include: { user: { select: { id: true, name: true } } },
    });

    // Notify user if reply was given
    if (reply) {
      await createNotification({
        userId: ticket.userId,
        type: "VIDEO_COMPLETED",
        title: "ทีมงานตอบกลับคำร้องของคุณ",
        body: reply,
      });
    }

    return NextResponse.json({ ok: true, ticket });
  } catch (error) {
    return apiError({ route: "PATCH /api/admin/support", error });
  }
}
