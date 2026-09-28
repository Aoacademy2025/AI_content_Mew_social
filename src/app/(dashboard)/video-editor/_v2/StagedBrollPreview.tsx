"use client";

import { useEffect, useRef } from "react";
import {
  stagedBrollOverlayAt,
  type StagedBrollEdit,
  type StagedBrollSpan,
} from "@/lib/staged-broll-preview";

/** Visual-only preview of a staged B-roll file. The base video keeps the audio. */
export function StagedBrollPreview({
  timeMs,
  playing,
  spans,
  edits,
}: {
  timeMs: number;
  playing: boolean;
  spans: readonly StagedBrollSpan[];
  edits: ReadonlyMap<number, StagedBrollEdit>;
}) {
  const overlay = stagedBrollOverlayAt(timeMs, spans, edits);
  const src = overlay?.src ?? null;
  const offsetSec = overlay?.offsetSec ?? 0;
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || !src) return;
    if (Math.abs(element.currentTime - offsetSec) > 0.35) {
      element.currentTime = offsetSec;
    }
    if (playing) void element.play().catch(() => {});
    else element.pause();
  }, [src, offsetSec, playing]);

  if (!overlay) return null;
  return (
    <video
      key={overlay.src}
      ref={ref}
      src={overlay.src}
      muted
      playsInline
      data-staged-broll-preview="true"
      className="pointer-events-none absolute inset-0 h-full w-full object-cover"
    />
  );
}
