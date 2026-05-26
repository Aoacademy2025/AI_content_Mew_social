import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";

// GET /api/notifications — list for current user (excludes ERROR_SYSTEM — those go to admin dashboard only)
export async function GET() {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json([], { status: 401 });

  const notifications = await prisma.notification.findMany({
    where: {
      userId: authUser.id,
      NOT: { type: "ERROR_SYSTEM" },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return NextResponse.json(notifications);
}

// PATCH /api/notifications — mark all as read
export async function PATCH() {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({}, { status: 401 });

  await prisma.notification.updateMany({
    where: { userId: authUser.id, read: false },
    data: { read: true },
  });

  return NextResponse.json({ ok: true });
}

// DELETE /api/notifications — clear all
export async function DELETE() {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({}, { status: 401 });

  await prisma.notification.deleteMany({
    where: { userId: authUser.id },
  });

  return NextResponse.json({ ok: true });
}
