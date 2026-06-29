import { reserveMinutes, refundMinutes } from "@/lib/minute-limits";
import { spendCredits, refundCredits, creditCostFor } from "@/lib/credits";
import { refundClipUsage } from "@/lib/usage-limits";

export type ReserveResult =
  | { allowed: true; via: "minutes"; reservedMinutes: number; remaining: number }
  | {
      allowed: true;
      via: "credits";
      creditsSpent: number;
      // The bucket split spendCredits actually drained (granted-first, then purchased).
      // MUST be threaded to refundReservation so a refund restores the EXACT buckets —
      // refunding the lump to `purchased` permanently inflates it (granted is hard-reset
      // monthly, purchased persists). fromGranted + fromPurchased === creditsSpent.
      fromGranted: number;
      fromPurchased: number;
      balanceAfter: number;
    }
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
      // Carry the real bucket split (granted-first) through so the refund hits the SAME
      // buckets the spend drained — see refundReservation / the H3 fix.
      return {
        allowed: true,
        via: "credits",
        creditsSpent: cost,
        fromGranted: spend.fromGranted,
        fromPurchased: spend.fromPurchased,
        balanceAfter: spend.balanceAfter,
      };
    }
  }
  return { allowed: false, via: "none", remaining: r.remaining, message: r.message };
}

/**
 * Refund a reservation, choosing the correct bucket:
 *  - credit-funded (creditsSpent>0) → refundCredits, split across the EXACT buckets the
 *    spend drained (creditsFromGranted to granted, the remainder to purchased)
 *  - minute-funded (reservedMinutes!=null) → refundMinutes
 *  - legacy clip-funded → refundClipUsage
 */
export async function refundReservation(
  userId: string,
  res: {
    reservedMinutes: number | null;
    creditsSpent: number | null;
    // The granted-bucket portion of creditsSpent (the rest came from purchased). Threaded
    // from reserveMinutesOrCredits → persisted on RenderJob.creditsFromGranted. Optional/
    // nullable for backward-compat: an in-flight job enqueued BEFORE this field existed has
    // no split, so we fall back to all-purchased (the pre-fix behavior) instead of crashing.
    creditsFromGranted?: number | null;
  },
  action: string
): Promise<void> {
  if (res.creditsSpent && res.creditsSpent > 0) {
    // Overflow spend drains the granted (monthly) bucket FIRST, then purchased. Refund to
    // the SAME buckets: refunding the whole amount to `purchased` would permanently INFLATE
    // it (granted is hard-reset every month, purchased persists) → free credits each month
    // (bug H3). Clamp to [0, creditsSpent] so a corrupt split can never make refundCredits
    // throw on a negative purchased remainder.
    const fromGranted = Math.max(0, Math.min(res.creditsFromGranted ?? 0, res.creditsSpent));
    const fromPurchased = res.creditsSpent - fromGranted;
    await refundCredits(userId, fromGranted, fromPurchased, action);
  } else if (res.reservedMinutes != null) {
    await refundMinutes(userId, res.reservedMinutes);
  } else {
    await refundClipUsage(userId);
  }
}
