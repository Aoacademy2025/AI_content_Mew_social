import { NextResponse } from "next/server";
import { writeCronHeartbeat } from "@/lib/cron-heartbeat";
import { runAuthorizedCronJob } from "@/lib/cron-route";
import { sendDueDay21ConvertReminders } from "@/lib/day21-convert-reminder.server";
import { sendDueRenewalReminders } from "@/lib/renewal-reminders.server";
import { sendDueGrantExpiryReminders } from "@/lib/grant-expiry-reminders.server";
import { sendDuePastDueFollowUps } from "@/lib/past-due-dunning.server";
import {
  sendDueLapsedPayerReminders,
  sendDuePaidActivationReminders,
} from "@/lib/dormant-payers.server";
import { sendDueCheckoutRecoveryReminders } from "@/lib/checkout-recovery-reminder.server";

export const runtime = "nodejs";

async function runIsolatedSweep<T>(
  label: string,
  fallbackError: string,
  fn: () => Promise<T>,
): Promise<{ result: T | null; error: string | null }> {
  try {
    return { result: await fn(), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : fallbackError;
    console.error(`[cron/renewal-reminders] ${label} sweep failed:`, error);
    return { result: null, error: message };
  }
}

// GET /api/cron/renewal-reminders  (daily 09:15 Asia/Bangkok = 02:15 UTC, Bearer CRON_SECRET)
// Reminds the manual-renew cohort (one-time / PromptPay — no auto-renew subscription) before their plan lapses.
// Also carries the HERO-33 past_due +3-day follow-up, HERO-99 GRANT coupon expiry sweep (d7/d3/d1),
// HERO-81/102 dormant payer nudges, and HERO-111 failed/abandoned checkout recovery sweep so no new PM2 app is needed.
// Single-flight guarded (409 on overlap) and fault-isolated so secondary sweep errors never abort cash renewal reminders.
// Fails CLOSED if CRON_SECRET is unset.
export async function GET(req: Request) {
  const result = await runAuthorizedCronJob({
    authorization: req.headers.get("authorization"),
    secret: process.env.CRON_SECRET,
    name: "renewal-reminders",
    onSuccess: writeCronHeartbeat,
    run: async () => {
      const startedAt = Date.now();
      const now = new Date();
      const renewal = await sendDueRenewalReminders(now);

      const grantExpiry = await runIsolatedSweep(
        "grant-expiry",
        "grant_expiry_sweep_failed",
        () => sendDueGrantExpiryReminders(now),
      );
      const day21 = await runIsolatedSweep(
        "day21-convert",
        "day21_convert_sweep_failed",
        () => sendDueDay21ConvertReminders(now),
      );
      const pastDue = await runIsolatedSweep(
        "past-due",
        "past_due_sweep_failed",
        () => sendDuePastDueFollowUps(now),
      );
      const paidActivation = await runIsolatedSweep(
        "paid-activation",
        "paid_activation_sweep_failed",
        () => sendDuePaidActivationReminders(now),
      );
      const lapsedPayer = await runIsolatedSweep(
        "lapsed-payer",
        "lapsed_payer_sweep_failed",
        () => sendDueLapsedPayerReminders(now),
      );
      const checkoutRecovery = await runIsolatedSweep(
        "checkout-recovery",
        "checkout_recovery_sweep_failed",
        () => sendDueCheckoutRecoveryReminders(now),
      );

      const elapsedMs = Date.now() - startedAt;
      console.log(
        `[cron/renewal-reminders] completed in ${elapsedMs}ms renewal=${renewal.remindersSent} `
        + `grant=${grantExpiry.result?.remindersSent ?? 0} day21=${day21.result?.sent ?? 0} `
        + `pastDue=${pastDue.result?.sent ?? 0} paidAct=${paidActivation.result?.sent ?? 0} `
        + `lapsed=${lapsedPayer.result?.sent ?? 0} checkout=${checkoutRecovery.result?.sent ?? 0}`,
      );

      return {
        ...renewal,
        grantExpiryChecked: grantExpiry.result?.checked ?? 0,
        grantExpiryEligible: grantExpiry.result?.eligible ?? 0,
        grantExpirySuppressed: grantExpiry.result?.suppressed ?? 0,
        grantExpiryClaimed: grantExpiry.result?.claimed ?? 0,
        grantExpirySent: grantExpiry.result?.remindersSent ?? 0,
        grantExpiryFailed: grantExpiry.result?.deliveryFailed ?? 0,
        grantExpiryByKind: grantExpiry.result?.byKind ?? { d7: 0, d3: 0, d1: 0 },
        ...(grantExpiry.error ? { grantExpiryError: grantExpiry.error } : {}),
        day21Checked: day21.result?.checked ?? 0,
        day21Sent: day21.result?.sent ?? 0,
        ...(day21.error ? { day21Error: day21.error } : {}),
        pastDueChecked: pastDue.result?.checked ?? 0,
        pastDueFollowUpsSent: pastDue.result?.sent ?? 0,
        pastDueRecovered: pastDue.result?.recovered ?? 0,
        ...(pastDue.error ? { pastDueError: pastDue.error } : {}),
        paidActivationChecked: paidActivation.result?.checked ?? 0,
        paidActivationSent: paidActivation.result?.sent ?? 0,
        ...(paidActivation.error ? { paidActivationError: paidActivation.error } : {}),
        lapsedPayerChecked: lapsedPayer.result?.checked ?? 0,
        lapsedPayerSent: lapsedPayer.result?.sent ?? 0,
        ...(lapsedPayer.error ? { lapsedPayerError: lapsedPayer.error } : {}),
        checkoutRecoveryChecked: checkoutRecovery.result?.checked ?? 0,
        checkoutRecoverySent: checkoutRecovery.result?.sent ?? 0,
        checkoutRecoveryFailed: checkoutRecovery.result?.failed ?? 0,
        ...(checkoutRecovery.error ? { checkoutRecoveryError: checkoutRecovery.error } : {}),
      };
    },
  });

  return NextResponse.json(result.body, { status: result.status });
}
