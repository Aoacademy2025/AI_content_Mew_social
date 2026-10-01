import { VIDEO_JOB_INFLIGHT_STATUSES } from "@/lib/mcp/video-job-status";
import { resolveMcpChain, writeMcpChainTerminalMarker } from "@/lib/mcp/chain-export";
import { cancelVideoJobCore, type CancelVideoJobResult } from "@/lib/mcp/video-job-cancel-core";

export type { CancelVideoJobResult };

/**
 * T10 (ADR 0063): route a `cancel_video_job(id)` call to the right row of an MCP chain —
 * `id` may be either the preview or the export id (resolveMcpChain accepts both, owner-scoped).
 *
 * - Preview still in flight → cancel the preview row (byte-identical to web DELETE on a
 *   `type:"create"` job). A canceled preview can never chain, because enqueue requires
 *   `status==="done"` — no marker needed.
 *   Fix round 1 (A1): if that cancel loses the race — the preview's own finish committed
 *   between our read above and the core's conditional `updateMany` — re-resolve the chain
 *   ONCE and fall through to the done-preview handling below, instead of reporting a false
 *   "already finished, cannot cancel" while the export is about to be enqueued and run.
 * - Preview done, an export row already exists and is in flight → cancel that export row
 *   (byte-identical to web DELETE on a `type:"export"` job; its own settlement path).
 * - Preview done, export row exists but is already terminal (done/failed/canceled) →
 *   not_cancelable — nothing in flight.
 * - Preview done, no export row yet (the gap between preview finish and export enqueue) →
 *   write a canceled terminal marker under the chain key so neither `get_video_status` nor
 *   the watchdog ever enqueues one afterwards. The preview's single charge already stands
 *   (Q10 — cancel during the export half follows web semantics), so there is nothing to
 *   settle for a job that was never created.
 * - The marker write loses a race to a concurrent enqueue (`exists`) → re-resolve and cancel
 *   whatever is now really under the key, if it is still in flight.
 * - A conflicting foreign row already holds the chain key, or the preview is already
 *   terminal itself → not_cancelable.
 * - `id` is not part of any MCP chain (plain job, or chain feature off) → the plain
 *   single-job cancel. A foreign id resolves to no chain (owner-scoped) and then to
 *   "not found" in the plain path too, so both a foreign id and an already-terminal id
 *   return the exact same not_cancelable shape — no existence oracle.
 */
export async function cancelMcpVideoJob(userId: string, jobId: string): Promise<CancelVideoJobResult> {
  let chain = await resolveMcpChain(userId, jobId);
  if (!chain) return cancelVideoJobCore(userId, jobId);

  const inFlight = (status: string) => (VIDEO_JOB_INFLIGHT_STATUSES as readonly string[]).includes(status);

  if (inFlight(chain.preview.status)) {
    const result = await cancelVideoJobCore(userId, chain.preview.id);
    if (result.kind === "canceled") return result;
    // A1: the preview finished before our updateMany ran. Re-resolve once — a second loss
    // here is a real terminal/conflict state, not another race — and fall through.
    const reresolved = await resolveMcpChain(userId, chain.preview.id);
    if (!reresolved) return { kind: "not_cancelable" };
    chain = reresolved;
  }

  const { preview, exportJob, conflict } = chain;
  if (preview.status !== "done") return { kind: "not_cancelable" };

  if (exportJob) {
    return inFlight(exportJob.status)
      ? cancelVideoJobCore(userId, exportJob.id)
      : { kind: "not_cancelable" };
  }
  if (conflict) return { kind: "not_cancelable" };

  const marker = await writeMcpChainTerminalMarker({
    userId,
    previewJobId: preview.id,
    status: "canceled",
    code: "canceled_by_user",
    message: "canceled by user (mcp)",
  });
  if (marker.kind === "not_chain") return { kind: "not_cancelable" };
  if (marker.kind === "written") return { kind: "canceled", settlementPending: false };

  // "exists": a concurrent enqueue won the race and created the real export row (or an
  // earlier refusal/cancel already closed the chain). Cancel it normally if still in flight.
  const resolved = await resolveMcpChain(userId, preview.id);
  return resolved?.exportJob && inFlight(resolved.exportJob.status)
    ? cancelVideoJobCore(userId, resolved.exportJob.id)
    : { kind: "not_cancelable" };
}
