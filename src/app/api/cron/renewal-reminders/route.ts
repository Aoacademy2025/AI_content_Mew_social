import { NextResponse } from "next/server";
import { timingSafeStrEqual } from "@/lib/timing-safe-equal";
import { writeCronHeartbeat } from "@/lib/cron-heartbeat";
import { sendDueDay21ConvertReminders } from "@/lib/day21-convert-reminder.server";
import { sendDueRenewalReminders } from "@/lib/renewal-reminders.server";
import {
  sendDueGrantExpiryReminders,
  type GrantExpiryReminderRun,
} from "@/lib/grant-expiry-reminders.server";
import { sendDuePastDueFollowUps } from "@/lib/past-due-dunning.server";
import {
  sendDueLapsedPayerReminders,
  sendDuePaidActivationReminders,
} from "@/lib/dormant-payers.server";
import {
  sendDueCheckoutRecoveryReminders,
  type CheckoutRecoveryRun,
} from "@/lib/checkout-recovery-reminder.server";

export const runtime = "nodejs";

// GET /api/cron/renewal-reminders  (daily, Bearer CRON_SECRET)
// Reminds the manual-renew cohort (one-time / PromptPay — no auto-renew subscription) before their plan lapses.
// Also carries the HERO-33 past_due +3-day follow-up, HERO-99 GRANT coupon expiry sweep (d7/d3/d1),
// and HERO-111 failed/abandoned checkout recovery sweep so no new PM2 app is needed.
// Fault-isolated so secondary sweep errors never abort cash renewal reminders.
// Fails CLOSED if CRON_SECRET is unset.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || !timingSafeStrEqual(auth ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const renewal = await sendDueRenewalReminders(now);

  let grantExpiry: GrantExpiryReminderRun | null = null;
  let grantExpiryError: string | null = null;
  try {
    grantExpiry = await sendDueGrantExpiryReminders(now);
  } catch (error) {
    grantExpiryError = error instanceof Error ? error.message : "grant_expiry_sweep_failed";
    console.error("[cron/renewal-reminders] grant-expiry sweep failed:", error);
  }

  const day21 = await sendDueDay21ConvertReminders(now);
  const pastDue = await sendDuePastDueFollowUps(now);
  const paidActivation = await sendDuePaidActivationReminders(now);
  const lapsedPayer = await sendDueLapsedPayerReminders(now);

  let checkoutRecovery: CheckoutRecoveryRun | null = null;
  let checkoutRecoveryError: string | null = null;
  try {
    checkoutRecovery = await sendDueCheckoutRecoveryReminders(now);
  } catch (error) {
    checkoutRecoveryError =
      error instanceof Error ? error.message : "checkout_recovery_sweep_failed";
    console.error("[cron/renewal-reminders] checkout-recovery sweep failed:", error);
  }

  writeCronHeartbeat("renewal-reminders");
  return NextResponse.json({
    ...renewal,
    grantExpiryChecked: grantExpiry?.checked ?? 0,
    grantExpiryEligible: grantExpiry?.eligible ?? 0,
    grantExpirySuppressed: grantExpiry?.suppressed ?? 0,
    grantExpiryClaimed: grantExpiry?.claimed ?? 0,
    grantExpirySent: grantExpiry?.remindersSent ?? 0,
    grantExpiryFailed: grantExpiry?.deliveryFailed ?? 0,
    grantExpiryByKind: grantExpiry?.byKind ?? { d7: 0, d3: 0, d1: 0 },
    ...(grantExpiryError ? { grantExpiryError } : {}),
    day21Checked: day21.checked,
    day21Sent: day21.sent,
    pastDueChecked: pastDue.checked,
    pastDueFollowUpsSent: pastDue.sent,
    pastDueRecovered: pastDue.recovered,
    paidActivationChecked: paidActivation.checked,
    paidActivationSent: paidActivation.sent,
    lapsedPayerChecked: lapsedPayer.checked,
    lapsedPayerSent: lapsedPayer.sent,
    checkoutRecoveryChecked: checkoutRecovery?.checked ?? 0,
    checkoutRecoverySent: checkoutRecovery?.sent ?? 0,
    checkoutRecoveryFailed: checkoutRecovery?.failed ?? 0,
    ...(checkoutRecoveryError ? { checkoutRecoveryError } : {}),
  });
}
