import type { BrollVideo } from "@/remotion/types";

type EvenSplitStock = {
  localUrl?: string;
  videoUrl?: string;
  duration?: number;
  keyword?: string;
  title?: string;
  query?: string;
  provider?: "pexels" | "pixabay";
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
