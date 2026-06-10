"use client";

import { memo, useEffect, useRef } from "react";
import { playbackTime } from "../_lib/playback-time";

interface TimeLabelProps {
  className: string;
  // When BOTH are > 0, display caption-time (videoMs × captionEndMs/durationMs)
  // — same formula as page.tsx videoMsToCaptionMs. Omit both for raw video-time.
  durationMs?: number;
  captionEndMs?: number;
}

// Same formatter as page.tsx fmtMs (duplicated here because page.tsx declares
// it inside the component body and still uses it for static labels).
function fmtMs(ms: number) {
  const s = Math.floor(ms / 1000); const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Playback time label. Subscribes to the playbackTime store and writes
 * textContent directly via a ref — ZERO React re-renders during playback.
 */
export const TimeLabel = memo(function TimeLabel({ className, durationMs = 0, captionEndMs = 0 }: TimeLabelProps) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let lastText = "";
    const apply = () => {
      const el = ref.current;
      if (!el) return;
      const videoMs = playbackTime.getMs();
      const displayMs = durationMs > 0 && captionEndMs > 0 ? videoMs * (captionEndMs / durationMs) : videoMs;
      const text = fmtMs(displayMs);
      if (text !== lastText) { lastText = text; el.textContent = text; }
    };
    apply();
    return playbackTime.subscribe(apply);
  }, [durationMs, captionEndMs]);

  return <span ref={ref} className={className}>0:00</span>;
});
