import { NextResponse } from "next/server";

import { apiError } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/clerk-auth";
import {
  createFoundingAnnualPortalSession,
  FoundingAnnualConversionError,
  type FoundingAnnualPlan,
} from "@/lib/founding-annual-conversion";
import {
  attachReservation,
  claimSeat,
  releaseUnattachedSeat,
} from "@/lib/founding";
import { ensureStripeConfig } from "@/lib/load-stripe-config";
import { prisma } from "@/lib/prisma";
import { resolvePrice, stripe } from "@/lib/stripe";

export async function POST(req: Request) {
  try {
    await ensureStripeConfig();
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => null) as { plan?: FoundingAnnualPlan } | null;
    const requestedPlan = body?.plan;
    if (requestedPlan !== "PRO" && requestedPlan !== "BUSINESS") {
      return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
    }

    const portalConfigurationId = process.env.STRIPE_PORTAL_FOUNDING_ANNUAL_CONFIG_ID;
    if (!portalConfigurationId) {
      return NextResponse.json({ error: "Founding annual conversion is not configured" }, { status: 503 });
    }
    const annualPriceId = resolvePrice(requestedPlan, "annual", "card").priceId;
    if (!annualPriceId) {
      return NextResponse.json({ error: "Stripe annual price not configured" }, { status: 503 });
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: {
        id: true,
        plan: true,
        billingPeriod: true,
        subStatus: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
      },
    });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    const currentMonthlyPriceId = user.plan === "PRO" || user.plan === "BUSINESS"
      ? resolvePrice(user.plan, "monthly", "card").priceId
      : "";

    const configuredOrigin = process.env.NEXTAUTH_URL?.replace(/\/$/, "");
    const origin = configuredOrigin || new URL(req.url).origin;
    const result = await createFoundingAnnualPortalSession({
      user,
      requestedPlan,
      currentMonthlyPriceId,
      annualPriceId,
      portalConfigurationId,
      origin,
      deps: {
        retrieveSubscription: async (subscriptionId) => {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          return {
            id: subscription.id,
            customerId: typeof subscription.customer === "string"
              ? subscription.customer
              : subscription.customer.id,
            status: subscription.status,
            items: subscription.items.data.map((item) => ({
              id: item.id,
              priceId: item.price.id,
              quantity: item.quantity ?? 1,
            })),
          };
        },
        claimSeat,
        createPortalSession: async (params) => {
          const session = await stripe.billingPortal.sessions.create({
            customer: params.customer,
            configuration: params.configuration,
            return_url: params.returnUrl,
            flow_data: {
              type: "subscription_update_confirm",
              after_completion: {
                type: "redirect",
                redirect: { return_url: params.afterCompletionUrl },
              },
              subscription_update_confirm: {
                subscription: params.subscription,
                items: params.items,
                discounts: params.discounts,
              },
            },
          });
          return { id: session.id, url: session.url };
        },
        attachReservation,
        releaseUnattachedSeat,
      },
    });

    return NextResponse.json({ url: result.url });
  } catch (error) {
    if (error instanceof FoundingAnnualConversionError) {
      const status = error.code === "SOLD_OUT" ? 409 : 400;
      const message = error.code === "SOLD_OUT"
        ? "สิทธิ์ Founding ครบแล้ว"
        : error.code === "NOT_ACTIVE_MONTHLY"
          ? "บัญชีนี้ไม่ได้อยู่ในสมาชิกบัตรรายเดือนที่เปลี่ยนเป็นรายปีได้"
          : "ไม่สามารถเปลี่ยนเป็น Founding รายปีอัตโนมัติได้ กรุณาติดต่อทีมงาน";
      return NextResponse.json({ error: message, code: error.code }, { status });
    }
    return apiError({ route: "POST /api/payments/founding-annual", error });
  }
}
