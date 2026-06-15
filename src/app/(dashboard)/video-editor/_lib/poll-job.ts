/**
 * pollJob — single hardened polling loop for long-running server jobs
 * (render / burn). Replaces the old setInterval pairs in video-editor/page.tsx.
 *
 * Guarantees:
 * - Single in-flight request: the loop is strictly sequential
 *   (await fetchOnce → await sleep), so a slow response can never stack a
 *   second request — unlike setInterval.
 * - Transient errors NEVER fail the job: network down, Nginx 502/504 HTML
 *   bodies that make res.json() throw SyntaxError, non-OK statuses — any
 *   throw from fetchOnce (except abort) is retried with exponential backoff
 *   (×1.5, capped) until maxTransientErrors CONSECUTIVE failures.
 * - Stale timeout: if reported progress does not CHANGE for staleTimeoutMs
 *   (default 10 min — long enough to survive the 2–5 min post-deploy
 *   Remotion bundle stall), rejects with PollStaleError (code "stale").
 * - AbortSignal: aborting rejects promptly with PollAbortError, whose
 *   name === "AbortError" so existing catch blocks recognize it.
 */

export type PollTick<T> =
  /** Job still running. `progress` feeds stale detection: any CHANGE resets
   *  the stale clock. `resetStale: true` resets it unconditionally (used
   *  while queued — queue waits are legitimate and bounded elsewhere). */
  | { status: "pending"; progress?: number | null; resetStale?: boolean }
  | { status: "done"; value: T }
  | { status: "failed"; error: string };

export class PollAbortError extends Error {
  readonly code = "aborted";
  constructor() { super("Aborted"); this.name = "AbortError"; }
}

export class PollStaleError extends Error {
  readonly code = "stale";
  constructor(staleTimeoutMs: number) {
    super(`No progress change for ${Math.round(staleTimeoutMs / 60000)} min`);
    this.name = "PollStaleError";
  }
}

export class PollFailedError extends Error {
  readonly code = "job_failed";
  constructor(message: string) { super(message); this.name = "PollFailedError"; }
}

export class PollTransientLimitError extends Error {
  readonly code = "transient_limit";
  constructor(count: number) {
    super(`Polling gave up after ${count} consecutive transient errors`);
    this.name = "PollTransientLimitError";
  }
}

export const BACKOFF_FACTOR = 1.5;
export const BACKOFF_CAP_MS = 15_000;

/** Pure backoff step: next delay after a transient error. Exported for tests. */
export function nextBackoffDelay(currentMs: number, capMs: number = BACKOFF_CAP_MS): number {
  return Math.min(Math.round(currentMs * BACKOFF_FACTOR), capMs);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new PollAbortError()); return; }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => { clearTimeout(timer); reject(new PollAbortError()); };
    timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface PollJobOptions<T> {
  /** One poll attempt. Return a PollTick; ANY throw (except abort) is treated
   *  as a transient error and retried with backoff. ctx.tick starts at 0 and
   *  the first call happens immediately (no initial delay). */
  fetchOnce: (ctx: { tick: number }) => Promise<PollTick<T>>;
  intervalMs: number;
  /** Reject with PollStaleError when progress hasn't changed this long.
   *  Default 10 min — survives the 2–5 min post-deploy bundle stall. */
  staleTimeoutMs?: number;
  /** Consecutive transient errors before giving up. Default 40 — at the 15s
   *  backoff cap that is roughly the same wall-clock budget as staleTimeoutMs. */
  maxTransientErrors?: number;
  /** Backoff cap; exposed so the verify script can use short values. */
  backoffCapMs?: number;
  /** Called with each finite progress value from a pending tick. */
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
}

export async function pollJob<T>(opts: PollJobOptions<T>): Promise<T> {
  const {
    fetchOnce, intervalMs, signal, onProgress,
    staleTimeoutMs = 600_000,
    maxTransientErrors = 40,
    backoffCapMs = BACKOFF_CAP_MS,
  } = opts;

  let delayMs = intervalMs;
  let consecutiveErrors = 0;
  let lastProgress: number | null = null;
  let lastChangeAt = Date.now();
  let tick = 0;

  for (;;) {
    if (signal?.aborted) throw new PollAbortError();

    try {
      const t = await fetchOnce({ tick });
      consecutiveErrors = 0;
      delayMs = intervalMs;
      if (t.status === "done") return t.value;
      if (t.status === "failed") throw new PollFailedError(t.error);
      if (t.resetStale) {
        lastChangeAt = Date.now();
      } else if (typeof t.progress === "number" && t.progress !== lastProgress) {
        lastProgress = t.progress;
        lastChangeAt = Date.now();
      }
      if (typeof t.progress === "number" && onProgress) onProgress(t.progress);
    } catch (err) {
      // Terminal outcomes pass through; everything else is transient.
      if (err instanceof PollFailedError) throw err;
      if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        throw new PollAbortError();
      }
      consecutiveErrors++;
      if (consecutiveErrors >= maxTransientErrors) {
        throw new PollTransientLimitError(consecutiveErrors);
      }
      delayMs = nextBackoffDelay(delayMs, backoffCapMs);
    }

    if (Date.now() - lastChangeAt > staleTimeoutMs) throw new PollStaleError(staleTimeoutMs);

    tick++;
    await sleep(delayMs, signal);
  }
}
