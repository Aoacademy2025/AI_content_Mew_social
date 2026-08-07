import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { apiError } from "@/lib/api-error";
import { findPlanPaymentConfirmation } from "@/lib/payment-confirmation";

export async function GET(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sessionId = new URL(req.url).searchParams.get("session_id")?.trim() ?? "";
    if (!sessionId.startsWith("cs_") || sessionId.length > 255) {
      return NextResponse.json({ error: "Invalid checkout session" }, { status: 400 });
    }

    const result = await findPlanPaymentConfirmation(authUser.id, sessionId);
    if (!result) {
      // Do not reveal whether a session belongs to another account. A missing
      // reservation can also be healed shortly by the verified Stripe webhook.
      return NextResponse.json({ confirmed: false, status: "PROCESSING" });
    }

    return NextResponse.json(result);
  } catch (error) {
    return apiError({ route: "GET /api/payments/confirmation", error });
  }
}
