import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { getEntitlementAuditReport } from "@/lib/entitlements";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";

export async function GET() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (authUser.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const report = await getEntitlementAuditReport();
    return NextResponse.json(report);
  } catch (error) {
    return apiError({ route: "admin/entitlements", error });
  }
}
