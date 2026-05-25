import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { extendVideoExpiryForPlan } from "@/lib/plan-helpers";

const VALID_PLANS = new Set(["FREE", "PRO", "BUSINESS"]);
const VALID_ROLES = new Set(["ADMIN", "USER"]);

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user || (session.user as any).role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { plan, role, suspended } = await req.json();
    const { id } = await params;

    if (plan !== undefined && !VALID_PLANS.has(plan)) {
      return NextResponse.json({ error: `Invalid plan: ${plan}` }, { status: 400 });
    }
    if (role !== undefined && !VALID_ROLES.has(role)) {
      return NextResponse.json({ error: `Invalid role: ${role}` }, { status: 400 });
    }

    const data: Record<string, unknown> = {};
    if (plan !== undefined) data.plan = plan;
    if (role !== undefined) data.role = role;
    if (suspended !== undefined) data.suspended = suspended;

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    const user = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, name: true, email: true, role: true, plan: true, planExpiresAt: true, suspended: true },
    });

    // If plan changed, extend retention of existing videos to match new plan
    if (plan !== undefined) {
      await extendVideoExpiryForPlan(id, plan).catch(err => {
        console.error("[admin/users/PATCH] extendVideoExpiryForPlan failed:", err);
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
    const session = await getServerSession(authOptions);
    if (!session?.user || (session.user as any).role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;

    // Prevent admin from deleting themselves
    if ((session.user as any).id === id) {
      return NextResponse.json({ error: "Cannot delete yourself" }, { status: 400 });
    }

    await prisma.user.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError({ route: "admin/users/[id]", error });
  }
}
