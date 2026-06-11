"use client";

import { useSyncExternalStore } from "react";

/**
 * External playback-time store — the ONLY thing that changes 60×/sec during
 * video playback. Plain emitter, no dependencies, module-level singleton
 * (one editor instance per page).
 *
 * Why: currentMs used to be React state at the root of the 4,000-line
 * /video-editor page; the rAF loop calling setCurrentMs every frame
 * re-rendered the entire tree (design spec 2026-06-10 §5 PR-3). Now the rAF
 * loop writes here, and only the few leaf components that truly need 60fps
 * subscribe (TimeLabel, PlayheadIndicator, ActiveCaptionOverlay, ScrubberBar).
 *
 * Unit: VIDEO milliseconds (video.currentTime * 1000) — same unit the old
 * currentMs state used. Caption-time mapping happens at the consumer, exactly
 * like the old videoMsToCaptionMs(currentMs).
 */
type Listener = () => void;

let currentMs = 0;
const listeners = new Set<Listener>();

export const playbackTime = {
  getMs(): number {
    return currentMs;
  },
  setMs(ms: number): void {
    if (ms === currentMs) return;
    currentMs = ms;
    for (const l of listeners) l();
  },
  subscribe(cb: Listener): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },
};

/**
 * 60fps playback position as a React value. ONLY use this in small leaf
 * components — every subscriber re-renders every frame during playback.
 * For one-shot reads in event handlers use playbackTime.getMs() instead.
 */
export function usePlaybackMsDisplay(): number {
  return useSyncExternalStore(playbackTime.subscribe, playbackTime.getMs, () => 0);
}
