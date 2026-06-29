import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { extendVideoExpiryForPlan } from "@/lib/plan-helpers";
import { usageWindowForPlan } from "@/lib/usage-limits";
import { markUserPaid, type PaidPlan } from "@/lib/paid-term";
import { grantOnPaidActivation } from "@/lib/entitlements";

const VALID_PLANS = new Set(["FREE", "PRO", "BUSINESS"]);
const VALID_ROLES = new Set(["ADMIN", "USER"]);
const VALID_PAID_PLANS = new Set(["PRO", "BUSINESS"]);
const USER_SELECT = { id: true, name: true, email: true, role: true, plan: true, planExpiresAt: true, suspended: true } as const;

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

    const { plan, role, suspended, markPaid } = await req.json();
    const { id } = await params;

    // "Mark as paid" — convert a trial / bank-transfer customer to a real paid TIMED plan.
    // Distinct from the plan dropdown (which nulls the expiry → permanent, and is a no-op when
    // re-selecting a trial user's current PRO). This sets a term + clears the trial flag so the
    // entitlement classifier won't auto-revert the paying customer to FREE. See markUserPaid.
    if (markPaid !== undefined) {
      const { plan: paidPlan, periodDays, from } = markPaid ?? {};
      if (!VALID_PAID_PLANS.has(paidPlan)) {
        return NextResponse.json({ error: `Invalid markPaid.plan: ${paidPlan} (PRO|BUSINESS)` }, { status: 400 });
      }
      const days = Number(periodDays);
      if (!Number.isFinite(days) || days <= 0 || days > 3660) {
        return NextResponse.json({ error: `Invalid markPaid.periodDays: ${periodDays}` }, { status: 400 });
      }
      const fromDate = from ? new Date(from) : undefined;
      if (fromDate && isNaN(fromDate.getTime())) {
        return NextResponse.json({ error: `Invalid markPaid.from: ${from}` }, { status: 400 });
      }
      await markUserPaid(id, {
        plan: paidPlan as PaidPlan,
        periodDays: days,
        from: fromDate,
        billingPeriod: days >= 365 ? "annual" : "monthly",
      });
      // Force a fresh monthly credit grant on this manual paid activation, ignoring the
      // 30-day window (same as the Stripe webhook): a prior trial-expiry downgrade may have
      // stamped grantedResetAt=now with FREE allowance 0, which would otherwise block the
      // grant (H4). CREDITS_LIVE-gated inside the helper → no-op when off (byte-identical).
      await grantOnPaidActivation(id, paidPlan).catch((e) =>
        console.error("[admin/users/PATCH] grantOnPaidActivation (markPaid) failed:", e)
      );
      const updated = await prisma.user.findUnique({ where: { id }, select: USER_SELECT });
      return NextResponse.json(updated);
    }

    if (plan !== undefined && !VALID_PLANS.has(plan)) {
      return NextResponse.json({ error: `Invalid plan: ${plan}` }, { status: 400 });
    }
    if (role !== undefined && !VALID_ROLES.has(role)) {
      return NextResponse.json({ error: `Invalid role: ${role}` }, { status: 400 });
    }

    const data: Record<string, unknown> = {};
    if (plan !== undefined) {
      Object.assign(data, {
        plan,
        planExpiresAt: null,
        trialEndsAt: null,
        ...usageWindowForPlan(plan),
      });
    }
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

    // If plan changed, extend retention of existing videos to match new plan
    if (plan !== undefined) {
      await extendVideoExpiryForPlan(id, plan).catch(err => {
        console.error("[admin/users/PATCH] extendVideoExpiryForPlan failed:", err);
      });
      // A manual plan-change to PRO/BUSINESS grants the monthly credit allowance too (helper
      // no-ops for FREE and when CREDITS_LIVE is off → byte-identical). Forces past the
      // 30-day window so a trial-expired user promoted within the month still gets credits (H4).
      await grantOnPaidActivation(id, plan).catch(err => {
        console.error("[admin/users/PATCH] grantOnPaidActivation failed:", err);
      });
    }

    return NextResponse.json(user);
  } catch (error) {
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

    await prisma.user.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError({ route: "admin/users/[id]", error });
  }
}
