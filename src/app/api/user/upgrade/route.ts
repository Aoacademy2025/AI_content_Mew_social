import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { apiError } from "@/lib/api-error";

// POST /api/user/upgrade
// Legacy demo endpoint. Real upgrades must go through checkout, coupon redemption,
// or an admin grant so entitlement source + expiry are auditable.
export async function POST() {
  try {
    const authUser = await getCurrentUser();

    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json(
      { error: "Direct upgrade endpoint is disabled. Please use checkout, coupon redemption, or admin grant." },
      { status: 410 }
    );
  } catch (error) {
    return apiError({ route: "user/upgrade", error });
  }
}
