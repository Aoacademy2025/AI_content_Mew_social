import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { ensureStripeConfig } from "@/lib/load-stripe-config";

/**
 * Undo a portal-scheduled cancellation.
 *
 * HERO-20: Stripe schedules a cancellation as a `cancel_at` timestamp, not only
 * as the legacy `cancel_at_period_end` boolean, so clearing the boolean alone
 * could leave the real schedule in place. We clear both shapes and then read the
 * subscription Stripe hands back: the customer is told the cancellation is undone
 * only when Stripe's own object says it is. Whatever Stripe returns is what we
 * store, so a partial clear leaves the banner truthfully up instead of hiding a
 * cancellation that is still coming.
 */
async function clearScheduledCancellation(subscriptionId: string) {
  try {
    // `cancel_at: null` is how stripe-node unsets a scheduled cancellation.
    return await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: false,
      cancel_at: null,
    } as never);
  } catch (error) {
    // An API version that does not accept the two together still has to be
    // undoable; fall back to the legacy parameter and let the verification
    // below decide whether that was enough.
    if ((error as { type?: string })?.type !== "StripeInvalidRequestError") throw error;
    return await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: false } as never);
  }
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

    const sub = await clearScheduledCancellation(dbUser.stripeSubscriptionId);

    const cancelAtPeriodEnd = (sub as { cancel_at_period_end?: boolean }).cancel_at_period_end === true;
    const cancelAtSeconds = (sub as { cancel_at?: number | null }).cancel_at ?? null;
    const cancelAt = cancelAtSeconds ? new Date(cancelAtSeconds * 1000) : null;

    await prisma.user.update({
      where: { id: authUser.id },
      // Mirror Stripe, never an assumption. Use the subscription's REAL status,
      // not a hardcoded "active" — un-cancelling a past_due sub must not
      // optimistically re-grant full access (the updated webhook reconciles too).
      data: {
        cancelAtPeriodEnd,
        cancelAt,
        subStatus: (sub as { status?: string }).status ?? "active",
      },
    });

    if (cancelAtPeriodEnd || cancelAt) {
      return NextResponse.json(
        { error: "ยกเลิกการยกเลิกไม่สำเร็จ แพ็กยังถูกตั้งให้สิ้นสุดตามกำหนดเดิม กรุณาติดต่อทีมงาน" },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError({ route: "POST /api/payments/reactivate", error });
  }
}
