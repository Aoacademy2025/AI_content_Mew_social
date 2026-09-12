/**
 * What "Video completed" means on /admin/insights (A4 rows #69, #70, #72, #76).
 *
 * It used to be counted over the `Video` table. On prod every `Video` row is `COMPLETED` —
 * `Video_ever_nonCOMPLETED = 0` — so the tile was the constant 100 %, and two of the Health Score's
 * six penalty terms (videoCompletionPenalty and statusStuckWithOutput, 35 of its 100 points) could
 * never fire. The tile also said "jobs" while reading a table that is not the job table.
 *
 * The number now means exactly what the label says, in the vocabulary of CONTEXT.md's Core Creation
 * Outcome: a **creation job** is a `VideoJob` of type `create`, and it completed when it reached
 * status `done`. Every other status is named rather than swallowed, so the buckets always add up to
 * the total — that is how 55 canceled jobs went missing from the old tile.
 *
 * Pure on purpose: the caller does the internal-team exclusion and the window, this decides only
 * what each bucket means. scripts/verify-admin-number-video-completed.ts pins it.
 */

/** VideoJob.type for a video creation run. Exports/burns are a different job and a different tile. */
export const CREATION_JOB_TYPE = "create";

/** VideoJob.status values that mean "this job has not settled yet" (schema: VideoJob.status). */
const IN_FLIGHT_STATUSES = new Set(["queued", "processing", "waiting_provider"]);

export type CreationJobRow = {
  status: string;
  type: string;
  outputJson: string | null;
};

/**
 * True when the job already has a delivered video behind it. Reads only `outputJson.videoUrl` —
 * the same field `parseVideoJobOutput` returns — deliberately inline so an admin read route does not
 * drag the MCP job module (render drain, minute credits, transactions) into its import graph.
 */
export function hasCreationOutput(job: CreationJobRow): boolean {
  if (!job.outputJson) return false;
  try {
    const parsed = JSON.parse(job.outputJson) as { videoUrl?: unknown };
    return typeof parsed?.videoUrl === "string" && parsed.videoUrl.trim().length > 0;
  } catch {
    return false;
  }
}

function pct(value: number, total: number) {
  if (total <= 0) return 0;
  return Math.round((value / total) * 100);
}

export function summarizeCreationJobs(jobs: CreationJobRow[]) {
  const creations = jobs.filter((job) => job.type === CREATION_JOB_TYPE);
  const inFlight = creations.filter((job) => IN_FLIGHT_STATUSES.has(job.status));

  const completed = creations.filter((job) => job.status === "done").length;
  const failed = creations.filter((job) => job.status === "failed").length;
  const canceled = creations.filter((job) => job.status === "canceled").length;
  const pending = creations.filter((job) => job.status === "queued").length;
  const processing = creations.filter((job) => job.status === "processing" || job.status === "waiting_provider").length;
  const outputReady = creations.filter(hasCreationOutput).length;

  return {
    total: creations.length,
    completed,
    processing,
    failed,
    pending,
    canceled,
    outputReady,
    // A job the orchestrator finished (its outputJson already carries a videoUrl) whose row never
    // flipped out of an in-flight status. This is the real "stuck" signal the Health Score wanted.
    statusStuckWithOutput: inFlight.filter(hasCreationOutput).length,
    processingWithoutOutput: inFlight.filter((job) => !hasCreationOutput(job)).length,
    completionPct: pct(completed, creations.length),
    outputReadyPct: pct(outputReady, creations.length),
  };
}
