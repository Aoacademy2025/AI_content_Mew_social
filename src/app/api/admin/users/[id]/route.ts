import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { usageWindowForPlan } from "@/lib/usage-limits";
import { grantOnPaidActivation } from "@/lib/entitlements";
import { hardDeleteUserWithBrandAssets } from "@/lib/account-hard-delete.server";
import {
  AdministratorGrantInputError,
  createAdministratorGrant,
  revokeAdministratorGrants,
} from "@/lib/administrator-grant.server";
import { resolvePaidEquivalentEntitlement } from "@/lib/paid-equivalent-entitlement.server";
import { resetMonthlyGranted } from "@/lib/credits";

const VALID_ROLES = new Set(["ADMIN", "USER"]);
const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  plan: true,
  planExpiresAt: true,
  suspended: true,
  administratorGrants: { orderBy: { createdAt: "desc" as const }, take: 10 },
} as const;

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!authUser || authUser.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { plan, role, suspended, markPaid, administratorGrant, revokeAdministratorGrant } = await req.json();
    const { id } = await params;

    if (markPaid !== undefined) {
      return NextResponse.json({
        error: "payment_evidence_required",
        message: "กรุณาบันทึกยอดเงินจริงผ่านเมนู Manual Payment เพื่อให้สิทธิ์และรายได้ใช้หลักฐานเดียวกัน",
        manualPaymentUrl: "/admin#manual-payment",
      }, { status: 409 });
    }

    if (plan !== undefined) {
      return NextResponse.json({
        error: "entitlement_evidence_required",
        message: "ไม่สามารถเปลี่ยนแผนโดยตรงได้ กรุณาใช้ Administrator Grant หรือบันทึกการชำระเงินจริง",
      }, { status: 409 });
    }
    if (role !== undefined && !VALID_ROLES.has(role)) {
      return NextResponse.json({ error: `Invalid role: ${role}` }, { status: 400 });
    }

    if (administratorGrant !== undefined) {
      const permanent = administratorGrant?.permanent === true;
      const expiresAt = permanent ? null : new Date(String(administratorGrant?.expiresAt ?? ""));
      if (!permanent && (!expiresAt || Number.isNaN(expiresAt.getTime()))) {
        return NextResponse.json({ error: "กรุณาระบุวันหมดอายุที่ถูกต้อง" }, { status: 400 });
      }
      await createAdministratorGrant({
        userId: id,
        plan: administratorGrant?.plan,
        reason: String(administratorGrant?.reason ?? ""),
        expiresAt,
        permanent,
        grantedById: authUser.id,
      });
      await grantOnPaidActivation(id, administratorGrant?.plan).catch((error) => {
        console.error("[admin/users/PATCH] Administrator Grant credit reset failed:", error);
      });
      const updated = await prisma.user.findUnique({ where: { id }, select: USER_SELECT });
      return NextResponse.json(updated);
    }

    if (revokeAdministratorGrant !== undefined) {
      await revokeAdministratorGrants({
        userId: id,
        revokedById: authUser.id,
        reason: String(revokeAdministratorGrant?.reason ?? ""),
      });
      const paidEquivalent = await resolvePaidEquivalentEntitlement(id);
      const target = await prisma.user.findUnique({
        where: { id }, select: { trialEndsAt: true },
      });
      const activeTrial = Boolean(target?.trialEndsAt && target.trialEndsAt > new Date());
      const effectivePlan = paidEquivalent.canUsePaidFeatures
        ? paidEquivalent.effectivePlan
        : activeTrial ? "PRO" : "FREE";
      await prisma.user.update({
        where: { id },
        data: {
          plan: effectivePlan,
          ...usageWindowForPlan(effectivePlan),
          ...(!paidEquivalent.canUsePaidFeatures && !activeTrial ? { planExpiresAt: null } : {}),
        },
      });
      if (effectivePlan === "FREE") {
        if (process.env.CREDITS_LIVE === "1") await resetMonthlyGranted(id, "FREE").catch(() => {});
      }
      const updated = await prisma.user.findUnique({ where: { id }, select: USER_SELECT });
      return NextResponse.json(updated);
    }

    const data: Record<string, unknown> = {};
    if (role !== undefined) data.role = role;
    if (suspended !== undefined) data.suspended = suspended;

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    const user = await prisma.user.update({
      where: { id },
      data,
      select: USER_SELECT,
    });

    return NextResponse.json(user);
  } catch (error) {
    if (error instanceof AdministratorGrantInputError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return apiError({ route: "admin/users/[id]", error });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!authUser || authUser.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;

    // Prevent admin from deleting themselves
    if (authUser.id === id) {
      return NextResponse.json({ error: "Cannot delete yourself" }, { status: 400 });
    }

    await hardDeleteUserWithBrandAssets(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError({ route: "admin/users/[id]", error });
  }
}
