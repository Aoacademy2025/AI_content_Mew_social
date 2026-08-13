"use client";

import React, { memo, useEffect, useRef, useState } from "react";
import { renderSubEl } from "../_components/subtitle-renderer";
import type { SubPreset, SubTextEffect } from "../_components/types";
import { resolveV2FontWeight, type V2Caption, type V2CardOverrides, type V2SubConfig } from "./subtitle-style";
import { subtitlePreviewEffectFrame } from "./subtitle-preview-frame";

/**
 * ซับสดบน preview ของ v2 — ใช้ `renderSubEl` ตัวเดียวกับ Remotion render
 * (สี preset/นีออน/กล่อง + เอฟเฟกต์ per-word ตรงกับไฟล์ที่ burn 100%) แทน
 * approximation เดิมที่ทำให้ "นีออนไม่เขียว/เอฟเฟกต์ไม่ขยับ" (QA 07-03).
 *
 * ENTRANCE animation math คัดลอก 1:1 จาก _components/ActiveCaptionOverlay.tsx:73-84
 * (ซึ่ง match AnimatedSubtitle ของ ShortVideoComposition) — แก้ที่โน่นต้องแก้ที่นี่ด้วย
 * ห้าม "ปรับ easing ให้สวยขึ้น" ฝั่งเดียว เดี๋ยว preview ≠ ไฟล์จริง
 *
 * ลากซับขึ้น/ลงบนจอได้เหมือน v1 (pointer drag → verticalPos %)
 */
export const V2CaptionOverlay = memo(function V2CaptionOverlay({
  captions, overrides, cfg, videoRef, playing, onVerticalPos, suppressUntilMs = 0,
}: {
  captions: V2Caption[];
  overrides: V2CardOverrides;
  cfg: V2SubConfig;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  playing: boolean;
  onVerticalPos: (pos: number) => void;
  /** Hide the visual overlay until this point without changing source caption timing. */
  suppressUntilMs?: number;
}) {
  // 60fps playback clock — leaf re-render เฉพาะคอมโพเนนต์นี้ (แบบเดียวกับ
  // usePlaybackMsDisplay ของ v1 แต่ผูกกับ videoRef ตรง ๆ ไม่ใช้ singleton ร่วม)
  const [videoMs, setVideoMs] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) setVideoMs(v.currentTime * 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoRef]);

  // scale ตามความกว้างจริงของกรอบ 9/16 (เฟรม render = 1080px)
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0.3);
  useEffect(() => {
    const el = rootRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / 1080 || 0.3));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ลากเลื่อนตำแหน่ง (พอร์ตจาก v1 page.tsx onSubPointerDown/Move/Up)
  const dragRef = useRef<{ startY: number; startPos: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startPos: cfg.verticalPos };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    const frame = rootRef.current?.parentElement;
    if (!d || !frame) return;
    const dpct = ((e.clientY - d.startY) / frame.clientHeight) * 100;
    onVerticalPos(Math.min(95, Math.max(10, Math.round(d.startPos + dpct))));
  }
  function onPointerUp() { dragRef.current = null; setDragging(false); }

  const activeIdx = videoMs < suppressUntilMs
    ? -1
    : captions.findIndex((c) => videoMs >= c.startMs && videoMs < c.endMs);
  const cap = activeIdx >= 0 ? captions[activeIdx] : null;
  if (!cap) return <div ref={rootRef} className="hidden" />;

  const PREVIEW_FPS = 30;
  const visibleStartMs = Math.max(cap.startMs, suppressUntilMs);
  const capDurMs = Math.max(1, cap.endMs - visibleStartMs);
  const capDurFrames = Math.max(1, Math.round((capDurMs / 1000) * PREVIEW_FPS));
  const elapsedMs = Math.max(0, Math.min(capDurMs, videoMs - visibleStartMs));
  // Keep frame-based text effects frozen at the playhead while paused so the
  // preview stays pixel-consistent with the frame that will be burned.
  const frame = subtitlePreviewEffectFrame({ elapsedMs, fps: PREVIEW_FPS });

  // ── ENTRANCE — คัดลอก 1:1 จาก ActiveCaptionOverlay.tsx:73-84 ──
  const f = playing ? Math.max(0, Math.round((elapsedMs / 1000) * PREVIEW_FPS)) : 9999;
  const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
  const easeBack = (t: number) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
  const prog = (dur: number) => Math.min(1, f / dur);
  const fadeIn = Math.min(1, f / 5);
  const effect: SubTextEffect = cfg.effect;
  let tf = "", op = 1;
  if (effect === "pop")        { const t = easeOut(prog(12)); tf = `translateY(${6 * (1 - t)}px) scale(${0.76 + 0.24 * t})`; }
  else if (effect === "bounce"){ const t = easeBack(prog(18)); tf = `translateY(${14 * (1 - Math.min(1, t))}px) scale(${0.5 + 0.5 * t})`; }
  else if (effect === "quick") { const t = easeOut(prog(6));  tf = `translateY(${8 * (1 - t)}px) scale(${0.6 + 0.4 * t})`; }
  else if (effect === "fade")  { op = Math.min(1, f / 8); }
  else if (effect === "slide") { const t = easeOut(prog(16)); tf = `translateY(${40 * (1 - t)}px)`; op = fadeIn; }
  else if (effect === "flip")  { const t = easeOut(prog(14)); tf = `perspective(600px) rotateX(${90 * (1 - t)}deg)`; op = Math.min(1, f / 6); }

  const ov = overrides[activeIdx] ?? {};
  const textColor = ov.textColor ?? cfg.textColor;
  const accentColor = ov.accentColor ?? cfg.accentColor;
  const isHook = cap.tag === "hook" && cfg.preset !== "karaoke-box";

  return (
    <div
      ref={rootRef}
      className="absolute z-20 group"
      style={{
        top: `${cfg.verticalPos}%`, left: "4%", right: "4%",
        transform: "translateY(-50%)",
        cursor: dragging ? "grabbing" : "grab",
        touchAction: "none",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="absolute -inset-x-2 -inset-y-1 rounded pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ border: "1px dashed rgba(139,92,246,.55)" }} />
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 pointer-events-none whitespace-nowrap rounded bg-black/70 px-1.5 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ fontSize: 9, color: "#a78bfa" }}>
        ↕ ลากปรับตำแหน่ง · {cfg.verticalPos}%
      </div>
      <div style={{ width: "100%", textAlign: "center" }}>
        <div style={{ transform: tf || undefined, opacity: op, transformOrigin: effect === "flip" ? "center top" : "center" }}>
          {renderSubEl(
            cap.text, textColor, accentColor, isHook,
            cfg.preset as SubPreset, cfg.fontFamily, cfg.fontSize, resolveV2FontWeight(cfg),
            scale, cfg.effect, frame, capDurFrames,
            cfg.shadow, cfg.outline, cfg.outlineSize,
          )}
        </div>
      </div>
    </div>
  );
});
