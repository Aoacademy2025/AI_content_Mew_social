import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { apiError } from "@/lib/api-error";
import { coerceTrendDays, getAdminTrends } from "@/lib/admin-trends.server";

// GET /api/admin/trends?days=30|14 — the Daily Trend series behind the /admin overview cards.
// Counts only: per ADR 0062 money amounts render on /admin/revenue and nowhere else.
export async function GET(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (authUser.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const days = coerceTrendDays(new URL(req.url).searchParams.get("days"));
    return NextResponse.json(await getAdminTrends(days));
  } catch (error) {
    return apiError({ route: "admin/trends", error });
  }
}
