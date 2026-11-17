"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  isMotionBrollUri,
  normalizeMotionTemplateConfig,
  parseMotionTemplateIdFromUri,
} from "@/lib/motion-broll-catalog";
import { paintMotionBrollCanvas } from "@/remotion/MotionBrollScene";
import {
  stagedBrollOverlayAt,
  type StagedBrollEdit,
  type StagedBrollSpan,
} from "@/lib/staged-broll-preview";

/** Visual-only preview of a staged B-roll file or procedural Motion / HyperFrames scene. The base video keeps the audio. */
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
  const durationSec = overlay?.durationSec ?? 3;
  const isMotion = Boolean(src && isMotionBrollUri(src));
  const ref = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const motionConfig = useMemo(() => {
    if (!isMotion || !src) return null;
    if (overlay?.motionTemplate) return overlay.motionTemplate;
    const tid = parseMotionTemplateIdFromUri(src);
    return tid ? normalizeMotionTemplateConfig({ templateId: tid }) : null;
  }, [isMotion, overlay?.motionTemplate, src]);

  useEffect(() => {
    const element = ref.current;
    if (!element || !src || isMotion) return;
    if (Math.abs(element.currentTime - offsetSec) > 0.35) {
      element.currentTime = offsetSec;
    }
    if (playing) void element.play().catch(() => {});
    else element.pause();
  }, [src, offsetSec, playing, isMotion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !motionConfig) return;
    const progress = Math.max(0, Math.min(1, offsetSec / Math.max(0.2, durationSec)));
    paintMotionBrollCanvas(canvas, motionConfig, progress);
  }, [motionConfig, offsetSec, durationSec]);

  if (!overlay) return null;
  if (isMotion && motionConfig) {
    return (
      <canvas
        key={overlay.src}
        ref={canvasRef}
        width={540}
        height={960}
        data-staged-broll-preview="true"
        data-motion-template-id={motionConfig.templateId}
        className="pointer-events-none absolute inset-0 h-full w-full object-cover"
      />
    );
  }
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
