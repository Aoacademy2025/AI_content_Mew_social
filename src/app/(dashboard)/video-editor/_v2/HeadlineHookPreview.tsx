"use client";

import React, { memo, useEffect, useRef, useState } from "react";
import {
  headlineHookEndMs,
  isHeadlineHookActive,
  type HeadlineHookConfig,
} from "@/lib/headline-hook";
import { HeadlineHookView, headlineHookMotionAt } from "@/remotion/HeadlineHookView";

export const HeadlineHookPreview = memo(function HeadlineHookPreview({
  hook,
  totalDurationMs,
  videoRef,
  playing,
  onTopPercent,
}: {
  hook: HeadlineHookConfig;
  totalDurationMs: number;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  playing: boolean;
  onTopPercent: (value: number) => void;
}) {
  const [videoMs, setVideoMs] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [frameScale, setFrameScale] = useState(0.3);
  const dragRef = useRef<{ startY: number; startPos: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const video = videoRef.current;
      if (video) setVideoMs(video.currentTime * 1_000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoRef]);

  useEffect(() => {
    const frame = rootRef.current?.parentElement;
    if (!frame) return;
    const observer = new ResizeObserver(() => setFrameScale(frame.clientWidth / 1080 || 0.3));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  function onPointerDown(event: React.PointerEvent) {
    event.preventDefault();
    dragRef.current = { startY: event.clientY, startPos: hook.topPercent };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }

  function onPointerMove(event: React.PointerEvent) {
    const drag = dragRef.current;
    const frame = rootRef.current?.parentElement;
    if (!drag || !frame) return;
    const deltaPercent = ((event.clientY - drag.startY) / frame.clientHeight) * 100;
    onTopPercent(Math.min(42, Math.max(10, Math.round(drag.startPos + deltaPercent))));
  }

  function onPointerUp() {
    dragRef.current = null;
    setDragging(false);
  }

  if (!isHeadlineHookActive(hook, videoMs, totalDurationMs)) {
    return <div ref={rootRef} className="hidden" />;
  }

  const durationMs = headlineHookEndMs(hook, totalDurationMs);
  const elapsedMs = Math.max(0, Math.min(durationMs, videoMs));
  const previewElapsedMs = !playing && elapsedMs < 240 ? 240 : elapsedMs;
  const motion = headlineHookMotionAt(previewElapsedMs, durationMs);

  return (
    <div
      ref={rootRef}
      data-headline-hook-preview="true"
      className="group absolute z-20"
      style={{
        top: `${hook.topPercent}%`,
        left: "6%",
        right: "6%",
        transform: "translateY(-50%)",
        cursor: dragging ? "grabbing" : "grab",
        touchAction: "none",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className="pointer-events-none absolute opacity-0 transition-opacity group-hover:opacity-100"
        style={{ inset: -8, border: "1px dashed rgba(249,115,22,.72)", borderRadius: 9 }}
      />
      <div
        className="pointer-events-none absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap opacity-0 transition-opacity group-hover:opacity-100"
        style={{ padding: "2px 7px", borderRadius: 6, background: "rgba(8,8,13,.82)", color: "#FDBA74", fontSize: 9 }}
      >
        ↕ ลากพาดหัว · {hook.topPercent}%
      </div>
      <HeadlineHookView hook={hook} frameScale={frameScale} motion={motion} />
    </div>
  );
});
