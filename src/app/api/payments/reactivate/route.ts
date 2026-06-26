import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { ensureStripeConfig } from "@/lib/load-stripe-config";

// Undo a portal-scheduled cancellation: set cancel_at_period_end back to false on Stripe.
// The customer.subscription.updated webhook reconciles the DB; we also clear optimistically.
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

    const sub = await stripe.subscriptions.update(dbUser.stripeSubscriptionId, { cancel_at_period_end: false });

    await prisma.user.update({
      where: { id: authUser.id },
      // Use the subscription's REAL status, not a hardcoded "active" — un-cancelling a past_due
      // sub must not optimistically re-grant full access (the updated webhook reconciles too).
      data: { cancelAtPeriodEnd: false, cancelAt: null, subStatus: (sub as any).status ?? "active" },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError({ route: "POST /api/payments/reactivate", error });
  }
}
