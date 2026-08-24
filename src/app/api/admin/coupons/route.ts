import { NextResponse } from "next/server";
import type { Coupon, Prisma } from "@prisma/client";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";

function isAdmin(user: { role?: string } | null) {
  return user?.role === "ADMIN";
}

function couponSnapshot(coupon: Coupon) {
  return JSON.stringify({
    code: coupon.code,
    type: coupon.type,
    plan: coupon.plan,
    durationDays: coupon.durationDays,
    maxUses: coupon.maxUses,
    usedCount: coupon.usedCount,
    expiresAt: coupon.expiresAt?.toISOString() ?? null,
    isActive: coupon.isActive,
    stackingPolicy: coupon.stackingPolicy,
    promoCredits: coupon.promoCredits,
    promoCreditTtlDays: coupon.promoCreditTtlDays,
  });
}

function finiteInteger(value: unknown, fallback: number) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

function parseExpiry(value: unknown): Date | null | "invalid" {
  if (value == null || value === "") return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? "invalid" : parsed;
}

function validateGrantConfig(input: {
  plan: unknown;
  durationDays: unknown;
  maxUses: unknown;
  promoCredits: unknown;
  promoCreditTtlDays: unknown;
  stackingPolicy: unknown;
  expiresAt: unknown;
}, usedCount = 0) {
  const plan = String(input.plan ?? "PRO");
  const durationDays = finiteInteger(input.durationDays, 30);
  const maxUses = finiteInteger(input.maxUses, 1);
  const promoCredits = finiteInteger(input.promoCredits, 0);
  const promoCreditTtlDays = finiteInteger(input.promoCreditTtlDays, 30);
  const stackingPolicy = String(input.stackingPolicy ?? "SAFE_APPEND");
  const expiresAt = parseExpiry(input.expiresAt);
  if (!(["PRO", "BUSINESS"] as string[]).includes(plan)) return { error: "GRANT รองรับเฉพาะ PRO หรือ BUSINESS" } as const;
  if (durationDays < 0) return { error: "durationDays ต้องไม่น้อยกว่า 0" } as const;
  if (maxUses < 0 || maxUses < usedCount) return { error: `maxUses ต้องไม่น้อยกว่าจำนวนที่ใช้แล้ว (${usedCount})` } as const;
  if (promoCredits < 0) return { error: "promoCredits ต้องไม่น้อยกว่า 0" } as const;
  if (promoCreditTtlDays < 1 || promoCreditTtlDays > 365) return { error: "อายุ promo credits ต้องอยู่ระหว่าง 1-365 วัน" } as const;
  if (!["SAFE_APPEND", "REJECT_EXISTING"].includes(stackingPolicy)) return { error: "stackingPolicy ไม่ถูกต้อง" } as const;
  if (expiresAt === "invalid") return { error: "วันหมดอายุไม่ถูกต้อง" } as const;
  return {
    value: {
      plan: plan as "PRO" | "BUSINESS",
      durationDays,
      maxUses,
      promoCredits,
      promoCreditTtlDays,
      stackingPolicy,
      expiresAt,
    },
  } as const;
}

async function auditCoupon(
  tx: Prisma.TransactionClient,
  input: {
    couponId: string;
    actorUserId: string;
    action: "CREATE" | "UPDATE" | "DISABLE" | "ENABLE";
    before?: Coupon | null;
    after?: Coupon | null;
  },
) {
  await tx.couponAuditLog.create({
    data: {
      couponId: input.couponId,
      actorUserId: input.actorUserId,
      action: input.action,
      beforeJson: input.before ? couponSnapshot(input.before) : null,
      afterJson: input.after ? couponSnapshot(input.after) : null,
    },
  });
}

export async function GET() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isAdmin(authUser)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const coupons = await prisma.coupon.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { redemptions: true } },
        auditLogs: { orderBy: { createdAt: "desc" }, take: 5 },
      },
    });
    return NextResponse.json(coupons);
  } catch (error) {
    return apiError({ route: "GET /api/admin/coupons", error });
  }
}

export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isAdmin(authUser)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json();
    if (!body.code?.trim()) return NextResponse.json({ error: "กรุณากรอกรหัสคูปอง" }, { status: 400 });
    const type = String(body.type ?? "GRANT");
    if (!["GRANT", "DISCOUNT"].includes(type)) return NextResponse.json({ error: "type ไม่ถูกต้อง" }, { status: 400 });
    const code = body.code.trim().toUpperCase();
    let stripeCouponId: string | null = null;
    let stripePromotionCodeId: string | null = null;
    let data: Prisma.CouponCreateInput;

    if (type === "DISCOUNT") {
      const percentOff = finiteInteger(body.percentOff, Number.NaN);
      const maxUses = finiteInteger(body.maxUses, 1);
      const expiresAt = parseExpiry(body.expiresAt);
      if (percentOff < 1 || percentOff > 100) return NextResponse.json({ error: "percentOff ต้องเป็น 1-100" }, { status: 400 });
      if (!["once", "forever"].includes(body.discountDuration)) return NextResponse.json({ error: "discountDuration ต้องเป็น once หรือ forever" }, { status: 400 });
      if (expiresAt === "invalid") return NextResponse.json({ error: "วันหมดอายุไม่ถูกต้อง" }, { status: 400 });
      const { ensureStripeConfig } = await import("@/lib/load-stripe-config");
      const { stripe } = await import("@/lib/stripe");
      await ensureStripeConfig();
      const stripeCoupon = await stripe.coupons.create({
        percent_off: percentOff,
        duration: body.discountDuration,
        name: code,
      });
      const promotion = await stripe.promotionCodes.create({
        promotion: { type: "coupon", coupon: stripeCoupon.id },
        code,
        ...(maxUses > 0 ? { max_redemptions: maxUses } : {}),
        ...(expiresAt ? { expires_at: Math.floor(expiresAt.getTime() / 1_000) } : {}),
      });
      stripeCouponId = stripeCoupon.id;
      stripePromotionCodeId = promotion.id;
      data = {
        code,
        type,
        plan: "PRO",
        durationDays: 0,
        maxUses,
        expiresAt,
        percentOff,
        discountDuration: body.discountDuration,
        stripeCouponId,
        stripePromotionCodeId,
      };
    } else {
      const config = validateGrantConfig(body);
      if ("error" in config) return NextResponse.json({ error: config.error }, { status: 400 });
      data = { code, type, isActive: body.isActive !== false, ...config.value };
    }

    const coupon = await prisma.$transaction(async (tx) => {
      const created = await tx.coupon.create({ data });
      await auditCoupon(tx, {
        couponId: created.id,
        actorUserId: authUser.id,
        action: "CREATE",
        after: created,
      });
      return created;
    });
    return NextResponse.json(coupon);
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "รหัสคูปองนี้มีอยู่แล้ว" }, { status: 400 });
    }
    return apiError({ route: "POST /api/admin/coupons", error });
  }
}

export async function PATCH(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isAdmin(authUser)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const body = await req.json();
    if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const current = await prisma.coupon.findUnique({ where: { id: body.id } });
    if (!current) return NextResponse.json({ error: "ไม่พบคูปอง" }, { status: 404 });
    if (current.type !== "GRANT") {
      if (body.isActive === undefined) {
        return NextResponse.json({ error: "ส่วนลด Stripe แก้ได้เฉพาะเปิดหรือปิดจากหน้านี้" }, { status: 400 });
      }
      const after = await prisma.$transaction(async (tx) => {
        const updated = await tx.coupon.update({
          where: { id: current.id },
          data: { isActive: Boolean(body.isActive) },
        });
        await auditCoupon(tx, {
          couponId: current.id,
          actorUserId: authUser.id,
          action: updated.isActive ? "ENABLE" : "DISABLE",
          before: current,
          after: updated,
        });
        return updated;
      });
      return NextResponse.json(after);
    }
    if (current.usedCount > 0 && ["code", "plan", "durationDays", "type"].some((field) =>
      body[field] !== undefined && String(body[field]) !== String(current[field as keyof Coupon] ?? ""),
    )) {
      return NextResponse.json({ error: "คูปองที่ถูกใช้แล้วเปลี่ยนรหัส แผน หรือจำนวนวันไม่ได้ — ปิดแล้วสร้างรหัสใหม่" }, { status: 400 });
    }
    const config = validateGrantConfig({
      plan: body.plan ?? current.plan,
      durationDays: body.durationDays ?? current.durationDays,
      maxUses: body.maxUses ?? current.maxUses,
      promoCredits: body.promoCredits ?? current.promoCredits,
      promoCreditTtlDays: body.promoCreditTtlDays ?? current.promoCreditTtlDays,
      stackingPolicy: body.stackingPolicy ?? current.stackingPolicy,
      expiresAt: body.expiresAt === undefined ? current.expiresAt : body.expiresAt,
    }, current.usedCount);
    if ("error" in config) return NextResponse.json({ error: config.error }, { status: 400 });
    const nextActive = body.isActive === undefined ? current.isActive : Boolean(body.isActive);
    const nextCode = body.code === undefined ? current.code : String(body.code).trim().toUpperCase();
    if (!nextCode) return NextResponse.json({ error: "กรุณากรอกรหัสคูปอง" }, { status: 400 });

    const updated = await prisma.$transaction(async (tx) => {
      const after = await tx.coupon.update({
        where: { id: current.id },
        data: { code: nextCode, isActive: nextActive, ...config.value },
      });
      const action = current.isActive !== after.isActive
        ? after.isActive ? "ENABLE" as const : "DISABLE" as const
        : "UPDATE" as const;
      await auditCoupon(tx, {
        couponId: current.id,
        actorUserId: authUser.id,
        action,
        before: current,
        after,
      });
      return after;
    });
    return NextResponse.json(updated);
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "รหัสคูปองนี้มีอยู่แล้ว" }, { status: 400 });
    }
    return apiError({ route: "PATCH /api/admin/coupons", error });
  }
}

// Compatibility with the old trash action: coupon evidence is never deleted.
// DELETE now means emergency disable, and prior successful benefits remain intact.
export async function DELETE(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isAdmin(authUser)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const current = await prisma.coupon.findUnique({ where: { id } });
    if (!current) return NextResponse.json({ error: "ไม่พบคูปอง" }, { status: 404 });
    if (!current.isActive) return NextResponse.json({ ok: true, coupon: current });
    const coupon = await prisma.$transaction(async (tx) => {
      const after = await tx.coupon.update({ where: { id }, data: { isActive: false } });
      await auditCoupon(tx, {
        couponId: id,
        actorUserId: authUser.id,
        action: "DISABLE",
        before: current,
        after,
      });
      return after;
    });
    return NextResponse.json({ ok: true, coupon });
  } catch (error) {
    return apiError({ route: "DELETE /api/admin/coupons", error });
  }
}
