import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { ensureStripeConfig } from "@/lib/load-stripe-config";
import { readStripeSchedule, stripeShowsSchedule } from "@/lib/subscription-cancellation";

/**
 * Stop a card subscription from renewing, at the end of the period already paid for.
 *
 * HERO-24. Not to be confused with `/api/payments/cancel`, which voids one unpaid
 * `Payment` row and never touches a subscription.
 *
 * Stripe on this account does not return `cancel_at_period_end`, so sending only that
 * boolean can leave nothing scheduled while looking like it worked. We send it, read the
 * subscription Stripe hands back, and fall back to writing `cancel_at` at the period end
 * Stripe itself reports. The customer is told the cancellation took only when Stripe's own
 * object says so, and the database stores exactly what came back — never an assumption.
 */
function periodEndSeconds(sub: unknown): number | null {
  const s = sub as { current_period_end?: number; items?: { data?: { current_period_end?: number }[] } };
  const fromItem = s?.items?.data?.[0]?.current_period_end;
  const end = typeof s?.current_period_end === "number" ? s.current_period_end : fromItem;
  return typeof end === "number" && Number.isFinite(end) ? end : null;
}

export async function POST() {
  try {
    await ensureStripeConfig();
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const dbUser = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { stripeSubscriptionId: true },
    });
    if (!dbUser?.stripeSubscriptionId) {
      return NextResponse.json({ error: "ไม่พบการสมัครแบบต่ออัตโนมัติ" }, { status: 400 });
    }

    const current = await stripe.subscriptions.retrieve(dbUser.stripeSubscriptionId);

    // Already scheduled: send nothing. A second press must not read as a failure.
    let sub: unknown = current;
    if (!stripeShowsSchedule(current as never)) {
      sub = await stripe.subscriptions.update(dbUser.stripeSubscriptionId, { cancel_at_period_end: true } as never);
      if (!stripeShowsSchedule(sub as never)) {
        const end = periodEndSeconds(sub) ?? periodEndSeconds(current);
        if (end) {
          sub = await stripe.subscriptions.update(dbUser.stripeSubscriptionId, { cancel_at: end } as never);
        }
      }
    }

    const schedule = readStripeSchedule(sub as never);
    await prisma.user.update({
      where: { id: authUser.id },
      data: {
        cancelAtPeriodEnd: schedule.cancelAtPeriodEnd,
        cancelAt: schedule.cancelAt,
        subStatus: (sub as { status?: string }).status ?? undefined,
      },
    });

    if (!stripeShowsSchedule(sub as never)) {
      return NextResponse.json(
        { error: "ยกเลิกไม่สำเร็จ แพ็กยังต่ออายุตามกำหนดเดิม กรุณาลองใหม่หรือติดต่อทีมงาน" },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true, cancelAt: schedule.cancelAt?.toISOString() ?? null });
  } catch (error) {
    return apiError({ route: "POST /api/payments/cancel-subscription", error });
  }
}
