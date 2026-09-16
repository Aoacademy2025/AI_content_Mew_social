import { NextResponse } from "next/server";
import { writeCronHeartbeat } from "@/lib/cron-heartbeat";
import { runAuthorizedCronJob } from "@/lib/cron-route";
import { writeSubscriptionNorthStarSnapshot } from "@/lib/subscription-north-star.server";

export const runtime = "nodejs";

// Daily counts-only snapshot. Fails closed when CRON_SECRET is not configured.
// Prisma lock timeouts return 503 instead of an unhandled route error (HERO-10 / HERO-STUDIO-WEB-W).
export async function GET(req: Request) {
  const result = await runAuthorizedCronJob({
    authorization: req.headers.get("authorization"),
    secret: process.env.CRON_SECRET,
    name: "north-star-snapshot",
    run: async () => {
      const outcome = await writeSubscriptionNorthStarSnapshot();
      console.log(`[north-star-snapshot] ${outcome.snapshotDate} mapc=${outcome.activeCreators} paying=${outcome.activePayingCustomers} recurring=${outcome.activeRecurringPayers}`);
      return outcome;
    },
    onSuccess: writeCronHeartbeat,
  });
  return NextResponse.json(result.body, { status: result.status });
}
