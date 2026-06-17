import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { createNotification } from "@/lib/notifications";
import { apiError } from "@/lib/api-error";
import { sendSupportReplyEmail } from "@/lib/send-email";

const SUPPORT_STATUSES = ["OPEN", "CLOSED"] as const;
const SUPPORT_CATEGORIES = ["BUG_CONFIRMED", "FEATURE_REQUEST", "USER_CONFUSION", "NEED_MORE_INFO", "NOT_A_BUG"] as const;
const SUPPORT_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
const SUPPORT_RECOMMENDATIONS = ["FIX", "ADD_FEATURE", "NEED_MORE_INFO", "WONT_FIX", "MONITOR"] as const;

function pickAllowed<T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] | null | undefined | NextResponse {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !allowed.includes(value)) {
    return NextResponse.json({ error: `${field} invalid` }, { status: 400 });
  }
  return value as T[number];
}

function cleanNullableText(value: unknown, max: number, field: string): string | null | undefined | NextResponse {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    return NextResponse.json({ error: `${field} invalid` }, { status: 400 });
  }
  const clean = value.trim();
  if (!clean) return null;
  if (clean.length > max) {
    return NextResponse.json({ error: `${field} too long` }, { status: 400 });
  }
  return clean;
}

// GET /api/admin/support — list all tickets (admin only)
export async function GET(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const me = await prisma.user.findUnique({ where: { id: authUser.id }, select: { role: true } });
    if (me?.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { searchParams } = new URL(req.url);
    const statusParam = searchParams.get("status") ?? "OPEN";
    const status = statusParam === "ALL" || SUPPORT_STATUSES.includes(statusParam as "OPEN" | "CLOSED")
      ? statusParam
      : "OPEN";

    const tickets = await prisma.supportTicket.findMany({
      where: status === "ALL" ? {} : { status: status as "OPEN" | "CLOSED" },
      select: {
        id: true,
        message: true,
        imageName: true,
        imageMimeType: true,
        status: true,
        adminReply: true,
        category: true,
        severity: true,
        recommendedAction: true,
        auditNote: true,
        impactNote: true,
        auditedAt: true,
        repliedAt: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { name: true, email: true, plan: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return NextResponse.json(tickets);
  } catch (error) {
    return apiError({ route: "GET /api/admin/support", error });
  }
}

// PATCH /api/admin/support — reply, close, and save triage audit fields
export async function PATCH(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const me = await prisma.user.findUnique({ where: { id: authUser.id }, select: { role: true } });
    if (me?.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json();
    const { ticketId, reply } = body;
    if (!ticketId) return NextResponse.json({ error: "ticketId required" }, { status: 400 });

    const status = pickAllowed(body.status, SUPPORT_STATUSES, "status");
    if (status instanceof NextResponse) return status;
    const category = pickAllowed(body.category, SUPPORT_CATEGORIES, "category");
    if (category instanceof NextResponse) return category;
    const severity = pickAllowed(body.severity, SUPPORT_SEVERITIES, "severity");
    if (severity instanceof NextResponse) return severity;
    const recommendedAction = pickAllowed(body.recommendedAction, SUPPORT_RECOMMENDATIONS, "recommendedAction");
    if (recommendedAction instanceof NextResponse) return recommendedAction;
    const auditNote = cleanNullableText(body.auditNote, 1200, "auditNote");
    if (auditNote instanceof NextResponse) return auditNote;
    const impactNote = cleanNullableText(body.impactNote, 800, "impactNote");
    if (impactNote instanceof NextResponse) return impactNote;
    const cleanReply = typeof reply === "string" ? reply.trim() : "";
    const hasAuditUpdate = category !== undefined || severity !== undefined || recommendedAction !== undefined
      || auditNote !== undefined || impactNote !== undefined;

    const ticket = await prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        adminReply: cleanReply || undefined,
        repliedAt: cleanReply ? new Date() : undefined,
        status: status ?? undefined,
        category: category === undefined ? undefined : category,
        severity: severity === undefined ? undefined : severity,
        recommendedAction: recommendedAction === undefined ? undefined : recommendedAction,
        auditNote: auditNote === undefined ? undefined : auditNote,
        impactNote: impactNote === undefined ? undefined : impactNote,
        auditedAt: hasAuditUpdate ? new Date() : undefined,
      },
      include: { user: { select: { id: true, name: true, email: true, plan: true } } },
    });

    // Notify user in-app + send email reply
    if (cleanReply) {
      await createNotification({
        userId: ticket.userId,
        type: "VIDEO_COMPLETED",
        title: "ทีมงานตอบกลับคำร้องของคุณ",
        body: cleanReply,
      });
      if (ticket.user.email) {
        await sendSupportReplyEmail({
          userEmail: ticket.user.email,
          userName: ticket.user.name ?? "User",
          ticketId: ticket.id,
          adminReply: cleanReply,
          originalMessage: ticket.message,
        });
      }
    }

    return NextResponse.json({ ok: true, ticket });
  } catch (error) {
    return apiError({ route: "PATCH /api/admin/support", error });
  }
}
