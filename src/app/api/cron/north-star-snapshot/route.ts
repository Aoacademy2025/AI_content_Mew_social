import { NextResponse } from "next/server";
import { writeCronHeartbeat } from "@/lib/cron-heartbeat";
import { writeSubscriptionNorthStarSnapshot } from "@/lib/subscription-north-star.server";
import { timingSafeStrEqual } from "@/lib/timing-safe-equal";

export const runtime = "nodejs";

// Daily counts-only snapshot. Fails closed when CRON_SECRET is not configured.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || !timingSafeStrEqual(auth ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await writeSubscriptionNorthStarSnapshot();
  writeCronHeartbeat("north-star-snapshot");
  console.log(`[north-star-snapshot] ${result.snapshotDate} mapc=${result.activeCreators} recurring=${result.activeRecurringPayers}`);
  return NextResponse.json({ ok: true, ...result });
}
