import { NextResponse } from "next/server";
import { foundingStatus } from "@/lib/founding";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";

// Returns { active, remaining, total, percentOff } for the pricing page founding banner/price.
export async function GET() {
  try {
    return NextResponse.json(await foundingStatus());
  } catch (error) {
    return apiError({ route: "GET /api/founding/status", error });
  }
}
