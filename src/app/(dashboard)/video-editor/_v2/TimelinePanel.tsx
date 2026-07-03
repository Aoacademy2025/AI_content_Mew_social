"use client";

/**
 * Timeline 4 แทร็ก (จอ 4b ล่าง, P6b) — decision #5:
 *   ซับ = แก้ได้จริง (ลากขอบ + snap + undo ผ่าน onCaptionsChange) ·
 *   อวตาร/บีโรล/เพลง = แสดงผล + คลิก jump เท่านั้น
 * สีแทร็กคงที่ตาม Design System: อวตารม่วง · บีโรลฟ้า · ซับเหลือง · เพลงชมพู
 */

import { useMemo, useRef, useState } from "react";
import { Play, Pause, Magnet, ZoomIn, ZoomOut, Undo2 } from "lucide-react";
import { color, font } from "./tokens";
import type { V2Caption } from "./subtitle-style";

const TRACK_H = 26;
const LABEL_W = 92;
const MIN_CARD_MS = 300;
const SNAP_MS = 120;

interface Span { startMs: number; endMs: number; label: string }

function fmt(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** ดึงช่วงบีโรลจาก render config (fail-open → บล็อกเดียวเต็มคลิป) */
function brollSpansFromConfig(config: Record<string, unknown> | null | undefined, durMs: number, fps = 30): Span[] {
  try {
    const scenes = (config as { scenes?: { durationInFrames?: number; keyword?: string }[] } | null)?.scenes;
    if (Array.isArray(scenes) && scenes.length > 0) {
      let cursor = 0;
      return scenes.map((sc, i) => {
        const d = Math.max(1, Number(sc?.durationInFrames) || fps) / fps * 1000;
        const span = { startMs: cursor, endMs: Math.min(durMs, cursor + d), label: sc?.keyword || `คลิป ${i + 1}` };
        cursor += d;
        return span;
      }).filter((s) => s.startMs < durMs);
    }
  } catch { /* fall through */ }
  return [{ startMs: 0, endMs: durMs, label: "บีโรลอัตโนมัติ" }];
}

export function TimelinePanel({
  captions, onCaptionsChange, onUndo, canUndo,
  selected, onSelect,
  videoRef, timeMs, durationMs,
  config, hasAvatar, avatarIntroMs,
}: {
  captions: V2Caption[];
  onCaptionsChange: (next: V2Caption[], commit: boolean) => void;
  onUndo: () => void;
  canUndo: boolean;
  selected: number;
  onSelect: (i: number) => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  timeMs: number;
  durationMs: number;
  config: Record<string, unknown> | null;
  hasAvatar: boolean;
  avatarIntroMs: number;
}) {
  const [pxPerSec, setPxPerSec] = useState(24);
  const [snap, setSnap] = useState(true);
  const [playing, setPlaying] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ idx: number; edge: "l" | "r"; startX: number; origStart: number; origEnd: number } | null>(null);
  const scrubbingRef = useRef(false);

  const durMs = Math.max(durationMs, 1000);
  const widthPx = (durMs / 1000) * pxPerSec;
  const toPx = (ms: number) => (ms / 1000) * pxPerSec;
  const bgmFile = (config as { bgmFile?: string } | null)?.bgmFile;
  const brollSpans = useMemo(() => brollSpansFromConfig(config, durMs), [config, durMs]);

  function seekTo(ms: number) {
    const v = videoRef.current;
    if (v) v.currentTime = Math.max(0, Math.min(durMs, ms)) / 1000;
  }

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { void v.play(); setPlaying(true); } else { v.pause(); setPlaying(false); }
  }

  /** จุด snap: ขอบการ์ดข้างเคียง + วินาทีเต็ม */
  function snapMs(raw: number, idx: number): number {
    if (!snap) return raw;
    const points: number[] = [0, durMs];
    captions.forEach((c, i) => { if (i !== idx) { points.push(c.startMs, c.endMs); } });
    for (let s = 0; s <= durMs; s += 1000) points.push(s);
    let best = raw;
    let bestDist = SNAP_MS + 1;
    for (const p of points) {
      const d = Math.abs(p - raw);
      if (d < bestDist) { best = p; bestDist = d; }
    }
    return bestDist <= SNAP_MS ? best : raw;
  }

  function onEdgeDown(e: React.PointerEvent, idx: number, edge: "l" | "r") {
    e.preventDefault();
    e.stopPropagation();
    const c = captions[idx];
    dragRef.current = { idx, edge, startX: e.clientX, origStart: c.startMs, origEnd: c.endMs };
    onSelect(idx);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onEdgeMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const deltaMs = ((e.clientX - d.startX) / pxPerSec) * 1000;
    const next = captions.map((c) => ({ ...c }));
    const cap = next[d.idx];
    const prevEnd = d.idx > 0 ? next[d.idx - 1].endMs : 0;
    const nextStart = d.idx < next.length - 1 ? next[d.idx + 1].startMs : durMs;
    if (d.edge === "l") {
      cap.startMs = Math.round(Math.min(cap.endMs - MIN_CARD_MS, Math.max(prevEnd, snapMs(d.origStart + deltaMs, d.idx))));
    } else {
      cap.endMs = Math.round(Math.max(cap.startMs + MIN_CARD_MS, Math.min(nextStart, snapMs(d.origEnd + deltaMs, d.idx))));
    }
    onCaptionsChange(next, false);
  }

  function onEdgeUp() {
    if (!dragRef.current) return;
    dragRef.current = null;
    onCaptionsChange(captions.map((c) => ({ ...c })), true); // commit → push history
  }

  const trackLabel = (label: string, c: string) => (
    <div className="flex shrink-0 items-center gap-1.5 pl-2" style={{ width: LABEL_W, fontSize: 10, color: color.textSecondary }}>
      <span className="h-[7px] w-[7px] rounded-full" style={{ background: c }} />
      {label}
    </div>
  );

  const clipStyle = (c: string, isSelected = false): React.CSSProperties => ({
    position: "absolute", top: 3, bottom: 3, borderRadius: 6,
    background: isSelected ? "rgba(139,92,246,.14)" : `${c}26`,
    border: `1px solid ${isSelected ? "rgba(167,139,250,.65)" : `${c}59`}`,
    color: isSelected ? color.primary300 : `${c}E6`,
    fontSize: 9.5, lineHeight: `${TRACK_H - 8}px`, padding: "0 6px",
    overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis",
    cursor: "pointer", userSelect: "none",
  });

  return (
    <div className="flex shrink-0 flex-col" style={{ height: 192, background: color.bgTimeline, borderTop: `1px solid ${color.cardBorder}` }}>
      {/* Transport 38px */}
      <div className="flex h-[38px] shrink-0 items-center gap-3 px-3" style={{ borderBottom: `1px solid ${color.cardBorder}` }}>
        <button onClick={togglePlay} className="flex h-[24px] w-[24px] items-center justify-center rounded-full" style={{ background: "rgba(255,255,255,.07)", border: `1px solid ${color.cardBorder}`, color: color.text, cursor: "pointer" }} aria-label="เล่น/หยุด">
          {playing && !videoRef.current?.paused ? <Pause size={11} /> : <Play size={11} style={{ marginLeft: 1 }} />}
        </button>
        <span style={{ font: `500 11px ${font.heading}`, color: color.textSecondary, fontVariantNumeric: "tabular-nums" }}>
          {fmt(timeMs)} / {fmt(durMs)}
        </span>
        <span className="flex-1" />
        <button onClick={onUndo} disabled={!canUndo} title="เลิกทำ (แก้เวลาซับ)" className="flex items-center gap-1" style={{ background: "none", border: "none", color: canUndo ? color.textSecondary : color.textFaintest, cursor: canUndo ? "pointer" : "default", fontSize: 10.5 }}>
          <Undo2 size={12} /> เลิกทำ
        </button>
        <button onClick={() => setSnap(!snap)} title="Snap ขอบการ์ด/วินาที" className="flex items-center gap-1" style={{ background: "none", border: "none", color: snap ? color.primary300 : color.textFaintest, cursor: "pointer", fontSize: 10.5 }}>
          <Magnet size={12} /> Snap
        </button>
        <div className="flex items-center gap-1">
          <button onClick={() => setPxPerSec((z) => Math.max(10, z - 6))} style={{ background: "none", border: "none", color: color.textSecondary, cursor: "pointer" }} aria-label="ซูมออก"><ZoomOut size={13} /></button>
          <button onClick={() => setPxPerSec((z) => Math.min(60, z + 6))} style={{ background: "none", border: "none", color: color.textSecondary, cursor: "pointer" }} aria-label="ซูมเข้า"><ZoomIn size={13} /></button>
        </div>
      </div>

      {/* Tracks */}
      <div ref={scrollRef} className="flex-1 overflow-x-auto overflow-y-hidden">
        <div className="relative" style={{ width: widthPx + LABEL_W + 16, minWidth: "100%" }}>
          {/* ruler ลาก scrub ได้ (คลิก = jump, ลากค้าง = playhead วิ่งตาม) */}
          <div
            className="relative ml-[92px] h-[24px] cursor-pointer"
            style={{ touchAction: "none" }}
            onPointerDown={(e) => {
              scrubbingRef.current = true;
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              seekTo(((e.clientX - rect.left) / pxPerSec) * 1000);
            }}
            onPointerMove={(e) => {
              if (!scrubbingRef.current) return;
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              seekTo(((e.clientX - rect.left) / pxPerSec) * 1000);
            }}
            onPointerUp={(e) => {
              scrubbingRef.current = false;
              try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
            }}
            onPointerCancel={() => { scrubbingRef.current = false; }}
          >
            {Array.from({ length: Math.floor(durMs / 1000) + 1 }, (_, s) => s).filter((s) => s % (pxPerSec < 18 ? 5 : 1) === 0).map((s) => (
              <span key={s} className="absolute top-0 select-none" style={{ left: toPx(s * 1000), fontSize: 8, color: color.textFaintest }}>
                {fmt(s * 1000)}
              </span>
            ))}
          </div>

          {/* อวตาร */}
          {hasAvatar && (
            <div className="relative flex items-center" style={{ height: TRACK_H }}>
              {trackLabel("อวตาร", color.trackAvatar)}
              <div className="relative flex-1" style={{ height: TRACK_H }}>
                <div style={{ ...clipStyle(color.trackAvatar), left: 0, width: Math.max(24, toPx(avatarIntroMs)) }} onClick={() => seekTo(0)}>
                  พิธีกรเปิด {Math.round(avatarIntroMs / 1000)}s
                </div>
              </div>
            </div>
          )}

          {/* บีโรล */}
          <div className="relative flex items-center" style={{ height: TRACK_H }}>
            {trackLabel("บีโรล", color.trackBroll)}
            <div className="relative flex-1" style={{ height: TRACK_H }}>
              {brollSpans.map((s, i) => (
                <div key={i} style={{ ...clipStyle(color.trackBroll), left: toPx(s.startMs), width: Math.max(14, toPx(s.endMs - s.startMs) - 2) }} onClick={() => seekTo(s.startMs)} title={s.label}>
                  {s.label}
                </div>
              ))}
            </div>
          </div>

          {/* ซับไทย — แก้ได้ */}
          <div className="relative flex items-center" style={{ height: TRACK_H }}>
            {trackLabel("ซับไทย", color.trackSub)}
            <div className="relative flex-1" style={{ height: TRACK_H }} onPointerMove={onEdgeMove} onPointerUp={onEdgeUp}>
              {captions.map((c, i) => (
                <div
                  key={i}
                  style={{ ...clipStyle(color.trackSub, i === selected), left: toPx(c.startMs), width: Math.max(14, toPx(c.endMs - c.startMs) - 2) }}
                  onClick={() => { onSelect(i); seekTo(c.startMs + 10); }}
                  title={c.text}
                >
                  {/* ขอบลากซ้าย/ขวา */}
                  <span onPointerDown={(e) => onEdgeDown(e, i, "l")} className="absolute bottom-0 left-0 top-0 w-[6px] cursor-ew-resize" style={{ borderLeft: i === selected ? `2px solid ${color.primary300}` : undefined }} />
                  {c.text}
                  <span onPointerDown={(e) => onEdgeDown(e, i, "r")} className="absolute bottom-0 right-0 top-0 w-[6px] cursor-ew-resize" style={{ borderRight: i === selected ? `2px solid ${color.primary300}` : undefined }} />
                </div>
              ))}
            </div>
          </div>

          {/* เพลง */}
          {bgmFile && (
            <div className="relative flex items-center" style={{ height: TRACK_H }}>
              {trackLabel("เพลง", color.trackMusic)}
              <div className="relative flex-1" style={{ height: TRACK_H }}>
                <div style={{ ...clipStyle(color.trackMusic), left: 0, width: Math.max(24, toPx(durMs) - 2) }} onClick={() => seekTo(0)}>
                  ♪ ลดเสียงใต้เสียงพูดอัตโนมัติ
                </div>
              </div>
            </div>
          )}

          {/* Playhead */}
          <div className="pointer-events-none absolute bottom-0 top-[24px]" style={{ left: LABEL_W + toPx(timeMs) }}>
            <div className="h-full w-[1px]" style={{ background: "#fff" }} />
            <div style={{ position: "absolute", top: -1, left: -4, width: 9, height: 8, background: "#fff", clipPath: "polygon(0 0, 100% 0, 100% 55%, 50% 100%, 0 55%)" }} />
          </div>
        </div>
      </div>
    </div>
  );
}
