import { isTransientSqliteError } from "@/lib/sqlite-retry";

/**
 * Transient-database retry for writes that must not be lost.
 *
 * SQLite has a single writer, so a burst of concurrent renders can push an
 * interactive Prisma transaction past its 5s budget ("Transaction already
 * closed") or make the driver give up on a busy socket. Those failures say
 * nothing about the work itself — the caller has already paid the provider and
 * the artefact is already on disk — so the right answer is to try the same
 * write again a moment later, not to fail and refund the customer's render.
 *
 * This is deliberately narrow: anything that is not a known contention/timeout
 * signal is rethrown unchanged on the first attempt. `sqlite-retry.ts` covers
 * the code-only classification used by the billing paths; this adds the message
 * shapes Prisma raises when an *interactive transaction* expires.
 */

const TRANSIENT_PRISMA_CODES = new Set([
  "P2024", // Timed out fetching a new connection from the pool
  "P2028", // Transaction API error (expired / already closed)
  "P2034", // Transaction failed due to a write conflict or deadlock
]);

const TRANSIENT_MESSAGE_PATTERN =
  /transaction already closed|socket timeout|database is locked|SQLITE_BUSY/i;

/** Prisma error codes are short opaque identifiers — safe to log. */
const SAFE_CODE_PATTERN = /^P\d{4}$/;

export function isTransientDbError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (isTransientSqliteError(error)) return true;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_PRISMA_CODES.has(code)) return true;
  return TRANSIENT_MESSAGE_PATTERN.test(error.message);
}

/**
 * 250 / 750 / 2000 ms. Long enough for the competing writer to commit, short
 * enough that three attempts still fit inside a render step's budget.
 */
const BACKOFF_MULTIPLIERS = [1, 3, 8] as const;

export function transientRetryDelayMs(attempt: number, baseDelayMs: number): number {
  const index = Math.min(Math.max(1, Math.floor(attempt)), BACKOFF_MULTIPLIERS.length) - 1;
  return Math.round(baseDelayMs * BACKOFF_MULTIPLIERS[index]);
}

function transientCodeOf(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && SAFE_CODE_PATTERN.test(code) ? code : "unclassified";
}

export type TransientDbRetryOptions = {
  /** Total attempts, including the first. Default 3. */
  attempts?: number;
  /** First backoff step in ms; later steps are 3x and 8x this. Default 250. */
  baseDelayMs?: number;
  /** Operation name used in the retry warning. Never include user data. */
  label: string;
  /** Injectable for tests so a verify run never actually waits. */
  sleep?: (delayMs: number) => Promise<void>;
  /** Injectable sink for the retry warning. Defaults to console.warn. */
  log?: (message: string) => void;
};

export async function withTransientDbRetry<T>(
  operation: () => Promise<T>,
  options: TransientDbRetryOptions,
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
  const baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs ?? 250));
  const sleep = options.sleep
    ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const log = options.log ?? ((message: string) => console.warn(message));

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isTransientDbError(error)) throw error;
      const delayMs = transientRetryDelayMs(attempt, baseDelayMs);
      log(
        `[transient-db-retry] ${options.label}: attempt ${attempt}/${attempts} hit a transient database error `
        + `(${transientCodeOf(error)}); retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }
}
