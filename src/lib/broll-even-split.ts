import type { BrollVideo } from "@/remotion/types";

type EvenSplitStock = {
  localUrl?: string;
  videoUrl?: string;
  duration?: number;
  keyword?: string;
  title?: string;
  query?: string;
  provider?: BrollVideo["provider"];
  contentProfile?: string;
  selectionReason?: string;
  relevanceScore?: number;
};

/**
 * Distribute EVERY usable clip evenly across the full audio duration.
 *
 * Used as the generate-config safety net: when the scene / per-subtitle mapping
 * produces zero segments (e.g. caption timing collapsed), the old fallback froze
 * ONE clip over the whole video — which reads to the user as "b-roll never loaded".
 * Spreading all fetched clips instead keeps the background changing and uses every
 * clip, so the timeline is never blank.
 *
 * Returns segments covering [0, audioDurationSec] with no gaps (last segment is
 * clamped to the exact audio end to avoid float drift).
 */
export function evenSplitBgVideos(stocks: EvenSplitStock[], audioDurationSec: number): BrollVideo[] {
  const usable = (stocks ?? []).filter((s) => s && (s.localUrl || s.videoUrl));
  if (usable.length === 0 || !(audioDurationSec > 0)) return [];

  const sliceSec = audioDurationSec / usable.length;
  return usable.map((sv, i) => ({
    src: (sv.localUrl ?? sv.videoUrl) as string,
    start: i * sliceSec,
    end: i === usable.length - 1 ? audioDurationSec : (i + 1) * sliceSec,
    clipOffset: 0,
    clipDuration: sv.duration && sv.duration > 0 ? sv.duration : 10,
    keyword: sv.keyword,
    title: sv.title,
    query: sv.query,
    provider: sv.provider,
    contentProfile: sv.contentProfile,
    selectionReason: sv.selectionReason,
    relevanceScore: sv.relevanceScore,
  }));
}

/**
 * Assign a pool-clip index to each caption by CYCLING through the pool
 * (0,1,…,poolSize-1,0,1,…) so per-subtitle b-roll changes on every caption and
 * every clip is used.
 *
 * Replaces an older "merge short captions into a neighbour" scheme that collapsed
 * dense subtitle modes (1-2 word cards): when 80+ captions were all shorter than the
 * 1.5s merge threshold, every caption chained back to pool[0] → a single frozen clip
 * (prod logs showed `ratio=1%`). Cycling cannot collapse — adjacent captions always
 * get different indices unless the pool holds a single clip.
 */
export function cyclePoolIndices(captionCount: number, poolSize: number): number[] {
  if (captionCount <= 0) return [];
  if (poolSize <= 0) return new Array(captionCount).fill(0);
  return Array.from({ length: captionCount }, (_, i) => i % poolSize);
}

/**
 * Target b-roll cut cadence (seconds per clip) for a video of the given length.
 * Anchors the product's "B-roll changes every 3–5s" promise. Used to (a) cap how many
 * AI images we pay to generate and (b) how long generate-config holds each clip.
 * Always within [3, 5] so cadence neither strobes nor drags.
 */
export function targetCadenceSec(durationSec: number): number {
  if (!(durationSec > 0)) return 4;
  if (durationSec <= 20) return 3.5;
  if (durationSec <= 45) return 4;
  return 4.5;
}

/**
 * How many AI images to generate (and PAY for) on the per-subtitle AI-gen / auto-mix
 * path. Decouples paid generations from caption count: a 21s clip with 17 captions
 * generates ceil(21/3.5)=6 images, not 17. Manual clip counts (isAuto=false) bypass the
 * cadence cap — the user explicitly chose the number — but always respect keywordCount
 * and the hard cap.
 */
export function aiGenPieceCount(
  durationSec: number,
  keywordCount: number,
  isAuto: boolean,
  hardCap: number,
): number {
  const byKeywords = Math.max(0, Math.floor(keywordCount));
  const cap = Math.max(1, Math.floor(hardCap));
  const base = Math.min(byKeywords, cap);
  if (!isAuto || !(durationSec > 0)) return base;
  const byCadence = Math.max(1, Math.ceil(durationSec / targetCadenceSec(durationSec)));
  return Math.max(1, Math.min(base, byCadence));
}

export type MinHoldCaption = { startSec: number; endSec: number };
export type MinHoldPoolClip = { src: string; duration: number };

/**
 * Decouple b-roll CUT cadence from CAPTION cadence: hold each clip for at least
 * `minHoldSec` (spanning several captions) instead of cutting on every caption.
 *
 * Why: per-subtitle mode assigns one clip PER caption, so in dense word-modes
 * (1–4 word cards, ~1s each) the background strobes ~1×/sec — far faster than the
 * "3–5s" the product promises, and reads as busy/cheap. Grouping captions into
 * minimum-hold buckets cuts a 90s/90-caption video from 90 cuts to ~30.
 *
 * FREEZE-SAFE INVARIANT (the thing to get right): the renderer plays each segment
 * via <OffthreadVideo> with NO loop and clamps endAt to the clip's real length, so
 * a segment that OUTLIVES its clip freezes on the last frame. This function
 * guarantees that never happens: clipOffset is always 0 (full clip available) and
 * **every emitted segment's span is ≤ its clip's duration**. A bucket longer than
 * its clip (rare: a single caption longer than the clip) is SPLIT across
 * consecutive pool clips rather than stretched into a freeze.
 *
 * Bucket edges land on caption boundaries (keeps the team's "cut on subtitle edge"
 * intent). Returns `null` when minHoldSec<=0 so the caller keeps the legacy
 * 1-clip-per-caption path — i.e. this is a no-op until STOCK_MIN_HOLD_SEC is set.
 */
export function buildMinHoldSegments(
  captions: MinHoldCaption[],
  pool: MinHoldPoolClip[],
  minHoldSec: number,
): BrollVideo[] | null {
  if (!(minHoldSec > 0)) return null; // env gate → caller uses legacy path
  const caps = (captions ?? []).filter((c) => c && c.endSec - c.startSec >= 0.1);
  const clips = (pool ?? []).filter((c) => c && c.src);
  if (caps.length === 0 || clips.length === 0) return [];

  const clipDurAt = (idx: number): number => {
    const d = clips[idx % clips.length].duration;
    return d && d > 0 ? d : 10;
  };

  const segments: BrollVideo[] = [];
  let poolIdx = 0;
  let i = 0;
  while (i < caps.length) {
    const bucketStart = caps[i].startSec;
    let bucketEnd = caps[i].endSec;
    let j = i + 1;
    // Grow the bucket across captions until it reaches minHold OR adding the next
    // caption would push the span past THIS clip's duration (freeze guard).
    while (
      j < caps.length &&
      bucketEnd - bucketStart < minHoldSec &&
      caps[j].endSec - bucketStart <= clipDurAt(poolIdx)
    ) {
      bucketEnd = caps[j].endSec;
      j++;
    }
    // Emit the bucket. The span is normally ≤ clipDur (guard above), so this is
    // one segment. If a single caption is itself longer than the clip, the span
    // is sliced across consecutive clips so no segment ever outlives its clip.
    let segStart = bucketStart;
    while (segStart < bucketEnd - 1e-6) {
      const dur = clipDurAt(poolIdx);
      const segEnd = Math.min(bucketEnd, segStart + dur);
      segments.push({
        src: clips[poolIdx % clips.length].src,
        start: segStart,
        end: segEnd,
        clipOffset: 0, // always play from clip start → full clip available, never freezes
        clipDuration: dur,
      });
      poolIdx++;
      segStart = segEnd;
    }
    i = j;
  }
  return segments;
}
