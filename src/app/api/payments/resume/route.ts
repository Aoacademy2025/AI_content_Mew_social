import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

/**
 * Resume a pending payment by retrieving its Stripe checkout URL.
 * If the Stripe session is no longer open, marks the Payment as FAILED.
 */
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { paymentId } = await req.json();
    if (!paymentId) return NextResponse.json({ error: "paymentId required" }, { status: 400 });

    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.userId !== session.user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (payment.status !== "PENDING") {
      return NextResponse.json({ error: "Payment ไม่ได้อยู่ในสถานะรอชำระ" }, { status: 400 });
    }

    try {
      const stripeSession = await stripe.checkout.sessions.retrieve(payment.stripeSessionId);
      if (stripeSession.status === "open" && stripeSession.url) {
        return NextResponse.json({ url: stripeSession.url });
      }
      // Session expired on Stripe side
      await prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
      return NextResponse.json({ error: "Session หมดอายุแล้ว — กรุณาเลือกแพ็กเกจใหม่" }, { status: 410 });
    } catch {
      await prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
      return NextResponse.json({ error: "ไม่พบ session — กรุณาเลือกแพ็กเกจใหม่" }, { status: 410 });
    }
  } catch (error) {
    return apiError({ route: "POST /api/payments/resume", error });
  }
}
