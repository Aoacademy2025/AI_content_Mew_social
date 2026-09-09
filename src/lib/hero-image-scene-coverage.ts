/**
 * HERO-12: which already-delivered scene image covers a window whose own image
 * never arrived.
 *
 * A Hero AI Image batch is billed per scene, so a batch that loses one scene of
 * eight still holds seven images the customer paid for and RunPod already
 * produced. Refunding and failing the whole video for that (the pre-HERO-12
 * behaviour) cost 4 create jobs and 29 discarded images on 2026-09-09 alone.
 * Instead each uncovered window borrows the nearest delivered scene's image and
 * gets its own Ken Burns move over that window's duration, which reads as the
 * adjacent shot holding.
 *
 * Borrowing an in-batch image, rather than dropping to a stock photo, is
 * deliberate: the selected mood steers both the AI prompt and the stock ranker,
 * so a photo would not be off-mood, but generated imagery and photography read
 * as different media inside one clip.
 */

export type SceneCoverageAssignment = {
  /** The window that has no image of its own. */
  sourceIndex: number;
  /** The delivered scene whose image covers it. */
  coveredFromSourceIndex: number;
};

/**
 * Pure selection: no I/O, no provider calls, no billing. Returns one assignment
 * per missing window, ordered by window. An empty result means there is nothing
 * to borrow from and the caller must keep failing the batch.
 */
export function selectSceneCoverage(input: {
  coveredSourceIndexes: Iterable<number>;
  missingSourceIndexes: Iterable<number>;
}): SceneCoverageAssignment[] {
  const covered = [...new Set(input.coveredSourceIndexes)].sort((a, b) => a - b);
  if (covered.length === 0) return [];
  const coveredLookup = new Set(covered);
  return [...new Set(input.missingSourceIndexes)]
    .filter((sourceIndex) => !coveredLookup.has(sourceIndex))
    .sort((a, b) => a - b)
    .map((sourceIndex) => ({
      sourceIndex,
      coveredFromSourceIndex: nearestCovered(covered, sourceIndex),
    }));
}

/**
 * Nearest by window distance. `covered` is ascending and scanned in order, so a
 * tie goes to the preceding scene: the previous shot holds through the gap
 * rather than the next one starting early.
 */
function nearestCovered(covered: number[], sourceIndex: number): number {
  let best = covered[0];
  let bestDistance = Math.abs(best - sourceIndex);
  for (const candidate of covered) {
    const distance = Math.abs(candidate - sourceIndex);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
