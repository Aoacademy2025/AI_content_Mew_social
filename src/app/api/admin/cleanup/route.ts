import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import {
  applyMediaCleanupPlan,
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
  const summary = mediaCleanupSummary(plan);

  if (plan.graphErrors.length > 0) {
    return NextResponse.json({ ...summary, dryRun: true }, { status: 409 });
  }
  await writeMediaHealthMetrics(plan);

  return NextResponse.json({
    ...summary,
    dryRun: true,
  });
}

// DELETE - quarantines only the exact reviewed manifest; permanent purge is never available here.
export async function DELETE(req: Request) {
  const admin = await requireAdmin();
  if (admin.error) return admin.error;

  const body = await req.json().catch(() => null) as {
    apply?: boolean;
    manifestSha256?: string;
    olderThanDays?: number;
    includeStocks?: boolean;
    includeTmp?: boolean;
  } | null;
  const {
    apply,
    manifestSha256,
    olderThanDays = 3,
    includeStocks = false,
    includeTmp = false,
  } = body ?? {};

  if (apply !== true || typeof manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifestSha256)) {
    return NextResponse.json(
      { error: "apply_true_and_manifest_sha256_required" },
      { status: 400 },
    );
  }
  if (includeTmp) {
    return NextResponse.json(
      { error: "tmp_cleanup_requires_separate_cli_operation" },
      { status: 400 },
    );
  }

  const plan = await getMediaCleanupPlan({ olderThanDays, includeStocks, includeTmp });
  const summary = mediaCleanupSummary(plan);
  if (plan.graphErrors.length > 0) {
    return NextResponse.json({ ...summary, dryRun: false }, { status: 409 });
  }

  const result = await applyMediaCleanupPlan(plan, manifestSha256);
  const healthPlan = await getMediaCleanupPlan({ olderThanDays, includeStocks });
  if (healthPlan.graphErrors.length > 0) {
    throw new Error(`media graph incomplete: ${healthPlan.graphErrors.length} error(s)`);
  }
  await writeMediaHealthMetrics(healthPlan);
  console.log(
    `[admin/cleanup] renders=${plan.selected.renders.count} ` +
    `stocks=${plan.selected.stocks.count} tmp=${plan.selected.tmp.count} ` +
    `saved=${result.savedMb}MB skipped=${result.skipped}`
  );

  return NextResponse.json({
    ...summary,
    dryRun: false,
    ...result,
  });
}
