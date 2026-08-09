import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { apiError } from "@/lib/api-error";
import { getBrandVisualRolloutHealth } from "@/lib/brand-visual-rollout-health.server";

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const rawDays = Number(new URL(req.url).searchParams.get("days") ?? 7);
    const days = Number.isFinite(rawDays) ? rawDays : 7;
    return NextResponse.json(await getBrandVisualRolloutHealth({ days }));
  } catch (error) {
    return apiError({ route: "GET /api/admin/brand-visual-health", error });
  }
}
