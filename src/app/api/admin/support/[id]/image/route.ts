import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";

// Build a Content-Disposition header that is safe for HTTP. The raw filename can
// contain non-Latin-1 chars (e.g. Thai "สกรีนช็อต …"), and Node/undici reject any
// header value with a code point > 255 (ByteString error → the route 500s and the
// admin can't view the attachment). So we emit BOTH: an ASCII-only `filename=`
// fallback (non-ASCII → "_") and an RFC 5987 `filename*=UTF-8''…` for modern browsers.
function contentDisposition(disposition: string, name: string | null) {
  const raw = (name ?? "support-attachment").replace(/[\r\n"]/g, "").slice(0, 120) || "support-attachment";
  const ascii = raw.replace(/[^\x20-\x7E]/g, "_");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
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
        "Content-Disposition": contentDisposition(disposition, ticket.imageName),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (error) {
    return apiError({ route: "GET /api/admin/support/[id]/image", error });
  }
}
