"use client";

import React, { memo } from "react";
import { renderSubEl } from "./subtitle-renderer";
import type { Caption, SubPreset, SubTextEffect } from "./types";
import { usePlaybackMsDisplay } from "../_lib/playback-time";

export interface ActiveCaptionOverlayProps {
  cap: Caption | null;
  playing: boolean;
  subPosition: number;
  subDragRef: React.RefObject<{ startY: number; startPos: number } | null>;
  onSubPointerDown: (e: React.PointerEvent) => void;
  onSubPointerMove: (e: React.PointerEvent) => void;
  onSubPointerUp: () => void;
  onOpenStyleTab: () => void;
  onOpenFontTab: () => void;
  onResetPosition: () => void;
  // video-time → caption-time mapping (same formula as page.tsx videoMsToCaptionMs)
  durationMs: number;
  captionEndMs: number;
  subColor: string;
  subAccentColor: string;
  subPreset: SubPreset;
  subEffect: SubTextEffect;
  subFontFamily: string;
  subFontSize: number;
  subFontWeight: number;
  previewScale: number;
}

/**
 * Live subtitle overlay on the phone frame — the ONLY component that
 * re-renders 60×/sec during playback (usePlaybackMsDisplay). It is a leaf:
 * each commit is just this small subtree, not the 4,000-line page.
 *
 * Markup + animation math copied 1:1 from page.tsx. The entrance approximation
 * must keep MATCHING AnimatedSubtitle (ShortVideoComposition) so preview ===
 * burned MP4 — do not "improve" the easing here.
 */
export const ActiveCaptionOverlay = memo(function ActiveCaptionOverlay({
  cap, playing, subPosition, subDragRef,
  onSubPointerDown, onSubPointerMove, onSubPointerUp,
  onOpenStyleTab, onOpenFontTab, onResetPosition,
  durationMs, captionEndMs,
  subColor, subAccentColor, subPreset, subEffect,
  subFontFamily, subFontSize, subFontWeight, previewScale,
}: ActiveCaptionOverlayProps) {
  const videoMs = usePlaybackMsDisplay();

  if (!cap) return null;
  const isDragging = !!subDragRef.current;

  const playheadMs = durationMs > 0 && captionEndMs > 0 ? videoMs * (captionEndMs / durationMs) : videoMs;

  const PREVIEW_FPS = 30;
  const capDurMs = Math.max(1, cap.endMs - cap.startMs);
  const capDurFrames = Math.max(1, Math.round((capDurMs / 1000) * PREVIEW_FPS));
  const elapsedMs = Math.max(0, Math.min(capDurMs, playheadMs - cap.startMs));
  // frame for the INNER text effects (glow-pulse/highlight/karaoke/
  // typewriter). -1 when paused = resting/fully-visible.
  const frame = playing ? Math.round((elapsedMs / 1000) * PREVIEW_FPS) : -1;

  // Container ENTRANCE animation — must MATCH AnimatedSubtitle
  // (ShortVideoComposition) so preview === burned MP4. We can't
  // call Remotion spring() here, so approximate it: same start/end
  // values and similar durations, with an ease that mimics the
  // spring's settle. Only animates while playing; when paused we
  // show the resting state (transform none, opacity 1).
  const f = playing ? Math.max(0, Math.round((elapsedMs / 1000) * PREVIEW_FPS)) : 9999;
  const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
  const easeBack = (t: number) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
  const prog = (dur: number) => Math.min(1, f / dur);
  const fadeIn = Math.min(1, f / 5);
  let tf = "", op = 1;
  if (subEffect === "pop")        { const t = easeOut(prog(12)); tf = `translateY(${6*(1-t)}px) scale(${0.76+0.24*t})`; }
  else if (subEffect === "bounce"){ const t = easeBack(prog(18)); tf = `translateY(${14*(1-Math.min(1,t))}px) scale(${0.5+0.5*t})`; }
  else if (subEffect === "quick") { const t = easeOut(prog(6));  tf = `translateY(${8*(1-t)}px) scale(${0.6+0.4*t})`; }
  else if (subEffect === "fade")  { op = Math.min(1, f/8); }
  else if (subEffect === "slide") { const t = easeOut(prog(16)); tf = `translateY(${40*(1-t)}px)`; op = fadeIn; }
  else if (subEffect === "flip")  { const t = easeOut(prog(14)); tf = `perspective(600px) rotateX(${90*(1-t)}deg)`; op = Math.min(1, f/6); }

  return (
    <div
      className="absolute z-20 group"
      style={{
        top: `${subPosition}%`,
        left: "4%",
        right: "4%",
        transform: "translateY(-50%)",
        cursor: isDragging ? "grabbing" : "grab",
      }}
      onPointerDown={onSubPointerDown}
      onPointerMove={onSubPointerMove}
      onPointerUp={onSubPointerUp}
      onPointerCancel={onSubPointerUp}
    >
      {/* Hover border */}
      <div className="absolute -inset-x-2 -inset-y-1 rounded pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ border: "1px dashed rgba(124,58,237,0.55)" }} />

      {/* Quick actions — float ABOVE the subtitle text */}
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1 pointer-events-auto whitespace-nowrap">
        <span className="text-[9px] text-violet-400 bg-black/70 rounded px-1.5 py-0.5">↕{subPosition}%</span>
        <button onClick={e => { e.stopPropagation(); onOpenStyleTab(); }}
          className="px-1.5 py-0.5 bg-violet-600 rounded text-[9px] text-white font-bold hover:bg-violet-500">Style</button>
        <button onClick={e => { e.stopPropagation(); onOpenFontTab(); }}
          className="px-1.5 py-0.5 bg-[#1e1e28] border border-[#3a3a4a] rounded text-[9px] text-slate-300 hover:bg-[#2a2a36]">Font</button>
        <button onClick={e => { e.stopPropagation(); onResetPosition(); }}
          className="px-1.5 py-0.5 bg-[#1e1e28] border border-[#3a3a4a] rounded text-[9px] text-slate-400 hover:bg-[#2a2a36]">↺</button>
      </div>

      {/* Subtitle text — matches Remotion render exactly.
          data-subtitle-text lets the :fullscreen CSS upscale the font
          when the phone-frame is fullscreened, so the subtitle stays
          legible at viewport-width sizes. */}
      <div data-subtitle-text style={{ width: "100%", textAlign: "center" }} onClick={e => { e.stopPropagation(); onOpenFontTab(); }}>
        <div style={{ transform: tf || undefined, opacity: op, transformOrigin: subEffect === "flip" ? "center top" : "center" }}>
          {renderSubEl(cap.text, subColor, subAccentColor, cap.tag === "hook", subPreset, subFontFamily, subFontSize, subFontWeight, previewScale, subEffect, frame, capDurFrames)}
        </div>
      </div>
    </div>
  );
});
