/**
 * First-Clip day-one dashboard — pure state derivation (#304, #305).
 *
 * Deliberately import-free: `scripts/verify-first-clip-dashboard.ts` runs it
 * directly under `tsx`, and `src/components/quota-status.tsx` (a client
 * component) imports the low-quota threshold rule from here so the display
 * rule has exactly one home.
 */

/** Where an account stands on the way to its first exported clip. */
export type FirstClipState =
  | "no_script"
  | "rendering"
  | "rendered_not_exported"
  | "exported";

/**
 * `EditorProject.status` values that prove render/export progress.
 * Mirrors the transitions written by `api/videos/jobs` (rendering / exporting),
 * `api/videos/jobs/[id]` (post) and `api/videos` (exported).
 */
export const FIRST_CLIP_PROGRESS_STATUSES = [
  "rendering",
  "post",
  "exporting",
  "exported",
] as const;

export type FirstClipProgress = {
  /** A render job is in flight right now. */
  activeRender: boolean;
  /** At least one project has finished rendering (preview exists). */
  renderedClip: boolean;
};

/** Collapse a user's project statuses into the two progress booleans. */
export function summarizeFirstClipProgress(statuses: readonly string[]): FirstClipProgress {
  let activeRender = false;
  let renderedClip = false;
  for (const status of statuses) {
    if (status === "rendering") activeRender = true;
    else if (status === "post" || status === "exporting" || status === "exported") renderedClip = true;
  }
  return { activeRender, renderedClip };
}

/**
 * Furthest progress wins: an exported clip ends the day-one dashboard, a
 * finished render puts the creator on step 3 even while a second render runs.
 *
 * `hasExport` comes from the server's First-Clip Path decision
 * (reason === "has_completed_video"), which is the same COMPLETED-video check
 * that takes the account off the path.
 */
export function deriveFirstClipState(input: {
  hasExport: boolean;
  renderedClip: boolean;
  activeRender: boolean;
}): FirstClipState {
  if (input.hasExport) return "exported";
  if (input.renderedClip) return "rendered_not_exported";
  if (input.activeRender) return "rendering";
  return "no_script";
}

/**
 * The day-one hero replaces the standard dashboard only for accounts still on
 * the First-Clip Path AND before their first export. Everyone else — FREE,
 * internal/admin, and anyone who already exported — keeps today's dashboard.
 */
export function shouldShowFirstClipHero(input: { onPath: boolean; state: FirstClipState }): boolean {
  return input.onPath && input.state !== "exported";
}

/** 1-based index of the step the creator is standing on. */
export function firstClipStepIndex(state: FirstClipState): 1 | 2 | 3 {
  if (state === "no_script") return 1;
  if (state === "rendering") return 2;
  return 3;
}

/** A short-form clip is billed at roughly this many render minutes. */
export const APPROX_MINUTES_PER_SHORT_CLIP = 3;

/** "≈ N คลิปสั้น" hint for the one-number line. Never negative. */
export function approxShortClips(minutesRemaining: number): number {
  if (!Number.isFinite(minutesRemaining) || minutesRemaining <= 0) return 0;
  return Math.floor(minutesRemaining / APPROX_MINUTES_PER_SHORT_CLIP);
}

/**
 * Low-quota warning threshold (#304). Was `remaining <= 10 || ratio <= 0.15`,
 * which lit up amber for a 15-minute trial on its very first visit. Now purely
 * proportional: warn at 20% of the plan's own allowance or less.
 */
export const LOW_QUOTA_RATIO = 0.2;

export function isLowQuota(remaining: number, limit: number): boolean {
  if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0) return false;
  return remaining / limit <= LOW_QUOTA_RATIO;
}
