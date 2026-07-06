/**
 * Editor v2 Post-phase timeline — b-roll lane spans derived from the real render config.
 *
 * The v2 preview config stores b-roll as `config.bgVideos[]` (seconds, see
 * `BrollVideo` in `src/remotion/types.ts`) — there is no `scenes[]` field. This lib
 * converts that into per-window spans (ms) for the timeline lane.
 *
 * Pure + client-safe: no imports beyond types, so it's safe to use from the
 * client-component TimelinePanel.
 */

export type BrollWindowSpan = {
  index: number;
  startMs: number;
  endMs: number;
  label: string;
  src: string;
};

interface RawBgVideo {
  src?: unknown;
  start?: unknown;
  end?: unknown;
  keyword?: unknown;
}

/**
 * Reads `config.bgVideos[]` and returns one span per entry (sorted by start,
 * ms-clamped to `[0, durMs]`, zero-width spans dropped). `index` is the entry's
 * original position in `bgVideos[]` (so a later editing UI can map a span back to
 * the config entry it came from, regardless of the sorted display order).
 *
 * Missing/empty/invalid `bgVideos` (including non-array garbage) -> `[]`, so
 * callers fall back to today's single "บีโรลอัตโนมัติ" block. Never throws.
 */
export function brollWindowSpans(
  config: Record<string, unknown> | null | undefined,
  durMs: number,
): BrollWindowSpan[] {
  try {
    if (!config || typeof config !== "object" || Array.isArray(config)) return [];
    const bgVideos = (config as { bgVideos?: unknown }).bgVideos;
    if (!Array.isArray(bgVideos) || bgVideos.length === 0) return [];
    const safeDurMs = Math.max(0, Number(durMs) || 0);

    const spans: BrollWindowSpan[] = [];
    bgVideos.forEach((raw: RawBgVideo, index: number) => {
      if (!raw || typeof raw !== "object") return;
      const startSec = Number(raw.start);
      const endSec = Number(raw.end);
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return;
      const startMs = Math.min(safeDurMs, Math.max(0, startSec * 1000));
      const endMs = Math.min(safeDurMs, Math.max(0, endSec * 1000));
      if (endMs <= startMs) return; // zero/negative-width after clamp
      const src = typeof raw.src === "string" ? raw.src : "";
      const keyword = typeof raw.keyword === "string" && raw.keyword ? raw.keyword : null;
      spans.push({ index, startMs, endMs, label: keyword ?? `คลิป ${index + 1}`, src });
    });

    spans.sort((a, b) => a.startMs - b.startMs);
    return spans;
  } catch {
    return [];
  }
}
