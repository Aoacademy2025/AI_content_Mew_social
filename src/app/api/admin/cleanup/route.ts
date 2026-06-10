import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import {
  applyMediaCleanupPlan,
  getMediaCleanupPlan,
  mediaCleanupSummary,
} from "@/lib/media-cleanup";

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

  return NextResponse.json({
    ...mediaCleanupSummary(plan),
    dryRun: true,
  });
}

// DELETE - deletes only unreferenced files selected by the same dry-run scanner.
export async function DELETE(req: Request) {
  const admin = await requireAdmin();
  if (admin.error) return admin.error;

  const {
    olderThanDays = 3,
    includeStocks = false,
    includeTmp = false,
    dryRun = false,
  }: { olderThanDays?: number; includeStocks?: boolean; includeTmp?: boolean; dryRun?: boolean } =
    await req.json().catch(() => ({}));

  const plan = await getMediaCleanupPlan({ olderThanDays, includeStocks, includeTmp });
  const summary = mediaCleanupSummary(plan);

  if (dryRun) {
    return NextResponse.json({
      ...summary,
      dryRun: true,
      deleted: 0,
      savedMb: 0,
      skipped: 0,
      message: `Dry-run: ลบได้ ${plan.selected.total.count} รายการ ประหยัดประมาณ ${plan.selected.total.sizeMb} MB`,
    });
  }

  const result = applyMediaCleanupPlan(plan);
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
