/**
 * HERO-41: long media maintenance scans must hand the box back when customer
 * renders arrive. The eviction entrypoint used to evaluate `--deferWhenBusy`
 * once at process start, so a run that began on an idle VPS kept ~98% of a core
 * and the storage lock for over 100 minutes while renders queued behind it.
 *
 * A gate is polled from inside the scan loops. It throttles two ways — every
 * `everyItems` iterations and at most once per `minIntervalMs` — so the check
 * itself never becomes the load it is meant to relieve. Once it fires it latches,
 * because a run that has decided to stop must not query again on the way out.
 */
export type YieldCheck = () => boolean | Promise<boolean>;

export const DEFAULT_YIELD_EVERY_ITEMS = 200;
export const DEFAULT_YIELD_MIN_INTERVAL_MS = 5_000;

export type YieldGateOptions = {
  everyItems?: number;
  minIntervalMs?: number;
  now?: () => number;
};

export function createYieldGate(
  check: YieldCheck | undefined,
  options: YieldGateOptions = {},
): () => Promise<boolean> {
  if (!check) return async () => false;

  const everyItems = Math.max(1, Math.trunc(options.everyItems ?? DEFAULT_YIELD_EVERY_ITEMS));
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? DEFAULT_YIELD_MIN_INTERVAL_MS);
  const now = options.now ?? (() => Date.now());

  let seen = 0;
  let lastCheckedAt = Number.NEGATIVE_INFINITY;
  let latched = false;

  return async function shouldYield(): Promise<boolean> {
    if (latched) return true;
    seen += 1;
    if (seen % everyItems !== 0) return false;
    const at = now();
    if (at - lastCheckedAt < minIntervalMs) return false;
    lastCheckedAt = at;
    latched = Boolean(await check());
    return latched;
  };
}
