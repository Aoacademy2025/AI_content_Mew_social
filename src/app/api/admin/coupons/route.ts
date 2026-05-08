import { NextResponse } from "next/server";
import { getServerSession, Session } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";

function isAdmin(session: Session | null) {
  return session?.user?.role === "ADMIN";
}

// GET — list all coupons
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!isAdmin(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const coupons = await prisma.coupon.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { redemptions: true } } },
    });
    return NextResponse.json(coupons);
  } catch (error) {
    return apiError({ route: "GET /api/admin/coupons", error });
  }
}

// POST — create coupon
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!isAdmin(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { code, plan = "PRO", durationDays = 30, maxUses = 1, expiresAt } = await req.json();
    if (!code?.trim()) return NextResponse.json({ error: "กรุณากรอกรหัสคูปอง" }, { status: 400 });

    const coupon = await prisma.coupon.create({
      data: {
        code: code.trim().toUpperCase(),
        plan,
        durationDays: Number(durationDays),
        maxUses: Number(maxUses),
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      },
    });
    return NextResponse.json(coupon);
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "P2002")
      return NextResponse.json({ error: "รหัสคูปองนี้มีอยู่แล้ว" }, { status: 400 });
    return apiError({ route: "POST /api/admin/coupons", error });
  }
}

// DELETE — delete coupon by id
export async function DELETE(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!isAdmin(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    await prisma.coupon.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError({ route: "DELETE /api/admin/coupons", error });
  }
}
