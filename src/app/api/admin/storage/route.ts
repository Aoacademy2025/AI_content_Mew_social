import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { getStorageHealth } from "@/lib/storage-health";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";

export async function GET() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (authUser.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const health = await getStorageHealth();
    return NextResponse.json(health);
  } catch (error) {
    return apiError({ route: "GET /api/admin/storage", error });
  }
}
