import { NextResponse } from "next/server";
import { releaseStaleReservations } from "@/lib/founding";
import { timingSafeStrEqual } from "@/lib/timing-safe-equal";

export const runtime = "nodejs";

// GET /api/cron/founding-sweep  (every ~15 min, Bearer CRON_SECRET)
// Backstop for a missed `checkout.session.expired`: returns abandoned founding seats
// (RESERVED longer than HOLD_MINUTES) to the pool. The expired webhook is the primary
// release path; this guarantees the 100-seat counter self-heals even if a webhook is dropped.
// Fails CLOSED if CRON_SECRET is unset.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || !timingSafeStrEqual(auth ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const released = await releaseStaleReservations();
  console.log(`[founding-sweep] ${new Date().toISOString()} released=${released}`);
  return NextResponse.json({ ok: true, released });
}
