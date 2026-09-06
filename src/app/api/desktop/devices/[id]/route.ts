import { NextResponse } from "next/server";
import { withDesktop } from "@/lib/desktop/with-desktop";
import { desktopJson } from "@/lib/desktop/http";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

function seatIdFromRequest(req: Request): string | null {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const id = parts[parts.length - 1];
  return id && id !== "devices" ? decodeURIComponent(id) : null;
}

export const DELETE = withDesktop(async (req, principal) => {
  const id = seatIdFromRequest(req);
  if (!id) {
    return desktopJson(404, "NOT_FOUND", "ไม่พบอุปกรณ์นี้ — รีเฟรชหน้ารายการแล้วลองใหม่");
  }

  const seat = await prisma.deviceSeat.findUnique({ where: { id } });
  if (!seat || seat.userId !== principal.userId) {
    return desktopJson(404, "NOT_FOUND", "ไม่พบอุปกรณ์นี้ — รีเฟรชหน้ารายการแล้วลองใหม่");
  }

  if (!seat.revokedAt) {
    await prisma.deviceSeat.update({
      where: { id: seat.id },
      data: { revokedAt: new Date() },
    });
  }

  return NextResponse.json({ ok: true });
});
