import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";

// PATCH /api/notifications/:id — mark single as read
export async function PATCH(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({}, { status: 401 });

  const { id } = await params;

  await prisma.notification.updateMany({
    where: { id, userId: authUser.id },
    data: { read: true },
  });

  return NextResponse.json({ ok: true });
}

// DELETE /api/notifications/:id — delete single
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({}, { status: 401 });

  const { id } = await params;

  await prisma.notification.deleteMany({
    where: { id, userId: authUser.id },
  });

  return NextResponse.json({ ok: true });
}
