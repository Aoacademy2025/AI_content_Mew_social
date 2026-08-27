import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { apiError } from "@/lib/api-error";
import { parseRevenueRange } from "@/lib/revenue-growth";
import { getRevenueGrowthDashboard } from "@/lib/revenue-growth.server";

export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const url = new URL(request.url);
    const days = parseRevenueRange(url.searchParams.get("days"));
    return NextResponse.json(await getRevenueGrowthDashboard(days));
  } catch (error) {
    return apiError({ route: "GET /api/admin/revenue", error });
  }
}
