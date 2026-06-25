import { reserveMinutes, refundMinutes } from "@/lib/minute-limits";
import { spendCredits, refundCredits, creditCostFor } from "@/lib/credits";
import { refundClipUsage } from "@/lib/usage-limits";

export type ReserveResult =
  | { allowed: true; via: "minutes"; reservedMinutes: number; remaining: number }
  | { allowed: true; via: "credits"; creditsSpent: number; balanceAfter: number }
  | { allowed: false; via: "none"; remaining: number; message?: string };

/**
 * Reserve render capacity by minutes, silently falling back to credits when the
 * monthly minute quota is exhausted (the user purchased credits expressly to
 * render past their cap — no opt-in, no per-render consent dialog).
 *
 * - within quota → reserve minutes (via:"minutes")
 * - out of minutes + creditsLive + enough credits → spend minutes×2 credits
 *   (via:"credits"); the minute meter is NOT touched, leftover sub-cap minutes
 *   stay in quota.
 * - out of minutes + (creditsLive off OR insufficient credits) → via:"none"
 *   (caller walls). No partial spend.
 */
export async function reserveMinutesOrCredits(
  userId: string,
  minutes: number,
  opts: { creditsLive: boolean; ref?: string }
): Promise<ReserveResult> {
  const r = await reserveMinutes(userId, minutes);
  if (r.allowed) {
    return { allowed: true, via: "minutes", reservedMinutes: minutes, remaining: r.remaining };
  }
  if (opts.creditsLive) {
    const cost = minutes * creditCostFor("minute"); // 2 credits / minute
    const action = opts.ref ? `render-overflow:${opts.ref}` : "render-overflow";
    const spend = await spendCredits(userId, cost, action);
    if (spend.ok) {
      return { allowed: true, via: "credits", creditsSpent: cost, balanceAfter: spend.balanceAfter };
    }
  }
  return { allowed: false, via: "none", remaining: r.remaining, message: r.message };
}

/**
 * Refund a reservation, choosing the correct bucket:
 *  - credit-funded (creditsSpent>0) → refundCredits
 *  - minute-funded (reservedMinutes!=null) → refundMinutes
 *  - legacy clip-funded → refundClipUsage
 */
export async function refundReservation(
  userId: string,
  res: { reservedMinutes: number | null; creditsSpent: number | null },
  action: string
): Promise<void> {
  if (res.creditsSpent && res.creditsSpent > 0) {
    await refundCredits(userId, res.creditsSpent, action);
  } else if (res.reservedMinutes != null) {
    await refundMinutes(userId, res.reservedMinutes);
  } else {
    await refundClipUsage(userId);
  }
}
