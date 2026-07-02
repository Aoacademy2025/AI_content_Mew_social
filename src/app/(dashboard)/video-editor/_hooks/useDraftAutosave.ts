"use client";

import { useEffect, useRef } from "react";

/**
 * Draft autosave mechanism — extracted from page.tsx (P1 behavior-preserving move).
 * Owns the 4s debounce + the latest-closure ref used by the once-registered
 * beforeunload handler. Draft SERIALIZATION (saveDraftNow) intentionally stays
 * with the page for now — it reads ~40 state values; moving it is a later P1 chunk.
 *
 * Autosave (Tier-1 resume): the draft already captures everything needed to resume
 * (render URLs, captions, style, pipeline cache) — it was just never saved unless the
 * user clicked "บันทึก draft". So accidentally leaving lost everything. We autosave a
 * draft (silently) ~4s after any meaningful change, and once more on unload, so
 * closing/refreshing no longer loses work. Only saves once there is real progress,
 * so we never spam empty drafts.
 */
export function useDraftAutosave(opts: {
  /** true when there is real progress worth saving (same gate as before extraction) */
  hasResumableProgress: () => boolean;
  /** silent draft save */
  save: () => void;
  /**
   * Re-arm triggers — pass the SAME dependency list the inline effect used
   * (steps, videoUrl, captions, style props…). Length must stay stable.
   */
  deps: readonly unknown[];
}) {
  const { hasResumableProgress, save } = opts;

  useEffect(() => {
    if (!hasResumableProgress()) return;
    const t = setTimeout(() => { try { save(); } catch {} }, 4000);
    return () => clearTimeout(t);
    // Re-armed on any meaningful editor change (caller-supplied deps). pipe.current
    // (a ref) isn't a dep, but every stage transition calls setStep → `steps` changes
    // → this re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, opts.deps);

  // Latest-closure ref so the once-registered beforeunload handler can run the
  // CURRENT autosave (a stale closure would persist mount-time empty state).
  const autosaveRef = useRef<() => void>(() => {});
  autosaveRef.current = () => { try { if (hasResumableProgress()) save(); } catch {} };

  return autosaveRef;
}
