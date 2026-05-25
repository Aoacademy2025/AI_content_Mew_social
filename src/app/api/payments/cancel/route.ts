import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

/**
 * Cancel a pending payment — expires the Stripe session and marks Payment as FAILED.
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

    // Try to expire the Stripe session (ignore errors — it may already be expired)
    try {
      await stripe.checkout.sessions.expire(payment.stripeSessionId);
    } catch (e) {
      console.warn("[cancel] Stripe expire failed (may already be expired):", e);
    }

    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: "FAILED" },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError({ route: "POST /api/payments/cancel", error });
  }
}
