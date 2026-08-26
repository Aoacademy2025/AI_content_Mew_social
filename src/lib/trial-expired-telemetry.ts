import { prisma } from "@/lib/prisma";
import { recordTelemetryEventOnce } from "@/lib/telemetry";

/**
 * Exports the customer actually got out of the trial: a COMPLETED video that has a
 * playable URL. Mirrors userHasCompletedVideo() in first-clip-path.server.ts, but as
 * a count and without the server-only import (this module is reached from
 * entitlements.ts, which runs in plain tsx verify scripts too).
 */
export async function countCompletedExports(userId: string): Promise<number> {
  return prisma.video.count({
    where: {
      userId,
      status: "COMPLETED",
      OR: [{ videoUrl: { not: null } }, { avatarVideoUrl: { not: null } }],
    },
  });
}

/**
 * `trial_expired` — emitted once per user, at the moment the trial is reverted to
 * FREE, carrying the conversion evidence the cohort analysis needs.
 *
 * `minutesUsed` MUST be captured by the caller BEFORE the downgrade: reverting resets
 * the usage window to the FREE allowance, so reading it afterwards always yields 0.
 *
 * Best-effort: telemetry must never fail (or slow down) an entitlement transition.
 */
export async function recordTrialExpiredTelemetry(input: {
  userId: string;
  minutesUsed: number;
}): Promise<void> {
  try {
    const exportsCount = await countCompletedExports(input.userId);
    await recordTelemetryEventOnce(input.userId, `trial_expired:${input.userId}`, {
      name: "trial_expired",
      category: "product",
      source: "server",
      status: "done",
      value: exportsCount,
      properties: {
        hadFirstExport: exportsCount > 0,
        exportsCount,
        minutesUsed: Number.isFinite(input.minutesUsed) ? input.minutesUsed : 0,
      },
    });
  } catch {
    // Never let a telemetry write break the revert.
  }
}
