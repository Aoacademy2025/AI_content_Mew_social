import { NextResponse } from "next/server";
import { revertExpiredTrials } from "@/lib/trial";

export const runtime = "nodejs";

// GET /api/cron/trial-expiry  (daily, Bearer CRON_SECRET)
// Reverts expired unconverted trials to FREE and notifies them with the annual-upgrade prompt.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const reverted = await revertExpiredTrials();
  console.log(`[trial-expiry] ${new Date().toISOString()} reverted=${reverted}`);
  return NextResponse.json({ ok: true, reverted });
}
