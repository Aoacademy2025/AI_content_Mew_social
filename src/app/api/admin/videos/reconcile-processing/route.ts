import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { apiError } from "@/lib/api-error";
import { applyProcessingReconcile, getProcessingReconcilePlan } from "@/lib/video-reconcile";

export const runtime = "nodejs";

async function requireAdmin() {
  const authUser = await getCurrentUser();
  if (!authUser) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (authUser.role !== "ADMIN") return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { authUser };
}

export async function GET(req: Request) {
  try {
    const auth = await requireAdmin();
    if (auth.error) return auth.error;

    const url = new URL(req.url);
    const plan = await getProcessingReconcilePlan({
      staleAfterMinutes: url.searchParams.get("staleAfterMinutes"),
      failAfterHours: url.searchParams.get("failAfterHours"),
      limit: url.searchParams.get("limit"),
    });

    return NextResponse.json({ dryRun: true, applied: null, ...plan });
  } catch (error) {
    return apiError({ route: "GET /api/admin/videos/reconcile-processing", error });
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAdmin();
    if (auth.error) return auth.error;

    const body = await req.json().catch(() => ({}));
    const failMissingOutput = body.failMissingOutput === true;
    const plan = await getProcessingReconcilePlan({
      staleAfterMinutes: body.staleAfterMinutes,
      failAfterHours: body.failAfterHours,
      limit: body.limit,
    });
    const dryRun = body.dryRun !== false;
    const applied = dryRun ? null : await applyProcessingReconcile(plan, { failMissingOutput });

    return NextResponse.json({ dryRun, applied, options: { ...plan.options, failMissingOutput }, summary: plan.summary, items: plan.items });
  } catch (error) {
    return apiError({ route: "POST /api/admin/videos/reconcile-processing", error });
  }
}
