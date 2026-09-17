import { NextResponse } from "next/server";
import { revertExpiredEntitlements } from "@/lib/entitlements";
import { writeCronHeartbeat } from "@/lib/cron-heartbeat";
import { runAuthorizedCronJob } from "@/lib/cron-route";

export const runtime = "nodejs";

// GET /api/cron/trial-expiry  (daily, Bearer CRON_SECRET)
// Reverts expired trials/timed paid plans to FREE and notifies users with the upgrade prompt.
// Fails CLOSED if CRON_SECRET is unset. Prisma lock timeouts return 503 instead of
// bubbling as an unhandled route error (HERO-10 / HERO-STUDIO-WEB-11).
export async function GET(req: Request) {
  const result = await runAuthorizedCronJob({
    authorization: req.headers.get("authorization"),
    secret: process.env.CRON_SECRET,
    name: "trial-expiry",
    run: async () => {
      const outcome = await revertExpiredEntitlements();
      console.log(`[trial-expiry] ${new Date().toISOString()} checked=${outcome.checked} reverted=${outcome.reverted}`);
      return outcome;
    },
    onSuccess: writeCronHeartbeat,
  });
  return NextResponse.json(result.body, { status: result.status });
}
