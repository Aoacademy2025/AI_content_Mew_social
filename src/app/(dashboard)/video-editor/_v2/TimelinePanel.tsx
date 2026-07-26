"use client";

/**
 * Timeline 4 แทร็กหลัก + waveform เสียงพูดสำหรับอ้างอิง (จอ 4b ล่าง, P6b) — decision #5:
 *   ซับ = แก้ได้จริง (ลากขอบ + snap + undo ผ่าน onCaptionsChange) ·
 *   อวตาร/บีโรล/เพลง = แสดงผล + คลิก jump เท่านั้น
 * สีแทร็กคงที่ตาม Design System: อวตารม่วง · บีโรลฟ้า · ซับเหลือง · เพลงชมพู
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Pause, Magnet, Redo2, ZoomIn, ZoomOut, Undo2 } from "lucide-react";
import { color, font } from "./tokens";
import type { V2Caption } from "./subtitle-style";
import { useAudioPeaks } from "../_components/useAudioPeaks";
import { WaveformCanvas } from "../_components/WaveformCanvas";
import { snapPointsFromPeaks, snapToNearest } from "../_components/waveform-snap";
import { brollWindowSpans, type BrollWindowSpan } from "@/lib/broll-spans";
import { AVATAR_FADE_DURATION_SEC } from "@/lib/avatar-fade";
import { nextTimelineScrollLeft } from "./timeline-wheel-scroll";

const TRACK_H = 26;
const LABEL_W = 92;
const MIN_CARD_MS = 300;
const SNAP_MS = 120;

function fmt(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** ดึงช่วงบีโรลจาก render config: ลอง bgVideos จริงก่อน (brollWindowSpans) —
 * ว่าง (งานเก่า/ไม่มี field) ถึง fail-open กลับไปบล็อกเดียวเต็มคลิปแบบเดิม */
function brollSpansFromConfig(config: Record<string, unknown> | null | undefined, durMs: number): BrollWindowSpan[] {
  const real = brollWindowSpans(config, durMs);
  if (real.length > 0) return real;
  return [{ index: 0, startMs: 0, endMs: durMs, label: "บีโรลอัตโนมัติ", src: "" }];
}

export function TimelinePanel({
  captions, onCaptionsChange, onUndo, onRedo, canUndo, canRedo,
  selected, onSelect,
  videoRef, timeMs, durationMs, onScrub,
  config, hasAvatar, avatarMode, avatarIntroMs, avatarTailMs, avatarFadeApplies,
  voiceUrl, onSelectBrollWindow, editedWindowIndices, disabledWindowIndices,
}: {
  captions: V2Caption[];
  onCaptionsChange: (next: V2Caption[], commit: boolean) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  selected: number;
  onSelect: (i: number) => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  timeMs: number;
  durationMs: number;
  /** optimistic seek: playhead/ซับตาม pointer ทันที ไม่รอ timeupdate (~4Hz) ของ <video> */
  onScrub?: (ms: number) => void;
  config: Record<string, unknown> | null;
  hasAvatar: boolean;
  avatarMode: string | null;
  avatarIntroMs: number;
  avatarTailMs: number;
  /** M10: avatar fade เกิดจริงเฉพาะโหมด full/bookend/bookend-both (composite route ผ่าน
   *  avatarSourceFadeWindows) — upload-cutaway ผ่าน cutawayComposite ที่ไม่รับ fade เลย
   *  (`@/lib/avatar-fade`'s `avatarFadeApplies`) → gradient/tooltip ต้องไม่โผล่ตอนนั้น */
  avatarFadeApplies: boolean;
  voiceUrl: string | null;
  /** เลือกหน้าต่างบีโรล (index ใน config.bgVideos[]) — parent เป็นผู้ตัดสิน feature access. */
  onSelectBrollWindow?: (index: number) => void;
  /** index (ใน config.bgVideos[]) ของหน้าต่างที่แก้ไว้ในเซสชันนี้แต่ยังไม่ apply — จุดม่วงบนคลิป (Task 11) */
  editedWindowIndices?: ReadonlySet<number>;
  /** B-roll windows that are currently disabled (includes optimistic staged visibility). */
  disabledWindowIndices?: ReadonlySet<number>;
}) {
  const [pxPerSec, setPxPerSec] = useState(24);
  const [snap, setSnap] = useState(true);
  const [playing, setPlaying] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ idx: number; edge: "l" | "r"; startX: number; origStart: number; origEnd: number } | null>(null);
  const scrubbingRef = useRef(false);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const onTimelineWheel = (event: WheelEvent) => {
      // ระหว่างลากขอบการ์ด/scrub playhead ห้าม scroll — onEdgeMove/scrub คำนวณจาก
      // clientX viewport-space, scroll เปลี่ยนตำแหน่งใต้เมาส์ระหว่างลากทำขอบซับเพี้ยน
      if (dragRef.current || scrubbingRef.current) return;
      const nextScrollLeft = nextTimelineScrollLeft({
        scrollLeft: scroller.scrollLeft,
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
      });
      if (nextScrollLeft == null) return;
      event.preventDefault();
      scroller.scrollLeft = nextScrollLeft;
    };
    // React 19 delegates wheel as passive; use a native non-passive listener so consuming
    // a Timeline gesture can stop the page from scrolling at the same time.
    scroller.addEventListener("wheel", onTimelineWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onTimelineWheel);
  }, []);

  const durMs = Math.max(durationMs, 1000);
  const widthPx = (durMs / 1000) * pxPerSec;
  const toPx = (ms: number) => (ms / 1000) * pxPerSec;
  const bgmFile = (config as { bgmFile?: string } | null)?.bgmFile;
  const brollSpans = useMemo(() => brollSpansFromConfig(config, durMs), [config, durMs]);

  // Waveform เสียงพากย์ (fail-open: โหลด/decode ไม่ได้ = ไม่มีเลน, snap ตกกลับแบบเดิม)
  const { peaks, durationMs: waveDurMs } = useAudioPeaks(voiceUrl);
  const waveMs = waveDurMs || durMs;
  const audioSnapPoints = useMemo(
    () => (peaks?.length ? snapPointsFromPeaks(peaks, waveMs / peaks.length) : []),
    [peaks, waveMs],
  );

  const pendingSeekRef = useRef<number | null>(null);

  function seekTo(ms: number) {
    const clamped = Math.max(0, Math.min(durMs, ms));
    onScrub?.(clamped); // playhead ตามทันที — <video> ค่อย seek ตาม
    const v = videoRef.current;
    if (!v) return;
    // ระหว่าง seek เดิมยังไม่จบ อย่ายิงซ้ำรัว ๆ (แต่ละ seek ของ H.264 กินเวลาได้เป็น
    // ร้อย ms) — เก็บเป้าไว้แล้วค่อย flush ตอน move ถัดไป/ปล่อยนิ้ว
    if (v.seeking) { pendingSeekRef.current = clamped; return; }
    pendingSeekRef.current = null;
    v.currentTime = clamped / 1000;
  }

  function flushPendingSeek() {
    const p = pendingSeekRef.current;
    const v = videoRef.current;
    if (p != null && v) { pendingSeekRef.current = null; v.currentTime = p / 1000; }
  }

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { void v.play(); setPlaying(true); } else { v.pause(); setPlaying(false); }
  }

  /** จุด snap: จุดเปลี่ยนเสียงพูด (ก่อน) > ขอบการ์ดข้างเคียง > วินาทีเต็ม */
  function snapMs(raw: number, idx: number): number {
    if (!snap) return raw;
    if (audioSnapPoints.length && audioSnapPoints.some((p) => Math.abs(p - raw) <= SNAP_MS)) {
      return snapToNearest(raw, audioSnapPoints, SNAP_MS);
    }
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
  // M10: gradient เป็น "สัญญา" ว่าคลิปนี้จะเฟด — ต้องโผล่เฉพาะโหมดที่ composite route ใส่
  // fade จริง (avatarFadeApplies เช็คจาก avatarModel ที่ parent ส่งมา). upload-cutaway ไม่มี
  // fade เลยแม้ hasAvatar=true → ต้องไม่เห็น gradient/tooltip นี้.
  const avatarFadeTitle = avatarFadeApplies ? "เฟดเข้า–ออกอัตโนมัติ" : undefined;
  const avatarFadeEdges = avatarFadeApplies ? (
    <>
      <span
        data-avatar-fade-edge="in"
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 left-0 top-0"
        style={{
          width: `min(${Math.max(6, toPx(AVATAR_FADE_DURATION_SEC * 1000))}px, 35%)`,
          background: `linear-gradient(90deg, ${color.bgTimeline} 0%, transparent 100%)`,
        }}
      />
      <span
        data-avatar-fade-edge="out"
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 right-0 top-0"
        style={{
          width: `min(${Math.max(6, toPx(AVATAR_FADE_DURATION_SEC * 1000))}px, 35%)`,
          background: `linear-gradient(270deg, ${color.bgTimeline} 0%, transparent 100%)`,
        }}
      />
    </>
  ) : null;

  return (
    <div className="flex shrink-0 flex-col" style={{ height: peaks && peaks.length > 0 ? 226 : 192, background: color.bgTimeline, borderTop: `1px solid ${color.cardBorder}` }}>
      {/* Transport 38px */}
      <div className="flex h-[38px] shrink-0 items-center gap-3 px-3" style={{ borderBottom: `1px solid ${color.cardBorder}` }}>
        <button onClick={togglePlay} className="flex h-[24px] w-[24px] items-center justify-center rounded-full" style={{ background: "rgba(255,255,255,.07)", border: `1px solid ${color.cardBorder}`, color: color.text, cursor: "pointer" }} aria-label="เล่น/หยุด">
          {playing && !videoRef.current?.paused ? <Pause size={11} /> : <Play size={11} style={{ marginLeft: 1 }} />}
        </button>
        <span style={{ font: `500 11px ${font.heading}`, color: color.textSecondary, fontVariantNumeric: "tabular-nums" }}>
          {fmt(timeMs)} / {fmt(durMs)}
        </span>
        <span className="flex-1" />
        <button onClick={onUndo} disabled={!canUndo} title="เลิกทำการแก้ซับ (Ctrl/⌘+Z)" className="flex items-center gap-1" style={{ background: "none", border: "none", color: canUndo ? color.textSecondary : color.textFaintest, cursor: canUndo ? "pointer" : "default", fontSize: 10.5 }}>
          <Undo2 size={12} /> เลิกทำ
        </button>
        <button onClick={onRedo} disabled={!canRedo} title="ทำซ้ำการแก้ซับ (Ctrl/⌘+Shift+Z)" className="flex items-center gap-1" style={{ background: "none", border: "none", color: canRedo ? color.textSecondary : color.textFaintest, cursor: canRedo ? "pointer" : "default", fontSize: 10.5 }}>
          <Redo2 size={12} /> ทำซ้ำ
        </button>
        <button onClick={() => setSnap(!snap)} title="Snap กับจังหวะเสียง" className="flex items-center gap-1" style={{ background: "none", border: "none", color: snap ? color.primary300 : color.textFaintest, cursor: "pointer", fontSize: 10.5 }}>
          <Magnet size={12} /> Snap
        </button>
        <div className="flex items-center gap-1">
          <button onClick={() => setPxPerSec((z) => Math.max(10, z - 6))} style={{ background: "none", border: "none", color: color.textSecondary, cursor: "pointer" }} aria-label="ซูมออก"><ZoomOut size={13} /></button>
          <button onClick={() => setPxPerSec((z) => Math.min(60, z + 6))} style={{ background: "none", border: "none", color: color.textSecondary, cursor: "pointer" }} aria-label="ซูมเข้า"><ZoomIn size={13} /></button>
        </div>
      </div>

      {/* Tracks — scrub ได้ทั้งพื้น: กด/ลากที่ว่างตรงไหนก็ได้ = ย้าย playhead (ไม่ใช่แค่
          แถบ ruler 24px — บั๊ก QA 07-04 "เส้นขาวกดยากมาก") · คลิป/ขอบซับ (data-clip/
          data-edge) ยังทำงานเดิมของมัน */}
      <div ref={scrollRef} className="flex-1 overflow-x-auto overflow-y-hidden">
        <div
          className="relative"
          style={{ width: widthPx + LABEL_W + 16, minWidth: "100%" }}
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest("[data-clip],[data-edge]")) return;
            scrubbingRef.current = true;
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            seekTo(((e.clientX - rect.left - LABEL_W) / pxPerSec) * 1000);
          }}
          onPointerMove={(e) => {
            if (!scrubbingRef.current) return;
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            seekTo(((e.clientX - rect.left - LABEL_W) / pxPerSec) * 1000);
          }}
          onPointerUp={(e) => {
            if (scrubbingRef.current) {
              scrubbingRef.current = false;
              try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
            }
            flushPendingSeek(); // ปล่อยนิ้ว = วิดีโอต้องจบที่ตำแหน่งสุดท้ายเสมอ
          }}
          onPointerCancel={() => { scrubbingRef.current = false; flushPendingSeek(); }}
        >
          {/* ruler */}
          <div className="relative ml-[92px] h-[24px] cursor-ew-resize" style={{ touchAction: "none" }}>
            {Array.from({ length: Math.floor(durMs / 1000) + 1 }, (_, s) => s).filter((s) => s % (pxPerSec < 18 ? 5 : 1) === 0).map((s) => (
              <span key={s} className="absolute top-0 select-none" style={{ left: toPx(s * 1000), fontSize: 8, color: color.textFaintest }}>
                {fmt(s * 1000)}
              </span>
            ))}
          </div>

          {/* อวตาร — บล็อกตามโหมดจริง (เดิม hardcode "พิธีกรเปิด 5s" เสมอ แม้เลือกทั้งคลิป
              — บั๊ก QA 07-04): full = เต็มคลิป · bookend = หัว · bookend-both = หัว+ท้าย ·
              งานเก่าไม่มีโหมด = เต็มคลิปแบบไม่ระบุ */}
          {hasAvatar && (
            <div className="relative flex items-center" style={{ height: TRACK_H }}>
              {trackLabel("อวตาร", color.trackAvatar)}
              <div className="relative flex-1" style={{ height: TRACK_H }}>
                {avatarMode === "bookend" || avatarMode === "bookend-both" ? (
                  <>
                    <div data-clip title={avatarFadeTitle} style={{ ...clipStyle(color.trackAvatar), left: 0, width: Math.max(24, toPx(avatarIntroMs)) }} onClick={() => seekTo(0)}>
                      พิธีกรเปิด {Math.round(avatarIntroMs / 1000)}s
                      {avatarFadeEdges}
                    </div>
                    {avatarMode === "bookend-both" && (
                      <div data-clip title={avatarFadeTitle} style={{ ...clipStyle(color.trackAvatar), left: toPx(Math.max(0, durMs - avatarTailMs)), width: Math.max(24, toPx(Math.min(avatarTailMs, durMs))) }} onClick={() => seekTo(Math.max(0, durMs - avatarTailMs))}>
                        พิธีกรปิด {Math.round(avatarTailMs / 1000)}s
                        {avatarFadeEdges}
                      </div>
                    )}
                  </>
                ) : (
                  <div data-clip title={avatarFadeTitle} style={{ ...clipStyle(color.trackAvatar), left: 0, width: Math.max(24, toPx(durMs) - 2) }} onClick={() => seekTo(0)}>
                    {avatarMode === "full" ? "พิธีกรทั้งคลิป" : "พิธีกร"}
                    {avatarFadeEdges}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* บีโรล */}
          <div className="relative flex items-center" style={{ height: TRACK_H }}>
            {trackLabel("บีโรล", color.trackBroll)}
            <div className="relative flex-1" style={{ height: TRACK_H }}>
              {brollSpans.map((s, i) => {
                const enabled = !disabledWindowIndices?.has(s.index);
                return (
                  <div
                    key={i}
                    data-clip
                    style={{
                      ...clipStyle(color.trackBroll),
                      left: toPx(s.startMs),
                      width: Math.max(14, toPx(s.endMs - s.startMs) - 2),
                      borderStyle: enabled ? "solid" : "dashed",
                      opacity: enabled ? 1 : 0.52,
                    }}
                    onClick={() => {
                      seekTo(s.startMs);
                      onSelectBrollWindow?.(s.index);
                    }}
                    title={enabled ? s.label : `ปิด B-roll · ${s.label}`}
                    aria-label={enabled ? s.label : `ปิด B-roll ${s.label}`}
                  >
                    {enabled ? s.label : `ปิด · ${s.label}`}
                    {editedWindowIndices?.has(s.index) && (
                      <span
                        aria-hidden
                        className="absolute"
                        style={{ top: 2, right: 2, width: 6, height: 6, borderRadius: "50%", background: color.primary300 }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* เสียงพูด (waveform) — วางติดเหนือซับเพื่อเทียบขอบกับจังหวะเสียงได้ทันที */}
          {peaks && peaks.length > 0 && (
            <div className="relative flex items-center" style={{ height: 34 }}>
              {trackLabel("เสียงพูด", color.trackVoice)}
              <div className="relative flex-1 overflow-hidden" style={{ height: 34 }}>
                <div className="absolute left-0 top-0">
                  <WaveformCanvas peaks={peaks} width={Math.max(1, Math.round(toPx(waveMs)))} height={34} color={`${color.trackVoice}66`} />
                </div>
              </div>
            </div>
          )}

          {/* ซับไทย — แก้ได้ */}
          <div className="relative flex items-center" style={{ height: TRACK_H }}>
            {trackLabel("ซับไทย", color.trackSub)}
            <div className="relative flex-1" style={{ height: TRACK_H }} onPointerMove={onEdgeMove} onPointerUp={onEdgeUp}>
              {captions.map((c, i) => (
                <div
                  key={i}
                  data-clip
                  style={{ ...clipStyle(color.trackSub, i === selected), left: toPx(c.startMs), width: Math.max(14, toPx(c.endMs - c.startMs) - 2) }}
                  onClick={() => { onSelect(i); seekTo(c.startMs + 10); }}
                  title={c.text}
                >
                  {/* ขอบลากซ้าย/ขวา */}
                  <span data-edge onPointerDown={(e) => onEdgeDown(e, i, "l")} className="absolute bottom-0 left-0 top-0 w-[6px] cursor-ew-resize" style={{ borderLeft: i === selected ? `2px solid ${color.primary300}` : undefined }} />
                  {c.text}
                  <span data-edge onPointerDown={(e) => onEdgeDown(e, i, "r")} className="absolute bottom-0 right-0 top-0 w-[6px] cursor-ew-resize" style={{ borderRight: i === selected ? `2px solid ${color.primary300}` : undefined }} />
                </div>
              ))}
            </div>
          </div>

          {/* เพลง */}
          {bgmFile && (
            <div className="relative flex items-center" style={{ height: TRACK_H }}>
              {trackLabel("เพลง", color.trackMusic)}
              <div className="relative flex-1" style={{ height: TRACK_H }}>
                <div data-clip style={{ ...clipStyle(color.trackMusic), left: 0, width: Math.max(24, toPx(durMs) - 2) }} onClick={() => seekTo(0)}>
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
