import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { getBalance, getReservedCredits, ensureMonthlyGrant } from "@/lib/credits";
import { apiError } from "@/lib/api-error";

// GET /api/credits/balance — returns the authenticated user's credit balance.
// When CREDITS_LIVE is not "1", returns a zero shape with live:false so the UI can hide.
export async function GET() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    if (process.env.CREDITS_LIVE !== "1") {
      return NextResponse.json({ granted: 0, promotional: 0, purchased: 0, total: 0, reserved: 0, live: false, plan: authUser.plan });
    }

    await ensureMonthlyGrant(authUser.id);
    const [balance, reserved] = await Promise.all([
      getBalance(authUser.id),
      getReservedCredits(authUser.id),
    ]);

    return NextResponse.json({ ...balance, reserved, live: true, plan: authUser.plan });
  } catch (error) {
    return apiError({ route: "GET /api/credits/balance", error });
  }
}
