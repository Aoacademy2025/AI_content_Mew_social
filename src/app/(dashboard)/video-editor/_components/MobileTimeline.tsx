"use client";

/**
 * CapCut-style mobile timeline.
 *
 * The playhead is PINNED to the horizontal centre; the tracks scroll under it.
 * - While playing, it subscribes to the playbackTime store and auto-scrolls so
 *   the current frame stays centred (zero React re-renders, ref-driven).
 * - While paused, dragging the timeline scrubs: the time at the centre line is
 *   seeked. Same store/ref pattern as PlayheadIndicator.
 *
 * Tracks (time-scaled): ruler · B-roll filmstrip · voice · subtitles.
 * Single accent = brand violet; the centre line is white (CapCut convention).
 */

import { memo, useEffect, useRef, useState } from "react";
import { Plus, Mic } from "lucide-react";
import { playbackTime } from "../_lib/playback-time";
import type { Caption, StockVideo } from "./types";

const PX_PER_SEC = 90;

function toCaptionMs(videoMs: number, durationMs: number, captionEndMs: number): number {
  return durationMs > 0 && captionEndMs > 0 ? videoMs * (captionEndMs / durationMs) : videoMs;
}

interface Props {
  captions: Caption[];
  stockVideos: StockVideo[];
  totalMs: number;
  durationMs: number;
  captionEndMs: number;
  ttsUrl: string;
  playing: boolean;
  activeCaptionIdx: number;
  fmtMs: (ms: number) => string;
  /** seek expressed in caption-time ms; parent converts to video-time + seeks */
  onSeekCaptionMs: (capMs: number) => void;
  onAddVoice: () => void;
  onAddText: () => void;
  onAddBroll: () => void;
}

export const MobileTimeline = memo(function MobileTimeline(p: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const curRef = useRef<HTMLSpanElement>(null);
  const userScrollingRef = useRef(false);
  const programmaticRef = useRef(false);
  const seekRafRef = useRef(false);
  const scrollEndRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ความกว้าง viewport ของ timeline — คลิปสั้นถูก scale ขึ้นให้เต็มจอเสมอ
  // (ไม่งั้นคลิป 3-4 วิ กว้างแค่ ~300px ลอยอยู่กลางจอ); คลิปยาวยังคง 90px/วิ + scroll
  const [viewportW, setViewportW] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pxPerSec = p.totalMs > 0 && viewportW > 0
    ? Math.max(PX_PER_SEC, viewportW / (p.totalMs / 1000))
    : PX_PER_SEC;
  const contentW = Math.max(1, (p.totalMs / 1000) * pxPerSec);

  // Follow the playhead while playing; always keep the time label fresh.
  useEffect(() => {
    const apply = () => {
      const sc = scrollRef.current;
      const capMs = toCaptionMs(playbackTime.getMs(), p.durationMs, p.captionEndMs);
      if (curRef.current) curRef.current.textContent = p.fmtMs(capMs);
      if (!sc || !p.playing || userScrollingRef.current) return;
      const x = p.totalMs > 0 ? (capMs / p.totalMs) * contentW : 0;
      programmaticRef.current = true;
      sc.scrollLeft = x; // padding-left = 50% viewport → scrollLeft x centres time x
      requestAnimationFrame(() => { programmaticRef.current = false; });
    };
    apply();
    return playbackTime.subscribe(apply);
  }, [p.playing, p.totalMs, p.durationMs, p.captionEndMs, contentW, p.fmtMs]);

  // Scrub while paused: time at the centre line follows the scroll position.
  function onScroll() {
    const sc = scrollRef.current;
    if (!sc || programmaticRef.current || p.playing) return;
    userScrollingRef.current = true;
    const capMs = contentW > 0 ? Math.max(0, Math.min(p.totalMs, (sc.scrollLeft / contentW) * p.totalMs)) : 0;
    if (curRef.current) curRef.current.textContent = p.fmtMs(capMs);
    if (!seekRafRef.current) {
      seekRafRef.current = true;
      requestAnimationFrame(() => { seekRafRef.current = false; p.onSeekCaptionMs(capMs); });
    }
    if (scrollEndRef.current) clearTimeout(scrollEndRef.current);
    scrollEndRef.current = setTimeout(() => { userScrollingRef.current = false; }, 160);
  }

  const perCaption = p.stockVideos.length === p.captions.length && p.totalMs > 0;
  const seconds = Math.max(1, Math.ceil(p.totalMs / 1000));
  const isEmpty = p.totalMs === 0;

  return (
    <div className="shrink-0 border-t border-[#1e1e28] bg-[#0e0e13]" style={{ maxHeight: 220, overflow: "hidden" }}>
      {/* current / total */}
      <div className="flex items-center gap-1.5 px-3 pb-0.5 pt-1.5 text-[11px]">
        <span ref={curRef} className="font-mono font-semibold text-slate-200">00:00</span>
        <span className="font-mono text-slate-600">/ {p.fmtMs(p.totalMs)}</span>
        {isEmpty && <span className="ml-auto text-[10px] italic text-slate-700">ยังไม่มี track</span>}
      </div>

      {/* scrolling tracks + pinned centre playhead */}
      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{ paddingLeft: "50%", paddingRight: "50%" }}
        >
          <div className="relative" style={{ width: `${contentW}px` }}>
            {/* ruler */}
            <div className="relative mb-1 h-4">
              {Array.from({ length: seconds + 1 }, (_, s) => {
                const left = p.totalMs > 0 ? (s * 1000 / p.totalMs) * 100 : 0;
                const major = s % 2 === 0;
                return (
                  <div key={s} className="absolute top-0 -translate-x-1/2" style={{ left: `${left}%` }}>
                    {major
                      ? <span className="font-mono text-[8px] text-slate-500">{p.fmtMs(s * 1000)}</span>
                      : <span className="block h-1 w-1 translate-y-1 rounded-full bg-slate-700" />}
                  </div>
                );
              })}
            </div>

            {/* B-roll filmstrip */}
            <div className="relative mb-1 flex h-11 overflow-hidden rounded-md">
              {p.stockVideos.length > 0 ? p.stockVideos.map((sv, i) => {
                const durPct = perCaption
                  ? ((p.captions[i].endMs - p.captions[i].startMs) / p.totalMs) * 100
                  : 100 / p.stockVideos.length;
                const thumb = sv.imageLocalUrl || sv.imageUrl;
                return (
                  <div
                    key={i}
                    className="relative h-full shrink-0 border-r border-black/40 last:border-r-0"
                    style={{
                      width: `${Math.max(2, durPct)}%`,
                      background: thumb
                        ? `center/auto 100% repeat-x url(${thumb})`
                        : `linear-gradient(150deg, hsl(${(i * 53) % 360} 42% 32%), hsl(${(i * 53 + 28) % 360} 42% 16%))`,
                    }}
                  >
                    {!thumb && <span className="absolute bottom-1 left-1.5 max-w-[90%] truncate font-mono text-[8px] text-white/85">{sv.keyword || `คลิป ${i + 1}`}</span>}
                  </div>
                );
              }) : (
                <div className="flex h-full w-full items-center justify-center bg-[#16161c] text-[10px] text-slate-600">B-roll หลัง render</div>
              )}
              {/* faint frame lines to read as a filmstrip */}
              <div className="pointer-events-none absolute inset-0" style={{ backgroundImage: "repeating-linear-gradient(90deg, rgba(0,0,0,0.18) 0 1px, transparent 1px 26px)" }} />
            </div>

            {/* voice track */}
            {p.ttsUrl && (
              <div className="mb-1 h-7 overflow-hidden rounded-md border border-emerald-400/30 bg-emerald-400/10">
                <div className="flex h-full items-center gap-1.5 px-2" style={{ backgroundImage: "repeating-linear-gradient(90deg, rgba(52,211,153,0.32) 0 2px, transparent 2px 5px)", backgroundSize: "100% 60%", backgroundPosition: "0 50%", backgroundRepeat: "repeat-x" }}>
                  <Mic className="h-3 w-3 shrink-0 text-emerald-400" />
                  <span className="text-[9px] font-semibold text-emerald-300">เสียงพากย์</span>
                </div>
              </div>
            )}

            {/* subtitle track */}
            {p.captions.length > 0 && (
              <div className="relative h-7">
                {p.captions.map((cap, i) => {
                  const left = p.totalMs > 0 ? (cap.startMs / p.totalMs) * 100 : 0;
                  const width = p.totalMs > 0 ? ((cap.endMs - cap.startMs) / p.totalMs) * 100 : 0;
                  return (
                    <button
                      key={i}
                      onClick={() => p.onSeekCaptionMs(cap.startMs)}
                      className={"absolute top-0 flex h-7 items-center overflow-hidden whitespace-nowrap rounded-md border px-2 text-[10px] font-semibold " + (i === p.activeCaptionIdx ? "border-violet-400 bg-violet-500/25 text-violet-100" : "border-violet-500/30 bg-violet-500/10 text-violet-200/90")}
                      style={{ left: `${left}%`, width: `calc(${Math.max(1, width)}% - 2px)` }}
                    >
                      <span className="truncate">{cap.text}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* pinned centre playhead */}
        <div className="pointer-events-none absolute bottom-2 left-1/2 top-0 z-20 w-[2px] -translate-x-1/2 bg-white">
          <div className="absolute -top-0.5 left-1/2 h-2 w-3 -translate-x-1/2 rounded-sm bg-white" />
        </div>
      </div>

      {/* track-add shortcuts — compact single row */}
      <div className="flex items-center gap-1.5 overflow-x-auto px-3 pb-2 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {!p.ttsUrl && (
          <button onClick={p.onAddVoice} className="flex h-7 shrink-0 items-center gap-1 rounded-md bg-[#16161c] px-2.5 text-[11px] font-semibold text-slate-400 active:bg-[#1e1e28]">
            <Plus className="h-3 w-3" /> เสียง
          </button>
        )}
        {p.captions.length === 0 && (
          <button onClick={p.onAddText} className="flex h-7 shrink-0 items-center gap-1 rounded-md bg-[#16161c] px-2.5 text-[11px] font-semibold text-slate-400 active:bg-[#1e1e28]">
            <Plus className="h-3 w-3" /> ข้อความ
          </button>
        )}
        <button onClick={p.onAddBroll} className="flex h-7 shrink-0 items-center gap-1 rounded-md bg-[#16161c] px-2.5 text-[11px] font-semibold text-slate-400 active:bg-[#1e1e28]">
          <Plus className="h-3 w-3" /> B-roll
        </button>
      </div>
    </div>
  );
});
