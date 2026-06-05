import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { ensureStripeConfig } from "@/lib/load-stripe-config";

// Opens the Stripe Billing Portal so a subscribed user can manage/cancel/update their card.
// Requires the Billing Portal to be enabled in Stripe Dashboard → Settings → Billing → Customer portal.
export async function POST(req: Request) {
  try {
    await ensureStripeConfig();
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const dbUser = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { stripeCustomerId: true },
    });
    if (!dbUser?.stripeCustomerId) {
      return NextResponse.json({ error: "No subscription to manage" }, { status: 400 });
    }

    const origin = req.headers.get("origin") ?? process.env.NEXTAUTH_URL ?? "http://localhost:3000";
    const session = await stripe.billingPortal.sessions.create({
      customer: dbUser.stripeCustomerId,
      return_url: `${origin}/settings?tab=billing`,
    });

    return NextResponse.json({ url: session.url });
  } catch (error) {
    return apiError({ route: "POST /api/payments/portal", error });
  }
}
