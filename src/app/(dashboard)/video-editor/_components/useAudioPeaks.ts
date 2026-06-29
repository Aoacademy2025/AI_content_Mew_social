import { useEffect, useState } from "react";
import { downsamplePeaks } from "./waveform-snap";

// Module-level cache keyed by voiceUrl so re-renders / re-opening a draft don't re-decode.
// Bounded LRU: a long editing session re-rolls TTS many times (a new voiceUrl each time),
// each entry holding a ~1400-float array — cap it so the map can't grow unbounded.
const PEAK_CACHE_MAX = 24;
const peakCache = new Map<string, { peaks: number[]; durationMs: number }>();

export function useAudioPeaks(voiceUrl: string | null | undefined, buckets = 1400) {
  const [data, setData] = useState<{ peaks: number[]; durationMs: number } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!voiceUrl) { setData(null); return; }
    const cached = peakCache.get(voiceUrl);
    if (cached) {
      // LRU touch: re-insert so a recently used waveform isn't the next evicted.
      peakCache.delete(voiceUrl);
      peakCache.set(voiceUrl, cached);
      setData(cached);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(voiceUrl);
        const buf = await res.arrayBuffer();
        const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AC();
        const audio = await ctx.decodeAudioData(buf);
        const peaks = downsamplePeaks(audio.getChannelData(0), buckets);
        const out = { peaks, durationMs: Math.round(audio.duration * 1000) };
        void ctx.close();
        if (peakCache.size >= PEAK_CACHE_MAX) {
          const oldest = peakCache.keys().next().value; // Map preserves insertion order
          if (oldest !== undefined) peakCache.delete(oldest);
        }
        peakCache.set(voiceUrl, out);
        if (!cancelled) setData(out);
      } catch {
        if (!cancelled) setData(null); // fail-safe: no waveform, plain drag still works
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [voiceUrl, buckets]);

  return { peaks: data?.peaks ?? null, durationMs: data?.durationMs ?? 0, loading };
}
