import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";

function attachmentName(name: string | null) {
  if (!name) return "support-attachment";
  return name.replace(/[\r\n"]/g, "").slice(0, 120) || "support-attachment";
}

// Derive the Content-Type from the file EXTENSION, never from the stored MIME
// (which originated from the uploader's user-controlled file.type). Returns null
// for anything that isn't a known image extension.
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
};
function imageMimeFromName(name: string | null): string | null {
  const ext = name?.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MIME_BY_EXT[ext] ?? null;
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
    // SECURITY: ignore the stored MIME (came from the uploader's file.type) and
    // recompute strictly from the extension allowlist, so a "support image" can
    // never be served as text/html and execute script in the admin origin
    // (stored XSS). Unknown extension → octet-stream + attachment so the browser
    // downloads rather than renders it. nosniff stops MIME sniffing; the CSP
    // sandbox neutralises any script even if a wrong type slipped through.
    const safeMime = imageMimeFromName(ticket.imageName);
    const contentType = safeMime ?? "application/octet-stream";
    const disposition = safeMime ? "inline" : "attachment";
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(body.length),
        "Content-Disposition": `${disposition}; filename="${attachmentName(ticket.imageName)}"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (error) {
    return apiError({ route: "GET /api/admin/support/[id]/image", error });
  }
}
