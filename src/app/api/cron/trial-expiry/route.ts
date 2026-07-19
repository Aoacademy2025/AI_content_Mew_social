import { NextResponse } from "next/server";
import { revertExpiredEntitlements } from "@/lib/entitlements";
import { timingSafeStrEqual } from "@/lib/timing-safe-equal";
import { writeCronHeartbeat } from "@/lib/cron-heartbeat";

export const runtime = "nodejs";

// GET /api/cron/trial-expiry  (daily, Bearer CRON_SECRET)
// Reverts expired trials/timed paid plans to FREE and notifies users with the upgrade prompt.
// Fails CLOSED if CRON_SECRET is unset.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || !timingSafeStrEqual(auth ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await revertExpiredEntitlements();
  console.log(`[trial-expiry] ${new Date().toISOString()} checked=${result.checked} reverted=${result.reverted}`);
  writeCronHeartbeat("trial-expiry");
  return NextResponse.json({ ok: true, ...result });
}
