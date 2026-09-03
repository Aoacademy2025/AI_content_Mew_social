// Auto Mix source planning — pure, no I/O.
//
// The old Automix was video-FIRST-fallback: images/AI were fetched only for keywords
// that found ZERO video, so with the default providers it always collapsed to 100%
// video. These helpers instead pre-assign each b-roll PIECE a source by weight, so the
// pipeline fetches a real, interleaved mix (default video:photo:ai = 3:2:1) across a
// cadence-capped number of pieces — video/photo are free, AI (paid) gets the smallest
// share by default.

export type AutoMixSource = "video" | "photo" | "ai";
export type AutoMixWeights = { video: number; photo: number; ai: number };

/** Parse the exact new-image ceiling approved in Render Receipt. Fail closed:
 * strings, fractions, negatives and out-of-range numbers are not equivalent to
 * an unlimited budget. Public API/worker seams share this parser. */
export function parseAutoMixReceiptImageCeiling(value: unknown): number | null {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= 60
    ? value
    : null;
}

/** Product-level lazy trigger for Content Preflight. Loading the Brand Library
 * is cheap and independent; semantic scene analysis begins only when an AI
 * visual path, explicit settings, an established immutable pin, or a picker
 * that is already on screen and waiting for the analysis needs it. */
export function shouldLoadBrandVisualContext(input: {
  brollSource: string;
  mixPreset: string;
  hasPersistedVisualPin: boolean;
  settingsOpen: boolean;
  /**
   * Wave 1b (#430): a LIBRARY user — every plan, FREE included — is already
   * being offered a brand picker that this analysis is what unlocks. Before
   * wave 1b the pinning cohort always had an AI source or a pin, so one of the
   * triggers above was always true for anyone who could choose; a FREE account
   * on stock B-roll with no pin has none of them and would sit under
   * "กำลังวิเคราะห์เนื้อหาปัจจุบันก่อนเปิดให้เลือกแบรนด์" forever.
   *
   * It is deliberately the picker being VISIBLE, not bare library access: the
   * analysis is one managed text call (bounded per account by
   * `reserveAiTextCall` and cached per project + source hash), so it is spent
   * for an account that is being shown a choice, not for every editor session.
   */
  libraryPickerVisible: boolean;
}): boolean {
  return input.hasPersistedVisualPin
    || input.settingsOpen
    || input.libraryPickerVisible
    || input.brollSource === "kie-image"
    || ((input.brollSource === "automix" || input.brollSource === "auto-mix")
      && input.mixPreset !== "free");
}

/**
 * Product default for a brand-new paid project. This is deliberately separate
 * from the legacy managed-KIE/internal-tester gate: that gate controls old
 * provider tooling, while the public Hero/Brand Visual policies decide whether
 * the recommended AutoMix can actually generate an AI slot.
 *
 * Existing projects never call this as a migration. Their persisted Mix Preset
 * remains authoritative.
 */
export function shouldDefaultToRecommendedAutoMix(input: {
  effectivePlan: string | null | undefined;
  heroAiImageEligible: boolean;
  brandVisualAllowed: boolean;
}): boolean {
  const paidPlan = input.effectivePlan === "PRO" || input.effectivePlan === "BUSINESS";
  return paidPlan && (input.heroAiImageEligible || input.brandVisualAllowed);
}

/**
 * Assign a source to each of `n` pieces by weight, smoothly interleaved (not blocked).
 * Sources with weight 0 never appear. If every weight is 0, returns all "video"
 * (a usable default — never empty/undefined entries). Uses a deficit-based weighted
 * round-robin so e.g. 6 pieces @ 3:2:1 → [video, photo, video, ai, photo, video].
 */
export function planAutoMixSources(n: number, weights: AutoMixWeights): AutoMixSource[] {
  const count = Math.max(0, Math.floor(n));
  if (count === 0) return [];
  const entries = ([
    ["video", Math.max(0, weights.video)],
    ["photo", Math.max(0, weights.photo)],
    ["ai", Math.max(0, weights.ai)],
  ] as [AutoMixSource, number][]).filter(([, w]) => w > 0);
  if (entries.length === 0) return Array.from({ length: count }, () => "video" as AutoMixSource);

  const total = entries.reduce((a, [, w]) => a + w, 0);
  // AutoMix must be an actual mix when there are enough slots. Reserve one slot
  // for every enabled source, then distribute the remainder by weight. This keeps
  // a short three-piece AutoMix from silently collapsing to video+photo only.
  if (count >= entries.length) {
    const target: Record<AutoMixSource, number> = { video: 0, photo: 0, ai: 0 };
    for (const [source] of entries) target[source] = 1;
    const remaining = count - entries.length;
    const extras: Record<AutoMixSource, number> = { video: 0, photo: 0, ai: 0 };
    for (let i = 0; i < remaining; i += 1) {
      let best = entries[0][0];
      let bestDeficit = -Infinity;
      for (const [source, weight] of entries) {
        const deficit = ((i + 1) * weight) / total - extras[source];
        if (deficit > bestDeficit) {
          bestDeficit = deficit;
          best = source;
        }
      }
      extras[best]++;
      target[best]++;
    }

    const served: Record<AutoMixSource, number> = { video: 0, photo: 0, ai: 0 };
    const mixed: AutoMixSource[] = [];
    for (let i = 0; i < count; i += 1) {
      let best = entries[0][0];
      let bestDeficit = -Infinity;
      for (const [source] of entries) {
        const deficit = ((i + 1) * target[source]) / count - served[source];
        if (deficit > bestDeficit) {
          bestDeficit = deficit;
          best = source;
        }
      }
      mixed.push(best);
      served[best]++;
    }
    return mixed;
  }

  const served: Record<AutoMixSource, number> = { video: 0, photo: 0, ai: 0 };
  const out: AutoMixSource[] = [];
  for (let i = 0; i < count; i++) {
    let best: AutoMixSource = entries[0][0];
    let bestDeficit = -Infinity;
    for (const [src, w] of entries) {
      // ideal cumulative count after i+1 picks = (i+1)*w/total; pick the most-behind source
      const deficit = ((i + 1) * w) / total - served[src];
      if (deficit > bestDeficit) { bestDeficit = deficit; best = src; }
    }
    out.push(best);
    served[best]++;
  }
  return out;
}

/**
 * Cap the paid "ai" slots of a plan at `keep`, keeping the EARLIEST slots (the order
 * the generator processes them in). Returns both halves; the caller decides what the
 * demoted slots become — the caller may omit them to reduce AI density or use
 * an explicit fallback for non-entitlement failures.
 *
 * `keep = null` means "no ceiling" — nothing is demoted. Two ceilings use this:
 *   1. the AI-image count the client disclosed in its Render Receipt (`maxAiImages`),
 *   2. how many slots the user's credit balance can actually fund.
 */
export function clampAutoMixAiSlots(
  slots: Iterable<number>,
  keep: number | null,
): { kept: number[]; demoted: number[] } {
  const ordered = [...slots].sort((a, b) => a - b);
  if (keep === null || !Number.isFinite(keep)) return { kept: ordered, demoted: [] };
  const limit = Math.max(0, Math.floor(keep));
  return { kept: ordered.slice(0, limit), demoted: ordered.slice(limit) };
}

/** Keep a reduced set of NEW AI slots distributed across the timeline. This is
 * used after reusable assets have been removed from the paid-work set, so the
 * remaining allowance/receipt budget produces lower density instead of a
 * front-loaded cluster or hidden Stock substitutions. */
export function distributeAutoMixAiSlots(
  slots: Iterable<number>,
  keep: number,
): { kept: number[]; demoted: number[] } {
  const ordered = [...slots].sort((left, right) => left - right);
  const keptPositions = new Set(pickEvenIndices(ordered.length, Math.max(0, keep)));
  return {
    kept: ordered.filter((_, index) => keptPositions.has(index)),
    demoted: ordered.filter((_, index) => !keptPositions.has(index)),
  };
}

/**
 * Pick `n` evenly-spaced indices from [0, total) (ascending, unique). Used to choose
 * which captions become active b-roll pieces when the cadence cap wants fewer pieces
 * than there are captions — spreads the chosen captions across the whole script.
 * When n >= total, returns every index.
 */
export function pickEvenIndices(total: number, n: number): number[] {
  const t = Math.max(0, Math.floor(total));
  const k = Math.max(0, Math.min(Math.floor(n), t));
  if (k === 0) return [];
  if (k === t) return Array.from({ length: t }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < k; i++) out.push(Math.floor(((i + 0.5) * t) / k));
  return out;
}
