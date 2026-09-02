/**
 * Per-window B-roll search policy (Phase 2 "เปลี่ยนรูป" tab).
 *
 * The window search runs the creator's keyword qualified by their Step-2
 * preferences. When that qualified query genuinely finds nothing we widen back
 * to the plain keyword once — a degrade rule on two FREE stock APIs, the same
 * one the render pipeline's fallback queries use.
 *
 * The distinction this module exists to keep: an EMPTY result and a FAILED
 * provider look identical once `Promise.allSettled` has swallowed the rejection.
 * Widening after a real zero helps the creator; widening after an outage or a
 * revoked/rate-limited key just doubles the failing calls and hides the real
 * cause. So the caller reports `allProvidersFailed` and the second search is
 * skipped in that case.
 */
export type WindowSearchOutcome<T> = {
  candidates: T[];
  /** True only when every provider that was actually asked threw/rejected. A
   *  provider with no key was never asked, so it can neither fail nor succeed. */
  allProvidersFailed: boolean;
};

export async function searchWindowCandidatesWithDegrade<T>(input: {
  styledQuery: string;
  plainKeyword: string;
  search: (query: string) => Promise<WindowSearchOutcome<T>>;
  /** Called just before the one widening search, for logging. */
  onDegrade?: (styledQuery: string) => void;
}): Promise<T[]> {
  const first = await input.search(input.styledQuery);
  const genuineZeroResult = first.candidates.length === 0 && !first.allProvidersFailed;
  if (!genuineZeroResult || input.styledQuery === input.plainKeyword) return first.candidates;
  input.onDegrade?.(input.styledQuery);
  const widened = await input.search(input.plainKeyword);
  return widened.candidates;
}
