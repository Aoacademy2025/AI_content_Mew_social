/**
 * prisma-transaction-queue.ts — one in-process FIFO slot for Prisma transactions (HERO-70).
 *
 * Every Prisma transaction on SQLite opens with `BEGIN IMMEDIATE` (interactive and batch,
 * read-only or not), so only one can be past BEGIN at a time anyway. When two of THIS process's
 * transactions race for it, the loser waits inside the query engine: SQLite's busy handler sleeps
 * the engine worker thread that runs the statement. Enough of those sleepers and the transaction
 * that holds the lock cannot get a thread for its next statement or its COMMIT, so everyone
 * waits a full busy_timeout (20 s on production). Waiting here instead — an awaited promise on
 * the JS side — costs no engine thread and no pooled connection, and is first-come-first-served,
 * which SQLite's busy handler is not.
 *
 * This only orders transactions within one process. Across processes (web + mcp-video-worker)
 * the SQLite lock and busy_timeout still decide, exactly as before.
 *
 * Deliberately pure: no Prisma import and no logging. The caller supplies the timeout error.
 */

export type TransactionSlot = {
  /** Gives the slot to the next waiter, or frees it. Idempotent. */
  release: () => void;
  /** ms spent waiting for the slot. */
  queuedMs: number;
};

type Waiter = { grant: () => void };

export class TransactionQueue {
  private held = false;
  private readonly waiters: Waiter[] = [];

  /** Transactions ahead of a caller that asked now: the holder plus everyone waiting. */
  depth(): number {
    return (this.held ? 1 : 0) + this.waiters.length;
  }

  /**
   * Resolves once the caller holds the slot. Rejects with `timeoutError(queuedMs)` when the slot
   * does not come within `maxWaitMs`; the caller is then removed from the line and never runs.
   */
  acquire(maxWaitMs: number, timeoutError: (queuedMs: number) => Error): Promise<TransactionSlot> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve({ release: this.releaser(), queuedMs: 0 });
    }
    const enqueuedAt = Date.now();
    return new Promise<TransactionSlot>((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          clearTimeout(timer);
          resolve({ release: this.releaser(), queuedMs: Date.now() - enqueuedAt });
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(timeoutError(Date.now() - enqueuedAt));
      }, Math.max(0, maxWaitMs));
      // Deliberately NOT unref'd: a queued transaction is pending work, and a script whose only
      // remaining work is waiting here must wait, not exit as if it had finished.
      this.waiters.push(waiter);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Hand the slot straight to the next waiter, so nobody can jump the line between
      // this release and that waiter's turn.
      const next = this.waiters.shift();
      if (next) next.grant();
      else this.held = false;
    };
  }
}
