/**
 * HERO-41: long media maintenance scans must hand the box back when customer
 * renders arrive. The eviction entrypoint used to evaluate `--deferWhenBusy`
 * once at process start, so a run that began on an idle VPS kept the storage
 * lock for over two hours while renders queued behind it.
 *
 * Note the unit already sets `Nice=15`, `CPUWeight=10` and idle IO scheduling
 * and still caused contention: what these runs hold is the SQLite write lock,
 * which no scheduler priority can yield. Stopping the loop is the only lever.
 *
 * A gate is polled from inside the scan loops and reports WHY it fired:
 *
 * - `customer_media_active` — work arrived, hand the machine back. Throttled by
 *   iteration count and wall time so the activity query never becomes the load
 *   it is meant to relieve.
 * - `runtime_budget` — the run outstayed its welcome on an idle box, where no
 *   customer work will ever arrive to displace it. Checked on every call since
 *   it costs nothing, and it is what actually bounds the runtime.
 *
 * Once fired the gate latches, because a run that has decided to stop must not
 * keep querying on the way out.
 */
export type YieldReason = "customer_media_active" | "runtime_budget";

export type YieldCheck = () => boolean | Promise<boolean>;

export const DEFAULT_YIELD_EVERY_ITEMS = 200;
export const DEFAULT_YIELD_MIN_INTERVAL_MS = 5_000;

export type YieldGateOptions = {
  everyItems?: number;
  minIntervalMs?: number;
  /** Epoch ms after which the run stops regardless of activity. */
  deadlineAt?: number;
  now?: () => number;
};

export type YieldGate = (options?: { force?: boolean }) => Promise<YieldReason | null>;

export function createYieldGate(
  check: YieldCheck | undefined,
  options: YieldGateOptions = {},
): YieldGate {
  const { deadlineAt } = options;
  if (!check && deadlineAt === undefined) return async () => null;

  const everyItems = Math.max(1, Math.trunc(options.everyItems ?? DEFAULT_YIELD_EVERY_ITEMS));
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? DEFAULT_YIELD_MIN_INTERVAL_MS);
  const now = options.now ?? (() => Date.now());

  let seen = 0;
  let lastCheckedAt = Number.NEGATIVE_INFINITY;
  let latched: YieldReason | null = null;

  return async function shouldYield(
    gateOptions: { force?: boolean } = {},
  ): Promise<YieldReason | null> {
    if (latched) return latched;

    const at = now();
    if (deadlineAt !== undefined && at >= deadlineAt) {
      latched = "runtime_budget";
      return latched;
    }
    if (!check) return null;

    seen += 1;
    if (!gateOptions.force && seen % everyItems !== 0) return null;
    if (!gateOptions.force && at - lastCheckedAt < minIntervalMs) return null;
    lastCheckedAt = at;
    latched = (await check()) ? "customer_media_active" : null;
    return latched;
  };
}
