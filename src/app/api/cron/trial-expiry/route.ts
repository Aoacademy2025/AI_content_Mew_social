import { NextResponse } from "next/server";
import { revertExpiredEntitlements } from "@/lib/entitlements";

export const runtime = "nodejs";

// GET /api/cron/trial-expiry  (daily, Bearer CRON_SECRET)
// Reverts expired trials/timed paid plans to FREE and notifies users with the upgrade prompt.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await revertExpiredEntitlements();
  console.log(`[trial-expiry] ${new Date().toISOString()} checked=${result.checked} reverted=${result.reverted}`);
  return NextResponse.json({ ok: true, ...result });
}
