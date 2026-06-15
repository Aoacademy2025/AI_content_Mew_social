"use client";

import { memo, useEffect, useRef } from "react";
import { playbackTime } from "../_lib/playback-time";

// Video-time → caption-time mapping — same formula as page.tsx
// videoMsToCaptionMs. The timeline runs in caption-time; the <video> element
// (burned output, avatar bookends) can be slightly longer.
function toCaptionMs(videoMs: number, durationMs: number, captionEndMs: number): number {
  return durationMs > 0 && captionEndMs > 0 ? videoMs * (captionEndMs / durationMs) : videoMs;
}

interface PlayheadProps {
  totalMs: number;
  durationMs: number;
  captionEndMs: number;
}

/**
 * Timeline playhead. Subscribes to the playbackTime store and writes
 * style.left directly via a ref — ZERO React re-renders during playback.
 */
export const PlayheadIndicator = memo(function PlayheadIndicator({ totalMs, durationMs, captionEndMs }: PlayheadProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const apply = () => {
      const el = ref.current;
      if (!el) return;
      const playheadMs = toCaptionMs(playbackTime.getMs(), durationMs, captionEndMs);
      el.style.left = totalMs > 0 ? `${(playheadMs / totalMs) * 100}%` : "0%";
    };
    apply();
    return playbackTime.subscribe(apply);
  }, [totalMs, durationMs, captionEndMs]);

  return (
    <div ref={ref} className="absolute top-0 bottom-0 w-[1.5px] bg-violet-500 pointer-events-none z-10"
      style={{ left: "0%" }}>
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-violet-500 shadow-[0_0_6px_rgba(124,58,237,0.8)]" />
    </div>
  );
});

/**
 * Thin progress strip under the phone-frame video. Same store + ref pattern,
 * but writes style.width. (Fourth 60fps visual found in the audit — without
 * this it would freeze between coarse state updates.)
 */
export const PlaybackProgressStrip = memo(function PlaybackProgressStrip({ totalMs, durationMs, captionEndMs }: PlayheadProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const apply = () => {
      const el = ref.current;
      if (!el) return;
      const playheadMs = toCaptionMs(playbackTime.getMs(), durationMs, captionEndMs);
      el.style.width = totalMs > 0 ? `${(playheadMs / totalMs) * 100}%` : "0%";
    };
    apply();
    return playbackTime.subscribe(apply);
  }, [totalMs, durationMs, captionEndMs]);

  return <div ref={ref} className="h-full bg-violet-500 transition-none" style={{ width: "0%" }} />;
});

interface SegmentProgressBarProps {
  startMs: number;
  endMs: number;
  durationMs: number;
  captionEndMs: number;
}

/**
 * Per-segment progress fill in the Transcript panel — same store + ref
 * pattern as PlayheadIndicator. Hides itself (width 0, opacity 0) once
 * playback leaves [startMs, endMs).
 */
export const SegmentProgressBar = memo(function SegmentProgressBar({ startMs, endMs, durationMs, captionEndMs }: SegmentProgressBarProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const apply = () => {
      const wrap = wrapRef.current;
      const fill = fillRef.current;
      if (!wrap || !fill) return;
      const playheadMs = toCaptionMs(playbackTime.getMs(), durationMs, captionEndMs);
      const within = playheadMs >= startMs && playheadMs < endMs;
      wrap.style.opacity = within ? "1" : "0";
      fill.style.width = `${((playheadMs - startMs) / Math.max(1, endMs - startMs)) * 100}%`;
    };
    apply();
    return playbackTime.subscribe(apply);
  }, [startMs, endMs, durationMs, captionEndMs]);

  return (
    <div ref={wrapRef} className="absolute bottom-0 left-0 right-0 h-[2px] bg-violet-500/15 pointer-events-none" style={{ opacity: 0 }}>
      <div ref={fillRef} className="h-full bg-gradient-to-r from-violet-400 to-violet-300" style={{ width: "0%" }} />
    </div>
  );
});
