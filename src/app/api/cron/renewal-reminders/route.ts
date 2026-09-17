import { NextResponse } from "next/server";
import { timingSafeStrEqual } from "@/lib/timing-safe-equal";
import { writeCronHeartbeat } from "@/lib/cron-heartbeat";
import { sendDueDay21ConvertReminders } from "@/lib/day21-convert-reminder.server";
import { sendDueRenewalReminders } from "@/lib/renewal-reminders.server";
import { sendDuePastDueFollowUps } from "@/lib/past-due-dunning.server";

export const runtime = "nodejs";

// GET /api/cron/renewal-reminders  (daily, Bearer CRON_SECRET)
// Reminds the manual-renew cohort (one-time / PromptPay — no auto-renew subscription) before their plan lapses.
// Also carries the HERO-33 past_due +3-day follow-up so no new PM2 app is needed.
// Fails CLOSED if CRON_SECRET is unset.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || !timingSafeStrEqual(auth ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const renewal = await sendDueRenewalReminders(now);
  const day21 = await sendDueDay21ConvertReminders(now);
  const pastDue = await sendDuePastDueFollowUps(now);

  writeCronHeartbeat("renewal-reminders");
  return NextResponse.json({
    ...renewal,
    day21Checked: day21.checked,
    day21Sent: day21.sent,
    pastDueChecked: pastDue.checked,
    pastDueFollowUpsSent: pastDue.sent,
    pastDueRecovered: pastDue.recovered,
  });
}
