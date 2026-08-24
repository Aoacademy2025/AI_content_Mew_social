import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { ensureStripeConfig } from "@/lib/load-stripe-config";
import { creditPack } from "@/lib/credits";

export async function POST(req: Request) {
  if (process.env.CREDITS_LIVE !== "1") {
    return NextResponse.json({ code: "CREDITS_NOT_LIVE" }, { status: 403 });
  }
  try {
    await ensureStripeConfig();
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const userId = authUser.id;

    const body = await req.json().catch(() => ({} as any));
    const pack = body?.pack;
    if (!pack) return NextResponse.json({ error: "Missing pack" }, { status: 400 });

    const p = creditPack(pack);
    if (!p) return NextResponse.json({ error: "Invalid credit pack" }, { status: 400 });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true, plan: true, stripeCustomerId: true },
    });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    // ── Ensure a Stripe Customer ───────────────────────────────────────────
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: { userId },
      });
      customerId = customer.id;
      await prisma.user.update({
        where: { id: userId },
        data: { stripeCustomerId: customerId },
      });
    }

    const origin =
      req.headers.get("origin") ??
      process.env.NEXTAUTH_URL ??
      "http://localhost:3000";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: customerId,
      line_items: [
        {
          price_data: {
            currency: "thb",
            unit_amount: p.baht * 100,
            product_data: {
              name: `HERO Credits — ${p.credits} credits`,
              description: user.plan === "FREE"
                ? "ใช้เติมนาทีเรนเดอร์ส่วนเกิน (2 credits/นาที); ไม่ปลดล็อก AI Image, Avatar หรือเสียงพรีเมียม"
                : "เครดิตใช้จ่ายตามงานภายในสิทธิ์ฟีเจอร์ของแพ็กเกจ; เครดิตที่ซื้อไม่หมดอายุ",
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        userId,
        type: "credits",
        credits: String(p.credits),
      },
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      success_url: `${origin}/settings?tab=billing&credits=success`,
      cancel_url: `${origin}/settings?tab=billing&credits=cancelled`,
    });

    return NextResponse.json({ url: session.url });
  } catch (error) {
    return apiError({ route: "POST /api/payments/credits", error });
  }
}
