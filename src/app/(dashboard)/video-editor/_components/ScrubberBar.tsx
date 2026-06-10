"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { playbackTime, usePlaybackMsDisplay } from "../_lib/playback-time";

interface ScrubberBarProps {
  totalMs: number;
  durationMs: number;
  isScrubbing: boolean;
  setIsScrubbing: (v: boolean) => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  setCurrentMs: (v: number) => void;
  fmtMs: (ms: number) => string;
}

export function ScrubberBar({
  totalMs, durationMs, isScrubbing,
  setIsScrubbing, videoRef, setCurrentMs, fmtMs,
}: ScrubberBarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hoverPct, setHoverPct] = useState<number | null>(null);
  // 60fps position from the playbackTime store. This component is a small
  // leaf, so re-rendering it per frame is cheap (it used to receive currentMs
  // as a prop, which forced the whole page to re-render to move this bar).
  const currentMs = usePlaybackMsDisplay();

  const seekToClientX = (clientX: number) => {
    const track = trackRef.current;
    if (!track || !videoRef.current) return;
    const r = track.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const dur = videoRef.current.duration || (durationMs / 1000);
    videoRef.current.currentTime = pct * dur;
    playbackTime.setMs(pct * dur * 1000); // instant visual feedback while dragging
    setCurrentMs(pct * dur * 1000);
  };

  const updateHover = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return;
    const r = track.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    setHoverPct(pct);
  };

  const hoverMs = hoverPct !== null ? hoverPct * totalMs : 0;

  return (
    <div
      ref={trackRef}
      className="flex-1 relative py-3 cursor-pointer group"
      onPointerDown={e => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setIsScrubbing(true);
        seekToClientX(e.clientX);
      }}
      onPointerMove={e => {
        updateHover(e.clientX);
        if (e.buttons === 1) seekToClientX(e.clientX);
      }}
      onPointerEnter={e => updateHover(e.clientX)}
      onPointerLeave={() => setHoverPct(null)}
      onPointerUp={() => setIsScrubbing(false)}
      onPointerCancel={() => setIsScrubbing(false)}
    >
      <div
        className={cn(
          "absolute top-1/2 left-0 right-0 -translate-y-1/2 rounded overflow-hidden transition-all",
          isScrubbing ? "h-2" : "h-1 group-hover:h-1.5",
        )}
        style={{ background: "#2a2a36" }}
      >
        {/* Hover ghost — shows where you'd seek to */}
        {hoverPct !== null && !isScrubbing && (
          <div
            className="absolute top-0 left-0 h-full bg-violet-500/30 rounded pointer-events-none"
            style={{ width: `${hoverPct * 100}%` }}
          />
        )}
        {/* Played progress */}
        <div
          className="h-full bg-violet-500 rounded relative z-10"
          style={{ width: totalMs > 0 ? `${(currentMs / totalMs) * 100}%` : "0%" }}
        />
      </div>

      {/* Thumb on current position */}
      <div
        className={cn(
          "absolute top-1/2 -translate-y-1/2 -translate-x-1/2 rounded-full bg-white border-2 border-violet-500 shadow-[0_0_6px_rgba(124,58,237,0.6)] transition-all pointer-events-none",
          isScrubbing ? "w-4 h-4 opacity-100" : "w-3 h-3 opacity-0 group-hover:opacity-100",
        )}
        style={{ left: totalMs > 0 ? `${(currentMs / totalMs) * 100}%` : "0%" }}
      />

      {/* Hover time tooltip */}
      {hoverPct !== null && totalMs > 0 && (
        <div
          className="absolute -top-1 -translate-y-full -translate-x-1/2 bg-[#0e0e13] border border-[#2a2a36] rounded px-1.5 py-0.5 text-[10px] font-mono text-slate-300 tabular-nums pointer-events-none whitespace-nowrap shadow-lg z-20"
          style={{ left: `${hoverPct * 100}%` }}
        >
          {fmtMs(hoverMs)}
        </div>
      )}
    </div>
  );
}
