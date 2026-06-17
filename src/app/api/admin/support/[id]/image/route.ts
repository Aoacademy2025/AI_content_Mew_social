import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";

function attachmentName(name: string | null) {
  if (!name) return "support-attachment";
  return name.replace(/[\r\n"]/g, "").slice(0, 120) || "support-attachment";
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const me = await prisma.user.findUnique({ where: { id: authUser.id }, select: { role: true } });
    if (me?.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { id } = await params;
    const ticket = await prisma.supportTicket.findUnique({
      where: { id },
      select: { imageBase64: true, imageName: true, imageMimeType: true },
    });
    if (!ticket?.imageBase64) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = Buffer.from(ticket.imageBase64, "base64");
    const contentType = ticket.imageMimeType ?? "image/jpeg";
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(body.length),
        "Content-Disposition": `inline; filename="${attachmentName(ticket.imageName)}"`,
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (error) {
    return apiError({ route: "GET /api/admin/support/[id]/image", error });
  }
}
