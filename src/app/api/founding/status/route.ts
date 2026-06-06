import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { foundingStatus } from "@/lib/founding";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";

// Returns { active, remaining, total, percentOff } for the pricing page founding banner/price.
export async function GET() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json(await foundingStatus());
  } catch (error) {
    return apiError({ route: "GET /api/founding/status", error });
  }
}
