import { prisma } from "@/lib/prisma";
import { videoExpiryFor } from "@/lib/plan-limits";

/**
 * Extend expiresAt of non-expired videos for a user to match the new plan's
 * retention window. Called whenever a user's plan is upgraded (coupon, upgrade,
 * payment, admin change). Won't shorten expiry — only extends it.
 *
 * @returns number of videos updated
 */
export async function extendVideoExpiryForPlan(userId: string, newPlan: string): Promise<number> {
  const now = new Date();
  const newExpiry = videoExpiryFor(newPlan, now);

  const { count } = await prisma.video.updateMany({
    where: {
      userId,
      expiresAt: { gt: now, lt: newExpiry },
    },
    data: { expiresAt: newExpiry },
  });

  return count;
}
