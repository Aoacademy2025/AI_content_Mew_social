import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { apiError } from "@/lib/api-error";
import { listDormantPayers } from "@/lib/dormant-payers.server";

export const runtime = "nodejs";

// GET /api/admin/dormant-payers — HERO-34. Paying customers with no Core Creation Outcome
// in the trailing 30 days, from the same evidence as the MAPC headline. Admin only;
// no money on this route (ADR 0062: this is a "ลูกค้า" question).
export async function GET() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (authUser.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const now = new Date();
    const dormant = await listDormantPayers(now);
    return NextResponse.json({ asOf: now.toISOString(), count: dormant.length, dormant });
  } catch (error) {
    return apiError({ route: "GET /api/admin/dormant-payers", error });
  }
}
