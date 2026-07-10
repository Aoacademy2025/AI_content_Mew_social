import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import {
  applyMediaCleanupPlan,
  applyTmpCleanupPlan,
  getMediaCleanupPlan,
  mediaCleanupSummary,
} from "@/lib/media-cleanup";
import { writeMediaHealthMetrics } from "@/lib/media-quarantine";

export const maxDuration = 120;
export const runtime = "nodejs";

async function requireAdmin() {
  const authUser = await getCurrentUser();
  if (!authUser) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (authUser.role !== "ADMIN") return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { authUser };
}

// GET - reference-aware dry-run report.
export async function GET(req: Request) {
  const admin = await requireAdmin();
  if (admin.error) return admin.error;

  const url = new URL(req.url);
  const olderThanDays = Number(url.searchParams.get("olderThanDays") ?? 3);
  const includeStocks = url.searchParams.get("includeStocks") === "1";
  const includeTmp = url.searchParams.get("includeTmp") === "1";
  const plan = await getMediaCleanupPlan({ olderThanDays, includeStocks, includeTmp });
  if (plan.graphErrors.length > 0) {
    return NextResponse.json({
      error: "media graph incomplete",
      graphErrors: plan.graphErrors.length,
      dryRun: true,
    }, { status: 409 });
  }
  await writeMediaHealthMetrics(plan);

  return NextResponse.json({
    ...mediaCleanupSummary(plan),
    candidates: plan.candidates,
    dryRun: true,
  });
}

// DELETE - quarantine only, gated by the exact reviewed dry-run manifest hash.
export async function DELETE(req: Request) {
  const admin = await requireAdmin();
  if (admin.error) return admin.error;

  const body = await req.json().catch(() => null) as {
    apply?: unknown;
    manifestSha256?: unknown;
    olderThanDays?: unknown;
    includeStocks?: unknown;
    includeTmp?: unknown;
  } | null;
  if (
    !body ||
    body.apply !== true ||
    typeof body.manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(body.manifestSha256)
  ) {
    return NextResponse.json(
      { error: "DELETE requires { apply: true, manifestSha256 }" },
      { status: 400 },
    );
  }

  const olderThanDays = Number(body.olderThanDays ?? 3);
  const includeStocks = body.includeStocks === true;
  const includeTmp = body.includeTmp === true;

  const plan = await getMediaCleanupPlan({ olderThanDays, includeStocks, includeTmp });
  const summary = mediaCleanupSummary(plan);
  if (plan.graphErrors.length > 0) {
    return NextResponse.json({
      error: "media graph incomplete",
      graphErrors: plan.graphErrors.length,
      dryRun: false,
    }, { status: 409 });
  }

  let result;
  try {
    result = await applyMediaCleanupPlan(plan, body.manifestSha256);
  } catch (error) {
    const message = error instanceof Error ? error.message : "media cleanup failed";
    if (message === "reviewed manifest hash mismatch") {
      return NextResponse.json({ error: "reviewed manifest hash mismatch" }, { status: 409 });
    }
    return NextResponse.json({ error: "media cleanup operation failed" }, { status: 500 });
  }
  const tmpResult = includeTmp ? applyTmpCleanupPlan(plan) : null;
  const metricsPlan = await getMediaCleanupPlan({ olderThanDays, includeStocks, includeTmp });
  if (metricsPlan.graphErrors.length > 0) {
    return NextResponse.json({
      error: "media graph incomplete after apply",
      graphErrors: metricsPlan.graphErrors.length,
      dryRun: false,
    }, { status: 500 });
  }
  await writeMediaHealthMetrics(metricsPlan);
  console.log(
    `[admin/cleanup] renders=${plan.selected.renders.count} ` +
    `stocks=${plan.selected.stocks.count} tmp=${plan.selected.tmp.count} ` +
    `quarantined=${result.quarantined.count} skipped=${result.skipped.count}`
  );

  return NextResponse.json({
    ...summary,
    dryRun: false,
    result,
    tmpResult,
  });
}
