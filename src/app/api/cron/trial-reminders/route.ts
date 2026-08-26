import { NextResponse } from "next/server";
import { timingSafeStrEqual } from "@/lib/timing-safe-equal";
import { writeCronHeartbeat } from "@/lib/cron-heartbeat";
import { sendDueTrialReminders, trialRemindersEnabled } from "@/lib/trial-reminders.server";

export const runtime = "nodejs";

// GET /api/cron/trial-reminders  (daily 10:00 Asia/Bangkok, Bearer CRON_SECRET)
// Trial lifecycle nudges: 2 days left, expiry day, and 3 days after expiry (issue #299).
// Fails CLOSED if CRON_SECRET is unset, and is a no-op unless TRIAL_REMINDERS=1.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || !timingSafeStrEqual(auth ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!trialRemindersEnabled()) {
    // Heartbeat still written: the cron IS alive, it just has nothing to do while the
    // flag is off, and the ops watchdog must not read that as a dead job.
    writeCronHeartbeat("trial-reminders");
    return NextResponse.json({ ok: true, enabled: false, checked: 0, sent: 0 });
  }

  const now = new Date();
  const result = await sendDueTrialReminders(now);
  console.log(
    `[trial-reminders] ${now.toISOString()} checked=${result.checked} sent=${result.sent} `
    + `d5=${result.byKind.d5} expiry=${result.byKind.expiry} d3after=${result.byKind.d3after}`,
  );
  writeCronHeartbeat("trial-reminders");
  return NextResponse.json({ ok: true, enabled: true, ...result });
}
