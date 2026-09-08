/**
 * In-batch retry selection for Hero AI Image video scenes.
 *
 * A Hero AI Image render is all-or-nothing: if one scene of eight cannot be
 * delivered the whole batch is refunded and the customer sees a failed render,
 * even though the provider already produced (and we already paid for) the other
 * seven images. When the single loser is an *isolated, retryable* failure —
 * a transient DB timeout while persisting, a one-off provider hiccup — it is
 * far cheaper to re-run that one scene than to throw the batch away.
 *
 * This module holds only the decision, so it can be unit-tested without the
 * route: which scenes earn a second attempt, and which failures stay failures.
 *
 * Fail closed by design:
 *  - `systemic` (provider circuit) and `stopBatch` (stalled queue) failures are
 *    never retried — re-driving them is exactly the load that opened them.
 *  - the budget is small, so a broadly-broken batch fails fast instead of
 *    doubling the provider bill.
 *  - anything not selected keeps its failure entry, so the existing refund path
 *    still runs for it.
 */

export type HeroSceneFailure = {
  sourceIndex: number;
  systemic: boolean;
  retryable: boolean;
  stopBatch: boolean;
};

export const DEFAULT_HERO_IMAGE_SCENE_RETRY_MAX = 2;

export type SelectSceneRetriesOptions = {
  /** Maximum scenes to retry in this batch. Default 2; 0 disables retrying. */
  max?: number;
  /**
   * Scenes the provider phase actually owns. A failure outside this set (for
   * example a reused Brand Visual whose retained file vanished) has no provider
   * job to re-run, so it must keep its failure entry.
   */
  eligibleSourceIndexes?: Iterable<number>;
};

export function selectSceneRetries<F extends HeroSceneFailure>(
  failures: readonly F[],
  options: SelectSceneRetriesOptions = {},
): { retrySourceIndexes: number[]; remainingFailures: F[] } {
  const max = Math.max(0, Math.floor(options.max ?? DEFAULT_HERO_IMAGE_SCENE_RETRY_MAX));
  const eligible = options.eligibleSourceIndexes
    ? new Set(options.eligibleSourceIndexes)
    : null;

  const retrySourceIndexes: number[] = [];
  const remainingFailures: F[] = [];
  const queued = new Set<number>();

  for (const failure of failures) {
    const retryable = failure.retryable
      && !failure.systemic
      && !failure.stopBatch
      && (!eligible || eligible.has(failure.sourceIndex))
      && !queued.has(failure.sourceIndex);
    if (retryable && retrySourceIndexes.length < max) {
      queued.add(failure.sourceIndex);
      retrySourceIndexes.push(failure.sourceIndex);
      continue;
    }
    remainingFailures.push(failure);
  }

  return { retrySourceIndexes, remainingFailures };
}
