import { NextResponse } from "next/server";

import { apiError } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/clerk-auth";
import {
  createStandardAnnualPortalSession,
  FoundingAnnualConversionError,
  type FoundingAnnualPlan,
} from "@/lib/founding-annual-conversion";
import { ensureStripeConfig } from "@/lib/load-stripe-config";
import { prisma } from "@/lib/prisma";
import { resolvePrice, stripe } from "@/lib/stripe";

/**
 * Monthly → annual for an ordinary subscriber (#302).
 *
 * `/api/payments/checkout` correctly refuses to mint a SECOND subscription for someone who
 * already has one, and the only in-place switch that existed claimed a Founding seat — so a
 * regular monthly customer had no route at all and wrote in to say so. This is that route:
 * the same Stripe-hosted confirmation flow, minus the seat and the promotion code.
 */
export async function POST(req: Request) {
  try {
    await ensureStripeConfig();
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const portalConfigurationId = process.env.STRIPE_PORTAL_FOUNDING_ANNUAL_CONFIG_ID;
    if (!portalConfigurationId) {
      return NextResponse.json({
        error: "การเปลี่ยนเป็นรายปียังไม่พร้อมใช้งาน กรุณาติดต่อทีมงาน",
        code: "NOT_CONFIGURED",
      }, { status: 503 });
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

    // The switch keeps the customer on their current tier. Changing tier and billing period
    // in one step would need a different proration story, so it stays out of this route.
    if (user.plan !== "PRO" && user.plan !== "BUSINESS") {
      return NextResponse.json({
        error: "แพ็กเกจปัจจุบันยังเปลี่ยนเป็นรายปีทางนี้ไม่ได้",
        code: "INVALID_PLAN_CHANGE",
      }, { status: 400 });
    }
    const requestedPlan = user.plan as FoundingAnnualPlan;

    const annualPriceId = resolvePrice(requestedPlan, "annual", "card").priceId;
    const currentMonthlyPriceId = resolvePrice(requestedPlan, "monthly", "card").priceId;
    if (!annualPriceId) {
      return NextResponse.json({
        error: "ราคารายปียังไม่ถูกตั้งค่า กรุณาติดต่อทีมงาน",
        code: "NOT_CONFIGURED",
      }, { status: 503 });
    }

    const configuredOrigin = process.env.NEXTAUTH_URL?.replace(/\/$/, "");
    const origin = configuredOrigin || new URL(req.url).origin;
    const result = await createStandardAnnualPortalSession({
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
                ...(params.discounts.length > 0 ? { discounts: params.discounts } : {}),
              },
            },
          });
          return { id: session.id, url: session.url };
        },
      },
    });

    return NextResponse.json({ url: result.url });
  } catch (error) {
    if (error instanceof FoundingAnnualConversionError) {
      // Every one of these is something the customer can act on, so each gets its own
      // sentence rather than a shared "something went wrong".
      const message = error.code === "NOT_ACTIVE_MONTHLY"
        ? "ทางนี้ใช้ได้กับสมาชิกรายเดือนแบบต่ออัตโนมัติที่ยังใช้งานอยู่เท่านั้น"
        : error.code === "MISSING_STRIPE_SUBSCRIPTION"
          ? "ไม่พบข้อมูลสมาชิกที่ผูกกับระบบชำระเงิน กรุณาติดต่อทีมงาน"
          : error.code === "UNSUPPORTED_SUBSCRIPTION"
            ? "สมาชิกของคุณมีรายการพิเศษที่เปลี่ยนอัตโนมัติไม่ได้ กรุณาติดต่อทีมงานเพื่อเปลี่ยนเป็นรายปีให้"
            : "เปลี่ยนเป็นรายปีไม่สำเร็จ กรุณาลองใหม่หรือติดต่อทีมงาน";
      return NextResponse.json({ error: message, code: error.code }, { status: 400 });
    }
    return apiError({ route: "POST /api/payments/switch-annual", error });
  }
}
