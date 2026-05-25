"use client";

/**
 * /video-editor — Timeline-based video editor
 * Copied from /video-creator, UI replaced with timeline layout.
 * DO NOT modify /video-creator/page.tsx — this is a separate page.
 */

import React, { useState, useEffect, useRef, useCallback } from "react";

import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Download, Scissors, Trash2, Lock,
  ChevronDown, Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Volume1,
  Maximize2, Minimize2, Plus, Search, Loader2, CheckCircle2, AlertCircle,
  ZoomIn, User, Music, Upload, X, Save,
} from "lucide-react";
import { GEMINI_VOICES } from "@/lib/gemini-voices";
import { ApiKeyModal, detectMissingKeyType, type RequiredKeyType } from "@/components/ui/api-key-modal";
import { UpgradeModal } from "@/components/ui/upgrade-modal";

// ─── Types ─────────────────────────────────────────────────────────────────

type StepStatus = "idle" | "running" | "done" | "error" | "skip";

interface StepState {
  keywords:       StepStatus;
  fetchStock:     StepStatus;
  tts:            StepStatus;
  transcribe:     StepStatus;
  config:         StepStatus;
  render:         StepStatus;
  burnSubtitles:  StepStatus;
  avatar:         StepStatus;
  avatarTail:     StepStatus;
  composite:      StepStatus;
}

interface Caption { text: string; startMs: number; endMs: number; tag?: "hook" | "body" | "cta"; }
interface StockVideo { keyword: string; localUrl?: string; videoUrl: string; duration: number; pexelsId: number; }

const DEFAULT_STEPS: StepState = {
  keywords: "idle", fetchStock: "idle", tts: "idle",
  transcribe: "idle", config: "idle", render: "idle",
  burnSubtitles: "idle",
  avatar: "idle", avatarTail: "idle", composite: "idle",
};

interface PipelineData {
  scenes: string[];
  keywords: string[];
  keywordAlternatives: string[][];
  keywordsPerScene: number;
  sceneClipCounts: number[];
  sceneDurations: number[];
  visualDirection: string;
  stockVideos: StockVideo[];
  voiceUrl: string;
  captions: Caption[];
  sceneCaptions: Caption[];
  words: { word: string; startMs: number; endMs: number }[];
  audioDurationMs: number;
  config: unknown;
  renderedVideoUrl: string;        // วิดีโอ render ล่าสุด (no-sub หรือ with-sub)
  renderedVideoNoSubUrl: string;   // วิดีโอที่ไม่มีซับ — input ของ Burn Subtitles
  burnedVideoUrl: string;          // output ของ Burn Subtitles — ไม่ทับ renderedVideoUrl
  galleryVideoId: string;          // id ของ Video record ใน Gallery — UPDATE แทน INSERT
  compositeUrl: string;
}

type SubPreset = "stroke" | "plain" | "shadow" | "box" | "box-rounded" | "glow" | "outline-only"
  | "karaoke" | "typewriter" | "bold-shadow" | "karaoke-box" | "pop-outline"
  | "neon-green" | "neon-red" | "neon-blue"
  | "pastel" | "classic-yellow" | "hormozi" | "beast"
  | "box-white" | "box-yellow" | "retro" | "sharp-outline" | "news";

type SubTextEffect = "pop" | "bounce" | "fade" | "quick" | "glow-pulse"
  | "slide" | "flip" | "highlight" | "karaoke" | "typewriter";

interface EditorDraft {
  id: string;
  name: string;
  updatedAt: number;
  script: string;
  scriptOverride?: string;
  style: {
    fontFamily: string; fontSize: number; fontWeight: number;
    color: string; accentColor: string; preset: SubPreset; effect: SubTextEffect; position: number;
    shadow?: boolean; outline?: boolean; outlineSize?: number;
  };
  renderedUrl: string;
  renderedVideoNoSubUrl?: string;
  burnedVideoUrl?: string;
  galleryVideoId?: string;
  compositeUrl?: string;

  ttsProvider: "elevenlabs" | "gemini";
  voiceId: string;
  geminiVoiceName: string;
  captions?: Caption[];
  voiceUrl?: string;
  audioDurationMs?: number;

  // Pipeline data — resume without rerunning
  keywords?: string[];
  keywordAlternatives?: string[][];
  keywordsPerScene?: number;
  sceneClipCounts?: number[];
  sceneDurations?: number[];
  scenes?: string[];
  visualDirection?: string;
  stockVideos?: StockVideo[];
  config?: unknown;

  // Stock source
  stockSource?: "pexels" | "pixabay" | "both";

  // BGM
  bgmEnabled?: boolean;
  bgmFile?: string;
  bgmVolume?: number;

  // Avatar
  useAvatar?: boolean;
  avatarId?: string;
  avatarName?: string;
  avatarPreviewUrl?: string;
  avatarTiming?: "full" | "bookend" | "bookend-both";
  avatarBookendSecs?: number;
  avatarTailSecs?: number;
  avatarScale?: number;
  avatarOffsetX?: number;
  avatarOffsetY?: number;
  avatarInputMode?: "generate" | "direct";
  avatarDirectUrl?: string;
  chromaSimilarity?: number;
  chromaBlend?: number;
  avatarGreenUrl?: string;
  avatarTailGreenUrl?: string;
}

const DRAFT_KEY = "ve_drafts_v2";

// ─── Draft helpers ─────────────────────────────────────────────────────────

function loadDrafts(): EditorDraft[] {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "[]"); } catch { return []; }
}
function saveDrafts(drafts: EditorDraft[]) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts.slice(0, 20))); } catch {}
}
function newDraftId() { return `draft_${Date.now()}_${Math.random().toString(36).slice(2,7)}`; }

// ─── Sub step icon ─────────────────────────────────────────────────────────

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "running") return <Loader2 className="w-3 h-3 animate-spin text-violet-400" />;
  if (status === "done")    return <CheckCircle2 className="w-3 h-3 text-emerald-400" />;
  if (status === "error")   return <AlertCircle className="w-3 h-3 text-red-400" />;
  if (status === "skip")    return <span className="w-3 h-3 text-slate-600 text-[10px]">—</span>;
  return <span className="w-3 h-3 rounded-full border border-slate-700 inline-block" />;
}

// ─── Subtitle preview renderer (same as video-creator) ────────────────────

function renderSubEl(
  text: string, color: string, accentColor: string, isAccent: boolean,
  preset: SubPreset, fontFamily: string, fontSizePx: number, fontWeight: number, scale = 1,
): React.ReactNode {
  const c = isAccent ? accentColor : color;
  const charCount = text.length;
  const lengthScale = charCount <= 6 ? 1 : charCount <= 12 ? 0.9 : charCount <= 20 ? 0.78 : 0.68;
  const fs = Math.round(fontSizePx * scale * lengthScale);
  const fw = fontWeight;
  const sw = Math.max(0.5, 2 * scale);
  const base: React.CSSProperties = {
    fontFamily, fontSize: fs, fontWeight: fw, color: c,
    lineHeight: 1.3, letterSpacing: "0.01em",
    display: "block", textAlign: "center", width: "100%",
    whiteSpace: "normal", wordBreak: "break-all", overflowWrap: "anywhere",
  };
  if (preset === "plain") return <span style={base}>{text}</span>;
  if (preset === "karaoke-box") {
    const py=Math.round(8*scale),px=Math.round(22*scale),br=Math.round(12*scale);
    return <div style={{background:"rgba(0,0,0,0.75)",padding:`${py}px ${px}px`,display:"inline-block",borderRadius:br}}><span style={{...base,color}}>{text}</span></div>;
  }
  if (preset === "box-white") {
    const py=Math.round(6*scale),px=Math.round(20*scale),pb=Math.round(8*scale);
    return <div style={{background:"#fff",padding:`${py}px ${px}px ${pb}px`,display:"inline-block",borderRadius:Math.round(4*scale)}}><span style={{...base,color:"#111",textShadow:"none"}}>{text}</span></div>;
  }
  if (preset === "box-yellow") {
    const py=Math.round(6*scale),px=Math.round(20*scale),pb=Math.round(8*scale);
    return <div style={{background:"#FFE500",padding:`${py}px ${px}px ${pb}px`,display:"inline-block",borderRadius:Math.round(6*scale)}}><span style={{...base,color:"#111",textShadow:"none"}}>{text}</span></div>;
  }
  if (preset === "box" || preset === "box-rounded") {
    const br=preset==="box-rounded"?Math.round(8*scale):Math.round(3*scale);
    const py=Math.round(4*scale),px=Math.round(16*scale);
    return <div style={{background:"rgba(0,0,0,0.7)",padding:`${py}px ${px}px`,display:"inline-block",borderRadius:br}}><span style={{...base}}>{text}</span></div>;
  }
  if (preset === "classic-yellow") {
    const sw2=Math.max(1,Math.round(2*scale));
    return <span style={{...base,color:"#FFE500",WebkitTextStroke:`${sw2}px #000`,paintOrder:"stroke fill"} as React.CSSProperties}>{text}</span>;
  }
  if (preset === "neon-green") return <span style={{...base,color:"#00ff88",textShadow:`0 0 ${Math.round(8*scale)}px #00ff88,0 0 ${Math.round(20*scale)}px #00ff88`}}>{text}</span>;
  if (preset === "neon-red")   return <span style={{...base,color:"#ff3344",textShadow:`0 0 ${Math.round(8*scale)}px #ff3344,0 0 ${Math.round(20*scale)}px #ff1133`}}>{text}</span>;
  if (preset === "neon-blue")  return <span style={{...base,color:"#00cfff",textShadow:`0 0 ${Math.round(8*scale)}px #00cfff,0 0 ${Math.round(20*scale)}px #0099ff`}}>{text}</span>;
  if (preset === "hormozi") {
    const sw2=Math.max(1,Math.round(2*scale));
    return <span style={{...base,color:"#ff2244",fontStyle:"italic",fontWeight:900,WebkitTextStroke:`${sw2}px #fff`,paintOrder:"stroke fill"} as React.CSSProperties}>{text}</span>;
  }
  if (preset === "beast") {
    const sw2=Math.max(1,Math.round(2*scale));
    return <span style={{...base,color:"#fff",WebkitTextStroke:`${sw2}px #ff8800`,paintOrder:"stroke fill",textShadow:`0 0 ${Math.round(10*scale)}px rgba(255,140,0,0.4)`} as React.CSSProperties}>{text}</span>;
  }
  if (preset === "bold-shadow") {
    const s=Math.round(4*scale);
    return <span style={{...base,fontWeight:900,textShadow:`${s}px ${s}px 0 #000,${-s}px ${s}px 0 #000,${s}px ${-s}px 0 #000,${-s}px ${-s}px 0 #000`}}>{text}</span>;
  }
  if (preset === "pop-outline") {
    const sw2=Math.max(1,Math.round(3*scale));
    return <span style={{...base,WebkitTextStroke:`${sw2}px #000`,paintOrder:"stroke fill",textShadow:`0 ${Math.round(4*scale)}px 0 rgba(0,0,0,0.6)`} as React.CSSProperties}>{text}</span>;
  }
  if (preset === "pastel") {
    return <span style={{...base,color:"#ffb3d9",textShadow:`0 2px 0 rgba(0,0,0,0.5)`}}>{text}</span>;
  }
  if (preset === "shadow") {
    const s=Math.round(3*scale);
    return <span style={{...base,textShadow:`${s}px ${s}px ${Math.round(8*scale)}px rgba(0,0,0,0.9)`}}>{text}</span>;
  }
  if (preset === "glow") {
    return <span style={{...base,textShadow:`0 0 ${Math.round(12*scale)}px ${c},0 0 ${Math.round(24*scale)}px ${c}`}}>{text}</span>;
  }
  if (preset === "outline-only") {
    const sw2=Math.max(1,Math.round(2*scale));
    return <span style={{...base,color:"transparent",WebkitTextStroke:`${sw2}px ${c}`,paintOrder:"stroke fill"} as React.CSSProperties}>{text}</span>;
  }
  if (preset === "retro") {
    const d=Math.round(2*scale);
    return <span style={{...base,color:"#fff",textShadow:`${d}px ${d}px 0 #ff6b00,${d*2}px ${d*2}px 0 #cc4400`}}>{text}</span>;
  }
  if (preset === "sharp-outline") {
    const sw2=Math.max(1,Math.round(2*scale));
    return <span style={{...base,WebkitTextStroke:`${sw2}px ${c}`,paintOrder:"stroke fill",color:"#000"} as React.CSSProperties}>{text}</span>;
  }
  if (preset === "news") {
    const py=Math.round(3*scale),px=Math.round(12*scale);
    return <div style={{background:"#cc0000",padding:`${py}px ${px}px`,display:"inline-block",borderRadius:Math.round(2*scale)}}><span style={{...base,color:"#fff",fontWeight:900,letterSpacing:"0.05em",textShadow:"none"}}>{text}</span></div>;
  }
  if (preset === "karaoke" || preset === "typewriter") {
    return <span style={{...base,color:accentColor||"#FFE500"}}>{text}</span>;
  }
  // stroke (default)
  const s1=Math.round(3*scale),s2=Math.round(20*scale),s3=Math.round(32*scale);
  return <span style={{...base,textShadow:`0 ${s1}px 0 #000,0 -1px 0 #000,1px 0 0 #000,-1px 0 0 #000,0 4px ${s2}px rgba(0,0,0,0.95),0 8px ${s3}px rgba(0,0,0,0.8)`,WebkitTextStroke:`${sw}px #000`} as React.CSSProperties}>{text}</span>;
}

// ─── ApiCallError ──────────────────────────────────────────────────────────

class ApiCallError extends Error {
  data: Record<string, unknown>;
  constructor(prefix: string, data: Record<string, unknown>, status?: number) {
    const detail = data.detail ? ` — ${String(data.detail).slice(0,200)}` : "";
    super(`${prefix}: ${data.error ?? "Unknown error"}${detail}`);
    this.data = { ...data, _status: status };
  }
}

// ─── Color dot helper ──────────────────────────────────────────────────────

function ColorDots({ colors, value, onChange }: { colors: string[]; value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      {colors.map(c => (
        <button key={c} onClick={() => onChange(c)}
          className="w-5 h-5 rounded-full border-2 transition-transform hover:scale-110 flex-shrink-0"
          style={{ background: c, borderColor: value === c ? "#fff" : "transparent", boxShadow: value === c ? "0 0 0 1px #7c3aed" : "none" }} />
      ))}
      <button className="w-5 h-5 rounded-full border border-dashed border-slate-600 flex items-center justify-center text-slate-500 hover:border-slate-400 text-xs">+</button>
    </div>
  );
}

// ─── Slider helper ─────────────────────────────────────────────────────────

function SliderRow({ value, min, max, onChange, unit = "" }: { value: number; min: number; max: number; onChange: (v: number) => void; unit?: string }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 relative h-1 rounded bg-slate-700 cursor-pointer"
        onClick={e => { const r = e.currentTarget.getBoundingClientRect(); onChange(Math.round(min + ((e.clientX - r.left) / r.width) * (max - min))); }}>
        <div className="absolute left-0 top-0 h-full rounded bg-violet-500" style={{ width: `${pct}%` }} />
        <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-white border-2 border-violet-500 shadow-[0_0_6px_rgba(124,58,237,0.5)]" style={{ left: `${pct}%` }} />
      </div>
      <span className="text-[11px] text-slate-500 min-w-[36px] text-right tabular-nums">{value}{unit}</span>
    </div>
  );
}

// ─── Animated effect keyframes (copied from video-creator) ───────────────────

const EFFECT_KEYFRAMES = `
@keyframes ef-pop    { 0%,100%{transform:scale(1) translateY(0)} 30%{transform:scale(1.25) translateY(-4px)} 60%{transform:scale(0.95) translateY(1px)} }
@keyframes ef-bounce { 0%,100%{transform:scale(1) translateY(0)} 25%{transform:scale(0.8) translateY(8px)} 55%{transform:scale(1.3) translateY(-8px)} 80%{transform:scale(0.95) translateY(2px)} }
@keyframes ef-fade   { 0%,100%{opacity:0} 20%,80%{opacity:1} }
@keyframes ef-quick  { 0%{transform:scale(0.4) translateY(6px);opacity:0} 18%{transform:scale(1.08) translateY(-2px);opacity:1} 30%,100%{transform:scale(1) translateY(0);opacity:1} }
@keyframes ef-slide  { 0%{transform:translateY(16px);opacity:0} 35%,80%{transform:translateY(0);opacity:1} 100%{transform:translateY(-8px);opacity:0} }
@keyframes ef-flip   { 0%{transform:perspective(200px) rotateX(90deg);opacity:0} 40%,75%{transform:perspective(200px) rotateX(0deg);opacity:1} 100%{transform:perspective(200px) rotateX(-30deg);opacity:0} }
@keyframes ef-hl-bar { 0%{width:0%} 55%,100%{width:100%} }
@keyframes ef-kar    { 0%,12%{color:inherit} 13%,24%{color:rgba(255,255,255,0.3)} 25%,36%{color:inherit} 37%,48%{color:rgba(255,255,255,0.3)} 49%,60%{color:inherit} 61%,72%{color:rgba(255,255,255,0.3)} 73%,84%{color:inherit} 85%,100%{color:rgba(255,255,255,0.3)} }
@keyframes ef-type   { 0%{clip-path:inset(0 100% 0 0)} 60%,100%{clip-path:inset(0 0% 0 0)} }
`;

function EffectPreviewCard({
  effect, label, desc, color, accentColor, fontFamily, selected, onClick,
}: {
  effect: SubTextEffect; label: string; desc: string;
  color: string; accentColor: string; fontFamily: string;
  selected: boolean; onClick: () => void;
}) {
  const base: React.CSSProperties = {
    fontFamily, fontSize: 13, fontWeight: 700, color,
    textShadow: "-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000",
    display: "inline-block", whiteSpace: "nowrap",
  };
  const dur = "1.8s";
  const ease = "cubic-bezier(.4,0,.2,1)";
  const inf = "infinite";

  let inner: React.ReactNode;

  if (effect === "pop") {
    inner = <span style={{ ...base, animation: `ef-pop ${dur} ${ease} ${inf}` }}>ป๊อป</span>;
  } else if (effect === "bounce") {
    inner = <span style={{ ...base, animation: `ef-bounce 2s ${ease} ${inf}` }}>เด้ง</span>;
  } else if (effect === "fade") {
    inner = <span style={{ ...base, animation: `ef-fade 2s ease ${inf}` }}>เฟด</span>;
  } else if (effect === "quick") {
    inner = <span style={{ ...base, animation: `ef-quick 1.4s ${ease} ${inf}` }}>สั้น</span>;
  } else if (effect === "glow-pulse") {
    const r=parseInt(color.slice(1,3)||"ff",16),g=parseInt(color.slice(3,5)||"ff",16),b=parseInt(color.slice(5,7)||"ff",16);
    const glowKf = `@keyframes ef-glow-${r}-${g}-${b} { 0%,100%{text-shadow:0 0 4px rgba(${r},${g},${b},0.6),0 0 8px rgba(${r},${g},${b},0.4)} 50%{text-shadow:0 0 16px rgba(${r},${g},${b},1),0 0 32px rgba(${r},${g},${b},0.8),0 0 48px rgba(${r},${g},${b},0.5)} }`;
    inner = (
      <>
        <style dangerouslySetInnerHTML={{ __html: glowKf }} />
        <span style={{ ...base, textShadow: `0 0 8px rgba(${r},${g},${b},0.9)`, animation: `ef-glow-${r}-${g}-${b} 1.6s ease ${inf}` }}>แสง</span>
      </>
    );
  } else if (effect === "slide") {
    inner = <span style={{ ...base, animation: `ef-slide 2s ${ease} ${inf}` }}>เลื่อน</span>;
  } else if (effect === "flip") {
    inner = <span style={{ ...base, animation: `ef-flip 2s ${ease} ${inf}` }}>พลิก</span>;
  } else if (effect === "highlight") {
    inner = (
      <span style={{ position: "relative", display: "inline-block" }}>
        <span style={{ position: "absolute", inset: "5% 0", background: accentColor, opacity: 0.4, borderRadius: 3, animation: `ef-hl-bar 2s ease ${inf}` }} />
        <span style={{ ...base, position: "relative" }}>ไฮไลท์</span>
      </span>
    );
  } else if (effect === "karaoke") {
    inner = (
      <span style={{ fontFamily, fontSize: 12, fontWeight: 700, display: "inline-block" }}>
        {["คา","รา","โอ","เกะ"].map((s,i) => (
          <span key={i} style={{ color, animation: `ef-kar 2.4s ${i*0.3}s ease ${inf}` }}>{s}</span>
        ))}
      </span>
    );
  } else {
    inner = (
      <span style={{ fontFamily, fontSize: 12, fontWeight: 700, color, display: "inline-block", overflow: "hidden", animation: `ef-type 2s ease ${inf}` }}>
        พิมพ์ดีด
      </span>
    );
  }

  return (
    <button onClick={onClick}
      className="flex flex-col items-center gap-0.5 rounded-xl py-2 px-2 transition-all"
      style={selected
        ? { background: "hsl(262 83% 45% / 0.12)", border: "1px solid hsl(262 83% 58% / 0.5)", color: "hsl(262 83% 78%)" }
        : { background: "#1a1a22", border: "1px solid #2a2a36", color: "rgba(148,163,184,0.6)" }
      }>
      <div className="h-8 flex items-center justify-center"
        style={{ background: "rgba(0,0,0,0.45)", borderRadius: 6, width: "100%", overflow: "hidden", position: "relative" }}>
        {inner}
      </div>
      <span className="text-[10px] font-bold mt-0.5">{label}</span>
      <span className="text-[8px] opacity-50">{desc}</span>
    </button>
  );
}

// ─── Right Settings Panel (shared between docked & floating) ──────────────────

const PRESETS_DATA: { value: SubPreset; label: string }[] = [
  { value: "stroke",        label: "มาตรฐาน" },
  { value: "plain",         label: "มินิมอล" },
  { value: "bold-shadow",   label: "ตัวหนา" },
  { value: "neon-green",    label: "น็ออนเขียว" },
  { value: "neon-red",      label: "ไฟแดง" },
  { value: "neon-blue",     label: "ไฟฟ้า" },
  { value: "karaoke-box",   label: "คาราโอเกะ" },
  { value: "pop-outline",   label: "ป๊อปไลน์" },
  { value: "pastel",        label: "พาสเทล" },
  { value: "classic-yellow",label: "คลาสสิก" },
  { value: "hormozi",       label: "Hormozi" },
  { value: "beast",         label: "Beast" },
  { value: "box-white",     label: "กล่องขาว" },
  { value: "box-yellow",    label: "กล่องเหลือง" },
  { value: "retro",         label: "เรโทร" },
  { value: "sharp-outline", label: "เส้นขอบชัด" },
  { value: "news",          label: "ข่าว" },
];

const EFFECTS_DATA: { value: SubTextEffect; label: string; desc: string }[] = [
  { value: "pop",        label: "ป๊อป",       desc: "กระโดดเข้า" },
  { value: "bounce",     label: "เด้ง",        desc: "สปริงกระดอน" },
  { value: "fade",       label: "เฟด",        desc: "ค่อยๆ ปรากฏ" },
  { value: "quick",      label: "สั้น",        desc: "กระชับรวดเร็ว" },
  { value: "glow-pulse", label: "เรืองแสง",   desc: "กะพริบเรืองแสง" },
  { value: "slide",      label: "สไลด์",      desc: "เลื่อนขึ้นจากล่าง" },
  { value: "flip",       label: "หมุนชุม",    desc: "พลิกมุมมอง" },
  { value: "highlight",  label: "ไฮไลท์",     desc: "แถบไฮไลท์" },
  { value: "karaoke",    label: "คาราโอเกะ",  desc: "ทีละคำ" },
  { value: "typewriter", label: "พิมพ์ดีด",   desc: "ทีละตัว" },
];

const FONTS_LIST: { label: string; value: string; preview: string }[] = [
  { label: "Mitr",              value: "'Mitr', sans-serif",                preview: "สวัสดี Abc" },
  { label: "Kanit",             value: "'Kanit', sans-serif",               preview: "สวัสดี Abc" },
  { label: "Sarabun",           value: "'Sarabun', sans-serif",             preview: "สวัสดี Abc" },
  { label: "Prompt",            value: "'Prompt', sans-serif",              preview: "สวัสดี Abc" },
  { label: "Noto Sans Thai",    value: "'Noto Sans Thai', sans-serif",      preview: "สวัสดี Abc" },
  { label: "IBM Plex Thai",     value: "'IBM Plex Sans Thai', sans-serif",  preview: "สวัสดี Abc" },
  { label: "Chakra Petch",      value: "'Chakra Petch', sans-serif",        preview: "สวัสดี Abc" },
  { label: "Chonburi",          value: "'Chonburi', serif",                 preview: "สวัสดี Abc" },
  { label: "Fahkwang",          value: "'Fahkwang', sans-serif",            preview: "สวัสดี Abc" },
  { label: "Itim",              value: "'Itim', cursive",                   preview: "สวัสดี Abc" },
  { label: "Sriracha",          value: "'Sriracha', cursive",               preview: "สวัสดี Abc" },
  { label: "Bangers",           value: "'Bangers', cursive",                preview: "Abc 123" },
  { label: "Bebas Neue",        value: "'Bebas Neue', cursive",             preview: "ABC 123" },
  { label: "Oswald",            value: "'Oswald', sans-serif",              preview: "Abc 123" },
  { label: "Anton",             value: "'Anton', sans-serif",               preview: "ABC 123" },
  { label: "Righteous",         value: "'Righteous', cursive",              preview: "Abc 123" },
  { label: "Playfair Display",  value: "'Playfair Display', serif",         preview: "Abc 123" },
  { label: "Pacifico",          value: "'Pacifico', cursive",               preview: "Abc 123" },
  { label: "Lobster",           value: "'Lobster', cursive",                preview: "Abc 123" },
];
const ACCENT_COLORS_LIST = ["#FFE500","#FF3B30","#34C759","#007AFF","#AF52DE","#FF9500","#ffffff","#000000"];
const TEXT_COLORS_LIST  = ["#ffffff","#FFE500","#4ade80","#f9a8d4","#22d3ee","#f87171","#fbbf24","#000000"];

interface RightPanelProps {
  wide: boolean; detached: boolean; dragging: boolean; panelPos: { x: number; y: number };
  panelWidth?: number;
  onDetach: () => void; onDock: () => void; onToggleWide: () => void; onClose: () => void;
  onDragStart: (sx: number, sy: number) => void;
  onDragMove: (cx: number, cy: number) => void;
  onDragEnd: () => void;
  activeTab: "style" | "font"; onTab: (t: "style" | "font") => void;
  subColor: string; subAccentColor: string; subPreset: SubPreset;
  subFontFamily: string; subFontSize: number; subFontWeight: number;
  subEffect: SubTextEffect; subPosition: number; subShadow: boolean;
  subOutline: boolean; subOutlineSize: number;
  setSubPreset: (v: SubPreset) => void; setSubEffect: (v: SubTextEffect) => void;
  setSubFontFamily: (v: string) => void; setSubFontSize: (v: number) => void;
  setSubFontWeight: (v: number) => void; setSubColor: (v: string) => void;
  setSubAccentColor: (v: string) => void; setSubPosition: (v: number) => void;
  setSubShadow: (v: boolean) => void; setSubOutline: (v: boolean) => void;
  setSubOutlineSize: (v: number) => void;
  displayCaptions: Caption[]; activeSegIdx: number;
  ttsProvider: "elevenlabs" | "gemini"; geminiVoiceName: string; voiceId: string;
  setTtsProvider: (v: "elevenlabs" | "gemini") => void;
  setGeminiVoiceName: (v: string) => void; setVoiceId: (v: string) => void;
  bgmEnabled: boolean; bgmFile: string; bgmVolume: number;
  setBgmEnabled: (v: boolean) => void; setBgmFile: (v: string) => void;
  setBgmVolume: (v: number) => void;
  bgmUploading: boolean; setBgmUploading: (v: boolean) => void;
  systemTracks: { id: string; title: string; filename: string }[];
  useAvatar: boolean; avatarId: string; avatarTiming: "full" | "bookend" | "bookend-both";
  avatarBookendSecs: number; avatarTailSecs: number;
  avatarScale: number; avatarOffsetX: number; avatarOffsetY: number;
  avatarPreviewUrl: string; avatarName: string;
  avatarGreenUrl: string; running: boolean; steps: StepState;
  avatarInputMode: "generate" | "direct"; avatarDirectUrl: string;
  setAvatarInputMode: (v: "generate" | "direct") => void; setAvatarDirectUrl: (v: string) => void;
  chromaSimilarity: number; setChromaSimilarity: (v: number) => void;
  chromaBlend: number; setChromaBlend: (v: number) => void;
  setUseAvatar: (v: boolean) => void; setAvatarId: (v: string) => void;
  setAvatarTiming: (v: "full" | "bookend" | "bookend-both") => void;
  setAvatarBookendSecs: (v: number) => void; setAvatarTailSecs: (v: number) => void;
  setAvatarScale: (v: number) => void; setAvatarOffsetX: (v: number) => void;
  setAvatarOffsetY: (v: number) => void;
  runAvatarPipeline: () => void; pipeRenderedVideoUrl?: string;
  projectName: string; onSaveTemplate: () => void;
  onPlanError?: (msg: string) => void;
}

function DirectAvatarUpload({ onUrl, onPlanError }: { onUrl: (url: string) => void; onPlanError?: (msg: string) => void }) {
  const [uploading, setUploading] = React.useState(false);
  const [progress, setProgress] = React.useState(0);

  async function handleFile(file: File) {
    if (!["mp4", "mov", "webm"].includes(file.name.split(".").pop()?.toLowerCase() ?? "")) {
      toast.error("รองรับเฉพาะ mp4 / mov / webm");
      return;
    }
    setUploading(true);
    setProgress(0);
    try {
      // Use XHR for upload progress on large files
      await new Promise<void>((resolve, reject) => {
        const fd = new FormData();
        fd.append("file", file);
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/videos/upload-avatar");
        xhr.upload.onprogress = e => { if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100)); };
        xhr.onload = () => {
          if (xhr.status === 200) {
            const data = JSON.parse(xhr.responseText);
            if (data.url) { onUrl(data.url); resolve(); }
            else reject(new Error(data.error ?? "Upload failed"));
          } else if (xhr.status === 403) {
            try {
              const data = JSON.parse(xhr.responseText);
              const err = new Error(data.error ?? "Plan required");
              (err as any)._isPlanError = true;
              (err as any)._planMessage = data.error;
              reject(err);
            } catch { reject(new Error("Plan required")); }
          } else {
            try { reject(new Error(JSON.parse(xhr.responseText).error ?? "Upload failed")); }
            catch { reject(new Error("Upload failed")); }
          }
        };
        xhr.onerror = () => reject(new Error("Network error"));
        xhr.send(fd);
      });
      toast.success("อัปโหลดสำเร็จ");
    } catch (e) {
      if (e instanceof Error && (e as any)._isPlanError) {
        onPlanError?.(((e as any)._planMessage) ?? "");
      } else {
        toast.error(e instanceof Error ? e.message : "อัปโหลดไม่สำเร็จ");
      }
    } finally {
      setUploading(false);
      setProgress(0);
    }
  }

  return (
    <label className={cn("flex flex-col items-center justify-center gap-1.5 rounded-lg py-3 cursor-pointer transition-colors border border-dashed border-[#3a3a4a] bg-[#1a1a22]", uploading && "pointer-events-none opacity-70")}>
      <input type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
        disabled={uploading} />
      {uploading ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin text-violet-400" />
          <span className="text-[10px] text-slate-500">กำลังอัปโหลด {progress}%</span>
          <div className="w-full px-4">
            <div className="h-1 rounded-full bg-[#2a2a36] overflow-hidden">
              <div className="h-full bg-violet-500 rounded-full transition-all" style={{ width: `${progress}%` }} />
            </div>
          </div>
        </>
      ) : (
        <>
          <Upload className="h-4 w-4 text-slate-600" />
          <span className="text-[10px] text-slate-600">อัปโหลดไฟล์วิดีโอ green screen</span>
          <span className="text-[9px] text-slate-700">mp4 / mov / webm · รองรับถึง 10 นาที</span>
        </>
      )}
    </label>
  );
}

interface OrderPanelProps {
  open: boolean; onToggle: () => void;
  ttsProvider: "elevenlabs" | "gemini"; geminiVoiceName: string; voiceId: string;
  setTtsProvider: (v: "elevenlabs" | "gemini") => void;
  setGeminiVoiceName: (v: string) => void; setVoiceId: (v: string) => void;
  bgmEnabled: boolean; bgmFile: string; bgmVolume: number;
  setBgmEnabled: (v: boolean) => void; setBgmFile: (v: string) => void; setBgmVolume: (v: number) => void;
  bgmUploading: boolean; setBgmUploading: (v: boolean) => void;
  systemTracks: { id: string; title: string; filename: string }[];
  useAvatar: boolean; avatarId: string; avatarTiming: "full" | "bookend" | "bookend-both";
  avatarBookendSecs: number; avatarTailSecs: number;
  avatarScale: number; avatarOffsetX: number; avatarOffsetY: number;
  avatarPreviewUrl: string; avatarName: string;
  avatarGreenUrl: string; running: boolean; steps: StepState;
  avatarInputMode: "generate" | "direct"; avatarDirectUrl: string;
  setAvatarInputMode: (v: "generate" | "direct") => void; setAvatarDirectUrl: (v: string) => void;
  chromaSimilarity: number; setChromaSimilarity: (v: number) => void;
  chromaBlend: number; setChromaBlend: (v: number) => void;
  setUseAvatar: (v: boolean) => void; setAvatarId: (v: string) => void;
  setAvatarTiming: (v: "full" | "bookend" | "bookend-both") => void;
  setAvatarBookendSecs: (v: number) => void; setAvatarTailSecs: (v: number) => void;
  setAvatarScale: (v: number) => void; setAvatarOffsetX: (v: number) => void; setAvatarOffsetY: (v: number) => void;
  runAvatarPipeline: () => void; pipeRenderedVideoUrl?: string;
  onPlanError?: (msg: string) => void;
  stockSource: "pexels" | "pixabay" | "both";
  setStockSource: (v: "pexels" | "pixabay" | "both") => void;
}

function OrderPanel(p: OrderPanelProps) {
  const posCanvasRef = React.useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = React.useState(false);

  function updatePosFromPointer(clientX: number, clientY: number) {
    const el = posCanvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width - 0.5) * 2;
    const ny = -((clientY - rect.top) / rect.height - 0.5) * 2;
    p.setAvatarOffsetX(Math.max(-2, Math.min(2, Math.round(nx * 100) / 100)));
    p.setAvatarOffsetY(Math.max(-2, Math.min(2, Math.round(ny * 100) / 100)));
  }

  return (
    <div className="flex-shrink-0 border-r border-[#1e1e28] flex flex-col h-full bg-[#111115]" style={{ width: p.open ? 260 : 32 }}>
      {/* Header */}
      <div className="h-11 flex items-center justify-between px-3 border-b border-[#1e1e28] flex-shrink-0">
        {p.open && <span className="text-[12px] font-bold text-slate-300">Pipeline</span>}
        <button onClick={p.onToggle} className="ml-auto w-6 h-6 flex items-center justify-center text-slate-600 hover:text-slate-300 transition-colors rounded">
          <span className="text-[11px]">{p.open ? "◀" : "▶"}</span>
        </button>
      </div>
      {p.open && (
        <div className="flex-1 overflow-y-auto p-3 space-y-4 scrollbar-none">
          {/* Stock Source */}
          <div>
            <div className="text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-2">Stock Source</div>
            <div className="flex gap-1.5">
              {(["pexels", "pixabay", "both"] as const).map(src => (
                <button key={src} onClick={() => p.setStockSource(src)}
                  className={cn("flex-1 py-2 rounded-lg border text-[11px] font-bold transition-all",
                    p.stockSource === src ? "bg-violet-500/15 border-violet-500/45 text-violet-300" : "bg-[#1a1a22] border-[#2a2a36] text-slate-500 hover:text-slate-300")}>
                  {src === "pexels" ? "Pexels" : src === "pixabay" ? "Pixabay" : "Both"}
                </button>
              ))}
            </div>
          </div>

          {/* TTS — ซ่อนเมื่อ Direct URL */}
          {p.avatarInputMode !== "direct" ? (
          <div>
            <div className="text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-2">Voice</div>
            <div className="flex gap-1.5">
              {(["gemini","elevenlabs"] as const).map(pv => (
                <button key={pv} onClick={() => p.setTtsProvider(pv)}
                  className={cn("flex-1 py-2 rounded-lg border text-[11px] font-bold transition-all",
                    p.ttsProvider === pv ? "bg-violet-500/15 border-violet-500/45 text-violet-300" : "bg-[#1a1a22] border-[#2a2a36] text-slate-500")}>
                  {pv === "gemini" ? "Gemini" : "ElevenLabs"}
                </button>
              ))}
            </div>
            {p.ttsProvider === "gemini" && (
              <div className="mt-2 space-y-1.5">
                <div className="text-[10px] text-slate-600">Gemini Voice</div>
                <div className="relative">
                  <select value={p.geminiVoiceName} onChange={e => p.setGeminiVoiceName(e.target.value)}
                    className="w-full bg-[#1a1a22] border border-[#2a2a36] rounded-lg px-3 py-2 text-[11px] text-slate-200 appearance-none cursor-pointer outline-none">
                    {GEMINI_VOICES.map(v => (
                      <option key={v.id} value={v.id} style={{ background: "#1a1a2e" }}>
                        {v.label} — {v.gender === "Female" ? "หญิง" : "ชาย"}, {v.style}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-slate-500" />
                </div>
                {(() => { const v = GEMINI_VOICES.find(x => x.id === p.geminiVoiceName); return v ? (
                  <div className="rounded-lg px-2.5 py-2 flex items-center gap-2 bg-violet-500/5 border border-violet-500/15">
                    <span className="text-[10px] font-bold text-slate-300">{v.label}</span>
                    <span className="text-[9px] text-slate-600">{v.gender === "Female" ? "หญิง" : "ชาย"} · {v.style}</span>
                  </div>
                ) : null; })()}
              </div>
            )}
            {p.ttsProvider === "elevenlabs" && (
              <div className="mt-2">
                <div className="text-[10px] text-slate-600 mb-1">Voice ID</div>
                <input value={p.voiceId} onChange={e => p.setVoiceId(e.target.value)} placeholder="ElevenLabs Voice ID"
                  className="w-full bg-[#1a1a22] border border-[#2a2a36] rounded-lg px-2 py-1.5 text-[11px] text-slate-300 outline-none" />
              </div>
            )}
          </div>
          ) : (
          <div className="rounded-lg px-3 py-2.5 bg-[#1a1a22] border border-[#2a2a36]">
            <div className="text-[10px] text-slate-600 font-bold uppercase tracking-wider mb-0.5">Voice</div>
            <div className="text-[10px] text-slate-700">ข้าม — เสียงอยู่ใน Direct URL วิดีโอ</div>
          </div>
          )}

          {/* BGM */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">Background Music</div>
              <button onClick={() => p.setBgmEnabled(!p.bgmEnabled)}
                className={cn("w-9 h-5 rounded-full transition-colors flex-shrink-0 relative", p.bgmEnabled ? "bg-violet-600" : "bg-[#2a2a36]")}>
                <div className={cn("absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all", p.bgmEnabled ? "left-5" : "left-0.5")} />
              </button>
            </div>
            {p.bgmEnabled && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-600 w-14 shrink-0">Volume</span>
                  <input type="range" min={0} max={1} step={0.01} value={p.bgmVolume} onChange={e => p.setBgmVolume(Number(e.target.value))} className="flex-1 accent-violet-400 h-1" />
                  <span className="text-[10px] font-mono text-violet-400 w-8 text-right">{Math.round(p.bgmVolume * 100)}%</span>
                </div>
                {p.systemTracks.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[9px] font-bold uppercase tracking-widest text-slate-700">System Tracks</div>
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                      {p.systemTracks.map(t => (
                        <button key={t.id} onClick={() => p.setBgmFile(p.bgmFile === `/music/${t.filename}` ? "" : `/music/${t.filename}`)}
                          className={cn("w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11px] transition-all border",
                            p.bgmFile === `/music/${t.filename}` ? "bg-violet-500/15 border-violet-500/40 text-violet-300" : "bg-[#1a1a22] border-[#2a2a36] text-slate-500 hover:border-[#3a3a4a]")}>
                          <Music className="h-3 w-3 shrink-0" />
                          <span className="truncate">{t.title}</span>
                          {p.bgmFile === `/music/${t.filename}` && <span className="ml-auto text-violet-400">✓</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="space-y-1">
                  <div className="text-[9px] font-bold uppercase tracking-widest text-slate-700">Upload Music</div>
                  <label className={cn("flex items-center justify-center gap-2 rounded-lg py-2 cursor-pointer border border-dashed border-[#3a3a4a] bg-[#1a1a22]", p.bgmUploading && "opacity-50 pointer-events-none")}>
                    <input type="file" accept="audio/*,.mp3,.wav,.ogg,.aac,.m4a" className="hidden"
                      onChange={async (e) => {
                        const f = e.target.files?.[0]; if (!f) return;
                        p.setBgmUploading(true);
                        try {
                          const fd = new FormData(); fd.append("file", f);
                          const res = await fetch("/api/music/upload", { method: "POST", body: fd });
                          const data = await res.json();
                          if (res.status === 403) { p.onPlanError?.(data.error ?? "ฟีเจอร์นี้ใช้ได้เฉพาะแผน Pro"); }
                          else if (data.url) { p.setBgmFile(data.url); toast.success("อัปโหลดสำเร็จ"); }
                          else toast.error(data.error ?? "อัปโหลดไม่สำเร็จ");
                        } catch { toast.error("อัปโหลดไม่สำเร็จ"); }
                        finally { p.setBgmUploading(false); e.target.value = ""; }
                      }} />
                    {p.bgmUploading
                      ? <><Loader2 className="h-3.5 w-3.5 animate-spin text-violet-400" /><span className="text-[10px] text-slate-600">กำลังอัปโหลด...</span></>
                      : <><Upload className="h-3.5 w-3.5 text-slate-600" /><span className="text-[10px] text-slate-600">เลือกไฟล์เสียง</span></>}
                  </label>
                  {p.bgmFile && !p.systemTracks.some(t => `/music/${t.filename}` === p.bgmFile) && (
                    <div className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 bg-violet-500/10 border border-violet-500/25">
                      <Music className="h-3 w-3 text-violet-400/60 shrink-0" />
                      <span className="text-[10px] text-violet-300 truncate flex-1">{p.bgmFile.split("/").pop()}</span>
                      <button onClick={() => p.setBgmFile("")} className="text-slate-600 hover:text-slate-400"><X className="h-3 w-3" /></button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Avatar */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">Avatar (HeyGen)</div>
              <button onClick={() => p.setUseAvatar(!p.useAvatar)}
                className={cn("w-9 h-5 rounded-full transition-colors flex-shrink-0 relative", p.useAvatar ? "bg-violet-600" : "bg-[#2a2a36]")}>
                <div className={cn("absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all", p.useAvatar ? "left-5" : "left-0.5")} />
              </button>
            </div>
            {p.useAvatar && (
              <div className="space-y-3">
                <div className="flex gap-1 rounded-lg p-0.5 bg-[#1a1a22] border border-[#2a2a36]">
                  {(["generate", "direct"] as const).map(mode => (
                    <button key={mode} onClick={() => p.setAvatarInputMode(mode)}
                      className={cn("flex-1 py-1 rounded-md text-[10px] font-bold transition-all border",
                        p.avatarInputMode === mode ? "bg-violet-500/15 border-violet-500/40 text-violet-300" : "bg-transparent border-transparent text-slate-500 hover:text-slate-400")}>
                      {mode === "generate" ? "Generate" : "Direct URL"}
                    </button>
                  ))}
                </div>

                {p.avatarInputMode === "generate" ? (
                  <>
                    <div className="space-y-1.5">
                      <div className="text-[10px] text-slate-600 font-bold uppercase tracking-wider">Heygen Avatar ID</div>
                      <input value={p.avatarId} onChange={e => p.setAvatarId(e.target.value)} placeholder="ID: josh_lite_2023..."
                        className="w-full bg-[#1a1a22] border border-[#2a2a36] rounded-lg px-3 py-2 text-[11px] font-mono text-slate-300 outline-none" />
                      {(p.avatarPreviewUrl || p.avatarName) && (
                        <div className="flex items-center gap-2 rounded-lg px-2.5 py-2 bg-[#1a1a22] border border-[#2a2a36]">
                          {p.avatarPreviewUrl && <img src={p.avatarPreviewUrl} className="h-8 w-8 rounded-md object-cover shrink-0" />}
                          <div className="min-w-0">
                            <p className="text-[11px] font-semibold text-white/80 truncate">{p.avatarName}</p>
                            <p className="text-[9px] font-bold text-green-400">● VERIFIED STABLE</p>
                          </div>
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-600 mb-1.5 font-bold uppercase tracking-wider">Avatar Timing</div>
                      <div className="flex gap-1.5">
                        {(["full","bookend","bookend-both"] as const).map(mode => (
                          <button key={mode} onClick={() => p.setAvatarTiming(mode)}
                            className={cn("flex-1 py-1.5 rounded-lg text-[9px] font-bold transition-all border",
                              p.avatarTiming === mode ? "bg-violet-500/15 border-violet-500/45 text-violet-300" : "bg-[#1a1a22] border-[#2a2a36] text-slate-500 hover:border-[#3a3a4a]")}>
                            {mode === "full" ? "Full" : mode === "bookend" ? "Intro" : "Intro+Outro"}
                          </button>
                        ))}
                      </div>
                    </div>
                    {(p.avatarTiming === "bookend" || p.avatarTiming === "bookend-both") && (
                      <div className="bg-violet-500/5 border border-violet-500/15 rounded-lg px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                        <span className="text-[10px] text-slate-500 shrink-0">Intro</span>
                        <input type="number" min={1} max={30} value={p.avatarBookendSecs} onChange={e => p.setAvatarBookendSecs(Math.max(1, Math.min(30, Number(e.target.value))))}
                          className="w-12 bg-[#1a1a22] border border-[#2a2a36] rounded px-1.5 py-1 text-[11px] text-violet-300 outline-none text-center" />
                        <span className="text-[10px] text-slate-600">s</span>
                        {p.avatarTiming === "bookend-both" && (<>
                          <span className="text-[10px] text-slate-500 shrink-0">Outro</span>
                          <input type="number" min={1} max={30} value={p.avatarTailSecs} onChange={e => p.setAvatarTailSecs(Math.max(1, Math.min(30, Number(e.target.value))))}
                            className="w-12 bg-[#1a1a22] border border-[#2a2a36] rounded px-1.5 py-1 text-[11px] text-violet-300 outline-none text-center" />
                          <span className="text-[10px] text-slate-600">s</span>
                        </>)}
                      </div>
                    )}
                    {/* Position canvas — copy จาก video-creator */}
                    <div>
                      <div className="text-[10px] text-slate-600 mb-2 font-bold uppercase tracking-wider">Avatar Position</div>
                      <div className="flex flex-col gap-3">
                        <div ref={posCanvasRef}
                          className="relative w-full rounded-lg overflow-hidden cursor-crosshair select-none"
                          style={{ aspectRatio: "720/1280", background: "#080e1c", border: "1px solid #2a2a36" }}
                          onMouseDown={(e) => { setIsDragging(true); updatePosFromPointer(e.clientX, e.clientY); }}
                          onMouseMove={(e) => { if (isDragging) updatePosFromPointer(e.clientX, e.clientY); }}
                          onMouseUp={() => setIsDragging(false)} onMouseLeave={() => setIsDragging(false)}
                          onTouchStart={(e) => { setIsDragging(true); updatePosFromPointer(e.touches[0].clientX, e.touches[0].clientY); }}
                          onTouchMove={(e) => { if (isDragging) updatePosFromPointer(e.touches[0].clientX, e.touches[0].clientY); }}
                          onTouchEnd={() => setIsDragging(false)}
                        >
                          {[25,50,75].map(v => <div key={`gv${v}`} className="absolute top-0 bottom-0 pointer-events-none" style={{ left:`${v}%`, width:1, background:v===50?"rgba(255,255,255,0.18)":"rgba(255,255,255,0.05)" }} />)}
                          {[25,50,75].map(v => <div key={`gh${v}`} className="absolute left-0 right-0 pointer-events-none" style={{ top:`${v}%`, height:1, background:v===50?"rgba(255,255,255,0.18)":"rgba(255,255,255,0.05)" }} />)}
                          <div className="absolute top-1.5 left-1.5 bg-black/75 text-[8px] text-white/80 px-1.5 py-1 rounded font-mono pointer-events-none leading-snug">
                            X: {p.avatarOffsetX.toFixed(2)}<br />Y: {p.avatarOffsetY.toFixed(2)}<br />SCALE: {p.avatarScale.toFixed(2)}
                          </div>
                          {p.avatarPreviewUrl && (
                            <div className="absolute pointer-events-none overflow-hidden" style={{ width:`${p.avatarScale*62}%`, aspectRatio:"15/16", left:`${50+p.avatarOffsetX*50}%`, bottom:`${(0.09-p.avatarOffsetY)*50}%`, transform:"translateX(-50%)", outline:"1px solid rgba(99,179,237,0.4)" }}>
                              <img src={p.avatarPreviewUrl} draggable={false} className="w-full h-full" style={{ objectFit:"cover", objectPosition:"center 130%" }} />
                            </div>
                          )}
                          {p.avatarGreenUrl && (
                            <video src={p.avatarGreenUrl} className="absolute inset-0 w-full h-full object-cover pointer-events-none" style={{ mixBlendMode:"screen", opacity:0.85 }} muted loop autoPlay playsInline />
                          )}
                          <div className="absolute w-2.5 h-2.5 rounded-full border-2 border-cyan-400 bg-cyan-500/50 pointer-events-none" style={{ left:`${50+p.avatarOffsetX*50}%`, bottom:`${(-0.05-p.avatarOffsetY)*50}%`, transform:"translate(-50%, 50%)" }} />
                        </div>
                        {/* Sliders */}
                        <div className="space-y-2">
                          {([
                            { label:"Offset X", value:p.avatarOffsetX, onChange:p.setAvatarOffsetX, min:-2, max:2, step:0.01 },
                            { label:"Offset Y", value:p.avatarOffsetY, onChange:p.setAvatarOffsetY, min:-2, max:2, step:0.01 },
                            { label:"Scale",    value:p.avatarScale,   onChange:p.setAvatarScale,   min:0.1, max:5.0, step:0.01 },
                          ] as const).map(({label,value,onChange,min,max,step})=>(
                            <div key={label} className="space-y-1">
                              <div className="flex justify-between">
                                <span className="text-[9px] font-bold uppercase tracking-widest text-slate-600">{label}</span>
                                <span className="text-[9px] font-mono text-cyan-400">{value.toFixed(2)}</span>
                              </div>
                              <input type="range" min={min} max={max} step={step} value={value} onChange={e=>onChange(Number(e.target.value))} className="w-full accent-cyan-400 h-1" />
                            </div>
                          ))}
                          <button onClick={()=>{p.setAvatarOffsetX(0);p.setAvatarOffsetY(0.13);p.setAvatarScale(2.02);}} className="text-[9px] text-slate-600 hover:text-slate-400 w-full text-center">↺ Reset</button>
                        </div>
                      </div>
                    </div>
                    {p.avatarGreenUrl && <div className="text-[10px] text-emerald-400 truncate">✓ {p.avatarGreenUrl.split("/").pop()}</div>}
                  </>
                ) : (
                  <div className="space-y-2">
                    <div className="text-[10px] text-slate-500 bg-violet-500/5 border border-violet-500/15 rounded-lg px-2.5 py-2 leading-relaxed">วิดีโอ green screen + เสียง — chromakey อัตโนมัติหลัง Render</div>
                    <div className="text-[10px] text-slate-600 font-bold uppercase tracking-wider">URL or Upload File</div>
                    <div className="relative flex items-center">
                      <input value={p.avatarDirectUrl} onChange={e => p.setAvatarDirectUrl(e.target.value)} placeholder="https://... หรือ URL วิดีโอ green screen"
                        className="w-full bg-[#1a1a22] border border-[#2a2a36] rounded-lg px-3 py-2 text-[11px] text-slate-300 outline-none pr-7" />
                      {p.avatarDirectUrl && <button onClick={() => p.setAvatarDirectUrl("")} className="absolute right-2 text-slate-600 hover:text-slate-400"><X className="h-3 w-3" /></button>}
                    </div>
                    <DirectAvatarUpload onUrl={p.setAvatarDirectUrl} onPlanError={(msg) => p.onPlanError?.(msg)} />
                    {p.avatarDirectUrl.trim() && <video src={p.avatarDirectUrl.trim()} controls className="w-full rounded-lg" style={{ maxHeight: 180, background: "#000" }} />}
                  </div>
                )}

                {/* Background Removal */}
                <div className="rounded-lg overflow-hidden" style={{ border: "1px solid hsl(120 60% 40% / 0.2)", background: "hsl(120 60% 10% / 0.15)" }}>
                  <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: "1px solid hsl(120 60% 40% / 0.12)" }}>
                    <div className="flex items-center gap-1.5">
                      <span className="text-green-400/70 text-[11px]">✦</span>
                      <span className="text-[9px] font-bold uppercase tracking-widest text-green-400/60">Background Removal</span>
                    </div>
                    <span className="text-[8px] text-white/20">ปรับก่อน Composite</span>
                  </div>
                  <div className="p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-white/35 w-16 shrink-0">Green</span>
                      <div className="flex items-center gap-1.5 rounded px-2 py-0.5" style={{ background: "#0a1a0a", border: "1px solid hsl(120 60% 40% / 0.3)" }}>
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: "#00FF00" }} />
                        <span className="text-[9px] font-mono text-green-400">#00FF00</span>
                      </div>
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-white/35 w-16 shrink-0">Similarity</span>
                        <input type="range" min={0.10} max={0.55} step={0.01} value={p.chromaSimilarity} onChange={e => p.setChromaSimilarity(Number(e.target.value))} className="flex-1 accent-green-400 h-1" />
                        <span className="text-[9px] font-mono text-green-400 w-7 text-right">{p.chromaSimilarity.toFixed(2)}</span>
                      </div>
                      <p className="text-[8px] text-white/20 pl-[72px]">เขียวยังมี → เพิ่ม | ผิวหาย → ลด</p>
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-white/35 w-16 shrink-0">Blend</span>
                        <input type="range" min={0.00} max={0.20} step={0.01} value={p.chromaBlend} onChange={e => p.setChromaBlend(Number(e.target.value))} className="flex-1 accent-green-400 h-1" />
                        <span className="text-[9px] font-mono text-green-400 w-7 text-right">{p.chromaBlend.toFixed(2)}</span>
                      </div>
                      <p className="text-[8px] text-white/20 pl-[72px]">ขอบหยัก → เพิ่ม | ขอบนิ่ม → ลด</p>
                    </div>
                  </div>
                </div>

                {/* Direct mode status */}
                {p.avatarInputMode === "direct" && (
                  <div className={cn("text-[10px] text-center py-1.5 rounded-lg border",
                    p.steps.composite==="running" ? "text-violet-400 border-violet-500/30 bg-violet-500/5"
                    : p.steps.composite==="done" ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/5"
                    : "text-slate-600 border-[#2a2a36]")}>
                    {p.steps.composite==="running"?"⏳ กำลัง Composite...":p.steps.composite==="done"?"✓ Composite เสร็จแล้ว":"Composite อัตโนมัติหลัง Render"}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RightSettingsPanel(p: RightPanelProps) {
  const cols4 = p.detached || (p.panelWidth !== undefined ? p.panelWidth >= 420 : p.wide);

  return (
    <div
      className={cn("flex flex-col overflow-hidden", p.detached ? "h-full" : "h-full bg-[#111115]")}
      style={!p.detached && p.panelWidth ? { width: p.panelWidth } : undefined}
    >
      {/* Header */}
      <div
        className="px-4 h-11 flex items-center justify-between border-b border-[#1e1e28] flex-shrink-0 gap-1 select-none"
        style={p.detached ? { cursor: p.dragging ? "grabbing" : "grab", background: "#0e0e13" } : undefined}
        onPointerDown={p.detached ? e => { e.currentTarget.setPointerCapture(e.pointerId); p.onDragStart(e.clientX, e.clientY); } : undefined}
        onPointerMove={p.detached ? e => { if (e.buttons !== 1) return; p.onDragMove(e.clientX, e.clientY); } : undefined}
        onPointerUp={p.detached ? () => p.onDragEnd() : undefined}
        onPointerCancel={p.detached ? () => p.onDragEnd() : undefined}
      >
        <span className="font-bold text-[13px]">
          Settings {p.detached && <span className="text-[9px] text-slate-600 font-normal ml-1">⠿ ลากได้</span>}
        </span>
        <div className="flex items-center gap-0.5 ml-auto">
          <button onClick={p.onToggleWide}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-600 hover:bg-[#1e1e28] hover:text-slate-300 transition-colors"
            title={p.wide ? "ย่อ panel" : "ขยาย panel"}>
            <span className="text-[13px] leading-none">{p.wide ? "▶" : "◀"}</span>
          </button>
          <button onClick={p.onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-600 hover:bg-[#1e1e28] hover:text-slate-300 transition-colors" title="ซ่อน panel">
            <span className="text-[14px] leading-none">✕</span>
          </button>
        </div>
      </div>

      {/* Live subtitle preview strip */}
      <div className="border-b border-[#1e1e28] bg-[#0e0e13] flex-shrink-0 flex items-center justify-center py-3 px-4 min-h-[52px]">
        {(() => {
          const cap = p.displayCaptions[p.activeSegIdx] ?? p.displayCaptions[0];
          if (!cap) return <span className="text-[10px] text-slate-700">Type script to preview</span>;
          return (
            <div className="text-center leading-none">
              {renderSubEl(cap.text, p.subColor, p.subAccentColor, cap.tag === "hook", p.subPreset, p.subFontFamily, p.subFontSize, p.subFontWeight, 220 / 1080)}
            </div>
          );
        })()}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[#1e1e28] flex-shrink-0 overflow-x-auto scrollbar-none">
        {([ ["style","สไตล์"], ["font","Font"] ] as ["style"|"font", string][]).map(([tab, label]) => (
          <button key={tab} onClick={() => p.onTab(tab)}
            className={cn("px-3 py-2.5 text-[11px] font-bold whitespace-nowrap transition-colors border-b-2",
              p.activeTab === tab ? "text-violet-300 border-violet-500" : "text-slate-600 border-transparent hover:text-slate-300")}>
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4 scrollbar-thin scrollbar-thumb-[#2a2a36]">

        <button onClick={p.onSaveTemplate}
          className="w-full py-2 rounded-lg border border-dashed border-violet-500/30 bg-violet-500/5 text-violet-400 text-[11px] font-bold hover:bg-violet-500/10 transition-colors flex items-center justify-center gap-1.5">
          <Plus className="w-3 h-3" /> Save as Template
        </button>

        <div className="flex items-center gap-2 bg-[#1a1a22] border border-[#2a2a36] rounded-lg px-3 py-2">
          <Lock className="w-3 h-3 text-slate-600" />
          <span className="text-[11px] text-slate-500">Editing selected segment only</span>
        </div>

        {p.activeTab === "style" && (
          <>
            <div>
              <div className="text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-2">Caption Style</div>
              <div className={cn("grid gap-1.5", cols4 ? "grid-cols-4" : "grid-cols-2")}>
                {PRESETS_DATA.map(pr => {
                  const isSelected = p.subPreset === pr.value;
                  return (
                    <button key={pr.value} onClick={() => p.setSubPreset(pr.value)}
                      className="flex flex-col items-center gap-1 rounded-xl py-2 px-1 transition-all"
                      style={isSelected
                        ? { background: "hsl(190 100% 50% / 0.12)", border: "1px solid hsl(190 100% 50% / 0.5)" }
                        : { background: "#1a1a22", border: "1px solid #2a2a36" }}>
                      <div className="w-full h-9 flex items-center justify-center rounded-lg overflow-hidden" style={{ background: "rgba(0,0,0,0.45)" }}>
                        {renderSubEl("ตัวอย่าง", p.subColor, p.subAccentColor, false, pr.value, p.subFontFamily, Math.round(p.subFontSize * 0.38), p.subFontWeight, 1)}
                      </div>
                      <span className="text-[9px] font-medium leading-tight text-center"
                        style={{ color: isSelected ? "hsl(190 100% 65%)" : "rgba(148,163,184,0.55)" }}>
                        {pr.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <style dangerouslySetInnerHTML={{ __html: EFFECT_KEYFRAMES }} />
              <div className="text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-2">Text Animation</div>
              <div className={cn("grid gap-1.5", cols4 ? "grid-cols-4" : "grid-cols-2")}>
                {EFFECTS_DATA.map(ef => (
                  <EffectPreviewCard
                    key={ef.value}
                    effect={ef.value}
                    label={ef.label}
                    desc={ef.desc}
                    color={p.subColor}
                    accentColor={p.subAccentColor}
                    fontFamily={p.subFontFamily}
                    selected={p.subEffect === ef.value}
                    onClick={() => p.setSubEffect(ef.value)}
                  />
                ))}
              </div>
            </div>
          </>
        )}

        {p.activeTab === "font" && (
          <>
            <div>
              <div className="text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-2">Font</div>
              <div className="relative">
                <select value={p.subFontFamily} onChange={e => p.setSubFontFamily(e.target.value)}
                  className="w-full bg-[#1a1a22] border border-[#2a2a36] rounded-lg px-3 py-2.5 text-[12px] font-semibold text-slate-200 appearance-none cursor-pointer hover:border-[#3a3a4a] transition-colors outline-none">
                  {FONTS_LIST.map(f => <option key={f.value} value={f.value} style={{ background: "#1a1a2e" }}>{f.label}</option>)}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500 pointer-events-none" />
              </div>
              {/* Font preview */}
              <div className="mt-2 rounded-lg px-3 py-2.5 bg-black/40 border border-[#2a2a36] text-center"
                style={{ fontFamily: p.subFontFamily, fontSize: 20, fontWeight: p.subFontWeight, color: p.subColor }}>
                สวัสดี Hello 123
              </div>
            </div>
            <div>
              <div className="text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-2">Size</div>
              <SliderRow value={p.subFontSize} min={30} max={160} onChange={p.setSubFontSize} unit="px" />
            </div>
            <div>
              <div className="text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-2">Style</div>
              <div className="flex gap-1.5">
                <button onClick={() => p.setSubFontWeight(p.subFontWeight >= 700 ? 400 : 900)}
                  className={cn("px-3 py-2 rounded-lg border text-[12px] font-black transition-all",
                    p.subFontWeight >= 700 ? "bg-violet-500/15 border-violet-500/45 text-violet-300" : "bg-[#1a1a22] border-[#2a2a36] text-slate-500")}>B</button>
                <button onClick={() => p.setSubShadow(!p.subShadow)}
                  className={cn("px-3 py-2 rounded-lg border text-[12px] font-bold transition-all",
                    p.subShadow ? "bg-violet-500/15 border-violet-500/45 text-violet-300" : "bg-[#1a1a22] border-[#2a2a36] text-slate-500")}>Shadow</button>
                <button onClick={() => p.setSubOutline(!p.subOutline)}
                  className={cn("px-3 py-2 rounded-lg border text-[12px] font-bold transition-all",
                    p.subOutline ? "bg-violet-500/15 border-violet-500/45 text-violet-300" : "bg-[#1a1a22] border-[#2a2a36] text-slate-500")}>Outline</button>
              </div>
            </div>
            {/* Colors — same logic as video-creator */}
            {(() => {
              const LOCKED_COLOR = ["classic-yellow","hormozi","beast","neon-green","neon-red","neon-blue","pastel","retro","box-white","box-yellow","news"];
              const LOCKED_ACCENT = ["neon-green","neon-red","neon-blue","pastel","classic-yellow","hormozi","beast","box-white","box-yellow","retro","news","karaoke-box"];
              const isAccentLocked = LOCKED_ACCENT.includes(p.subPreset);
              const effectUsesAccent = !isAccentLocked && (p.subEffect === "highlight" || p.subEffect === "karaoke");
              const hookUsesAccent = !isAccentLocked;
              const showAccent = effectUsesAccent || hookUsesAccent;
              const accentLabel = p.subEffect === "highlight" ? "Accent (Highlight) · Hook & CTA"
                : p.subEffect === "karaoke" ? "Accent (Karaoke) · Hook & CTA"
                : "Accent · Hook & CTA";
              const SWATCHES = ["#FFFFFF","#FFE500","#FF4444","#00CFFF","#FF9500","#00FF87","#FF00FF","#000000"];
              return ([
                ...(LOCKED_COLOR.includes(p.subPreset) ? [] : [{ label: "Text Color", val: p.subColor, set: p.setSubColor }]),
                ...(showAccent ? [{ label: accentLabel, val: p.subAccentColor, set: p.setSubAccentColor }] : []),
              ] as { label: string; val: string; set: (v: string) => void }[]).map(({ label, val, set }) => (
                <div key={label}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">{label}</div>
                    <span className="text-[10px] font-mono font-bold" style={{ color: val }}>{val}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 items-center">
                    {SWATCHES.map(c => (
                      <button key={c} onClick={() => set(c)}
                        className="rounded-lg transition-all flex-shrink-0"
                        style={{ width:24, height:24, background:c,
                          border: val===c ? "2px solid hsl(190 100% 60%)" : "2px solid transparent",
                          boxShadow: val===c ? "0 0 0 1px hsl(190 100% 60% / 0.5)" : "inset 0 0 0 1px rgba(255,255,255,0.1)" }} />
                    ))}
                    <label className="relative cursor-pointer flex-shrink-0">
                      <input type="color" value={val} onChange={e => set(e.target.value)} className="absolute opacity-0 w-0 h-0" />
                      <span className="flex items-center justify-center rounded-lg text-[11px] font-bold text-slate-500 hover:text-slate-300 transition-colors"
                        style={{ width:24, height:24, background:"#1a1a22", border:"1.5px dashed rgba(255,255,255,0.2)" }}>+</span>
                    </label>
                  </div>
                </div>
              ));
            })()}
            {p.subOutline && (
              <div>
                <div className="text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-2">Outline Size</div>
                <SliderRow value={p.subOutlineSize} min={1} max={8} onChange={p.setSubOutlineSize} unit="px" />
              </div>
            )}
            <div>
              <div className="text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-2">Vertical Position</div>
              <SliderRow value={p.subPosition} min={10} max={95} onChange={p.setSubPosition} unit="%" />
              <div className="grid grid-cols-3 gap-1 mt-2">
                {([["Top","↑",20],["Mid","·",55],["Bot","↓",82]] as [string,string,number][]).map(([label, icon, val]) => (
                  <button key={label} onClick={() => p.setSubPosition(val)}
                    className={cn("py-2 rounded-lg border text-[10px] font-bold transition-all",
                      p.subPosition === val ? "bg-violet-500/15 border-violet-500/45 text-violet-300" : "bg-[#1a1a22] border-[#2a2a36] text-slate-500 hover:border-[#3a3a4a]")}>
                    {icon} {label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {false && (
          <>
            <div>
              <div className="text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-2">Voice</div>
              <div className="flex gap-1.5">
                {(["gemini","elevenlabs"] as const).map(pv => (
                  <button key={pv} onClick={() => p.setTtsProvider(pv)}
                    className={cn("flex-1 py-2 rounded-lg border text-[11px] font-bold transition-all",
                      p.ttsProvider === pv ? "bg-violet-500/15 border-violet-500/45 text-violet-300" : "bg-[#1a1a22] border-[#2a2a36] text-slate-500")}>
                    {pv === "gemini" ? "Gemini" : "ElevenLabs"}
                  </button>
                ))}
              </div>
              {p.ttsProvider === "gemini" && (
                <div className="mt-2">
                  <div className="text-[10px] text-slate-600 mb-1">Gemini Voice</div>
                  <select value={p.geminiVoiceName} onChange={e => p.setGeminiVoiceName(e.target.value)}
                    className="w-full bg-[#1a1a22] border border-[#2a2a36] rounded-lg px-2 py-1.5 text-[11px] text-slate-300 outline-none">
                    {GEMINI_VOICES.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
                  </select>
                </div>
              )}
              {p.ttsProvider === "elevenlabs" && (
                <div className="mt-2">
                  <div className="text-[10px] text-slate-600 mb-1">Voice ID</div>
                  <input value={p.voiceId} onChange={e => p.setVoiceId(e.target.value)} placeholder="ElevenLabs Voice ID"
                    className="w-full bg-[#1a1a22] border border-[#2a2a36] rounded-lg px-2 py-1.5 text-[11px] text-slate-300 outline-none" />
                </div>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">Background Music</div>
                <button onClick={() => p.setBgmEnabled(!p.bgmEnabled)}
                  className={cn("w-9 h-5 rounded-full transition-colors flex-shrink-0 relative", p.bgmEnabled ? "bg-violet-600" : "bg-[#2a2a36]")}>
                  <div className={cn("absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all", p.bgmEnabled ? "left-5" : "left-0.5")} />
                </button>
              </div>
              {p.bgmEnabled && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-600 w-14 shrink-0">Volume</span>
                    <input type="range" min={0} max={1} step={0.01} value={p.bgmVolume}
                      onChange={e => p.setBgmVolume(Number(e.target.value))}
                      className="flex-1 accent-violet-400 h-1" />
                    <span className="text-[10px] font-mono text-violet-400 w-8 text-right">{Math.round(p.bgmVolume * 100)}%</span>
                  </div>
                  {p.systemTracks.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-[9px] font-bold uppercase tracking-widest text-slate-700">System Tracks</div>
                      <div className="space-y-1 max-h-32 overflow-y-auto">
                        {p.systemTracks.map(t => (
                          <button key={t.id} onClick={() => p.setBgmFile(p.bgmFile === `/music/${t.filename}` ? "" : `/music/${t.filename}`)}
                            className={cn("w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11px] transition-all border",
                              p.bgmFile === `/music/${t.filename}`
                                ? "bg-violet-500/15 border-violet-500/40 text-violet-300"
                                : "bg-[#1a1a22] border-[#2a2a36] text-slate-500 hover:border-[#3a3a4a]")}>
                            <Music className="h-3 w-3 shrink-0" />
                            <span className="truncate">{t.title}</span>
                            {p.bgmFile === `/music/${t.filename}` && <span className="ml-auto text-violet-400">✓</span>}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="space-y-1">
                    <div className="text-[9px] font-bold uppercase tracking-widest text-slate-700">Upload Music</div>
                    <label className={cn("flex items-center justify-center gap-2 rounded-lg py-2 cursor-pointer transition-colors border border-dashed border-[#3a3a4a] bg-[#1a1a22]", p.bgmUploading && "opacity-50 pointer-events-none")}>
                      <input type="file" accept="audio/*,.mp3,.wav,.ogg,.aac,.m4a" className="hidden"
                        onChange={async (e) => {
                          const f = e.target.files?.[0];
                          if (!f) return;
                          p.setBgmUploading(true);
                          try {
                            const fd = new FormData();
                            fd.append("file", f);
                            const res = await fetch("/api/music/upload", { method: "POST", body: fd });
                            const data = await res.json();
                            if (data.url) { p.setBgmFile(data.url); toast.success("อัปโหลดสำเร็จ"); }
                            else toast.error(data.error ?? "อัปโหลดไม่สำเร็จ");
                          } catch { toast.error("อัปโหลดไม่สำเร็จ"); }
                          finally { p.setBgmUploading(false); e.target.value = ""; }
                        }} />
                      {p.bgmUploading
                        ? <><Loader2 className="h-3.5 w-3.5 animate-spin text-violet-400" /><span className="text-[10px] text-slate-600">กำลังอัปโหลด...</span></>
                        : <><Upload className="h-3.5 w-3.5 text-slate-600" /><span className="text-[10px] text-slate-600">เลือกไฟล์เสียง (mp3 / wav / m4a)</span></>}
                    </label>
                    {p.bgmFile && !p.systemTracks.some(t => `/music/${t.filename}` === p.bgmFile) && (
                      <div className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 bg-violet-500/10 border border-violet-500/25">
                        <Music className="h-3 w-3 text-violet-400/60 shrink-0" />
                        <span className="text-[10px] text-violet-300 truncate flex-1">{p.bgmFile.split("/").pop()}</span>
                        <button onClick={() => p.setBgmFile("")} className="text-slate-600 hover:text-slate-400"><X className="h-3 w-3" /></button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">Avatar (HeyGen)</div>
                <button onClick={() => p.setUseAvatar(!p.useAvatar)}
                  className={cn("w-9 h-5 rounded-full transition-colors flex-shrink-0 relative", p.useAvatar ? "bg-violet-600" : "bg-[#2a2a36]")}>
                  <div className={cn("absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all", p.useAvatar ? "left-5" : "left-0.5")} />
                </button>
              </div>
              {p.useAvatar && (
                <div className="space-y-3">
                  {/* Mode toggle: Generate vs Direct URL */}
                  <div className="flex gap-1 rounded-lg p-0.5 bg-[#1a1a22] border border-[#2a2a36]">
                    {(["generate", "direct"] as const).map(mode => (
                      <button key={mode} onClick={() => p.setAvatarInputMode(mode)}
                        className={cn("flex-1 py-1 rounded-md text-[10px] font-bold transition-all border",
                          p.avatarInputMode === mode
                            ? "bg-violet-500/15 border-violet-500/40 text-violet-300"
                            : "bg-transparent border-transparent text-slate-500 hover:text-slate-400")}>
                        {mode === "generate" ? "Generate (HeyGen)" : "Direct URL"}
                      </button>
                    ))}
                  </div>

                  {p.avatarInputMode === "generate" ? (
                    <>
                      <input value={p.avatarId} onChange={e => p.setAvatarId(e.target.value)} placeholder="HeyGen Avatar ID"
                        className="w-full bg-[#1a1a22] border border-[#2a2a36] rounded-lg px-3 py-2 text-[11px] text-slate-300 outline-none" />

                      {/* Avatar Timing */}
                      <div>
                        <div className="text-[10px] text-slate-600 mb-1.5 font-bold uppercase tracking-wider">Avatar Timing</div>
                        <div className="flex gap-1.5">
                          {(["full","bookend","bookend-both"] as const).map(mode => (
                            <button key={mode} onClick={() => p.setAvatarTiming(mode)}
                              className={cn("flex-1 py-1.5 rounded-lg text-[9px] font-bold transition-all border",
                                p.avatarTiming === mode ? "bg-violet-500/15 border-violet-500/45 text-violet-300" : "bg-[#1a1a22] border-[#2a2a36] text-slate-500 hover:border-[#3a3a4a]")}>
                              {mode === "full" ? "Full Clip" : mode === "bookend" ? "Intro" : "Intro+Outro"}
                            </button>
                          ))}
                        </div>
                      </div>
                      {(p.avatarTiming === "bookend" || p.avatarTiming === "bookend-both") && (
                        <div className="bg-violet-500/5 border border-violet-500/15 rounded-lg px-3 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
                          <span className="text-[10px] text-slate-500 shrink-0">Intro</span>
                          <input type="number" min={1} max={30} value={p.avatarBookendSecs}
                            onChange={e => p.setAvatarBookendSecs(Math.max(1, Math.min(30, Number(e.target.value))))}
                            className="w-12 bg-[#1a1a22] border border-[#2a2a36] rounded px-1.5 py-1 text-[11px] text-violet-300 outline-none text-center" />
                          <span className="text-[10px] text-slate-600">s</span>
                          {p.avatarTiming === "bookend-both" && (<>
                            <span className="text-[10px] text-slate-500 shrink-0">Outro</span>
                            <input type="number" min={1} max={30} value={p.avatarTailSecs}
                              onChange={e => p.setAvatarTailSecs(Math.max(1, Math.min(30, Number(e.target.value))))}
                              className="w-12 bg-[#1a1a22] border border-[#2a2a36] rounded px-1.5 py-1 text-[11px] text-violet-300 outline-none text-center" />
                            <span className="text-[10px] text-slate-600">s</span>
                          </>)}
                        </div>
                      )}
                    </>
                  ) : (
                    /* Direct URL mode — วิดีโอ green screen พร้อมเสียง */
                    <div className="space-y-2">
                      <div className="text-[10px] text-slate-500 bg-violet-500/5 border border-violet-500/15 rounded-lg px-2.5 py-2 leading-relaxed">
                        วิดีโอ Avatar พื้นหลังสีเขียว (green screen) + Voiceในไฟล์เดียว — ระบบจะ chromakey ลบพื้นหลังและวางทับ
                      </div>
                      <div className="text-[10px] text-slate-600 font-bold uppercase tracking-wider">URL or Upload File</div>
                      <div className="relative flex items-center">
                        <input value={p.avatarDirectUrl} onChange={e => p.setAvatarDirectUrl(e.target.value)}
                          placeholder="https://... หรือ URL วิดีโอ green screen"
                          className="w-full bg-[#1a1a22] border border-[#2a2a36] rounded-lg px-3 py-2 text-[11px] text-slate-300 outline-none pr-7" />
                        {p.avatarDirectUrl && (
                          <button onClick={() => p.setAvatarDirectUrl("")}
                            className="absolute right-2 text-slate-600 hover:text-slate-400">
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                      {/* Upload local file — รองรับไฟล์ใหญ่ถึง 10 นาที */}
                      <DirectAvatarUpload onUrl={p.setAvatarDirectUrl} onPlanError={(msg) => p.onPlanError?.(msg)} />
                      {p.avatarDirectUrl.trim() && (
                        <video src={p.avatarDirectUrl.trim()} controls className="w-full rounded-lg" style={{ maxHeight: 180, background: "#000" }} />
                      )}
                    </div>
                  )}

                  {/* Avatar Position Preview — generate mode only */}
                  {p.avatarInputMode === "generate" && <div>
                    <div className="text-[10px] text-slate-600 mb-2 font-bold uppercase tracking-wider">Avatar Position</div>
                    <div className="flex gap-3">
                      {/* Preview canvas */}
                      <div className="relative rounded-lg overflow-hidden bg-black flex-shrink-0 cursor-crosshair select-none"
                        style={{ width: 90, height: 160, border: "1px solid #2a2a36" }}
                        onPointerDown={e => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const move = (ev: PointerEvent) => {
                            const x = ((ev.clientX - rect.left) / rect.width - 0.5) * 2;
                            const y = -((ev.clientY - rect.top) / rect.height - 0.5) * 2;
                            p.setAvatarOffsetX(Math.round(Math.max(-200, Math.min(200, x * 200))));
                            p.setAvatarOffsetY(Math.round(Math.max(-200, Math.min(200, y * 200))));
                          };
                          const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
                          window.addEventListener("pointermove", move);
                          window.addEventListener("pointerup", up);
                          move(e.nativeEvent as PointerEvent);
                        }}>
                        {/* Grid lines */}
                        {[25,50,75].map(p2 => <div key={`v${p2}`} className="absolute top-0 bottom-0 pointer-events-none" style={{ left: `${p2}%`, width: 1, background: p2===50?"rgba(255,255,255,0.15)":"rgba(255,255,255,0.04)" }} />)}
                        {[25,50,75].map(p2 => <div key={`h${p2}`} className="absolute left-0 right-0 pointer-events-none" style={{ top: `${p2}%`, height: 1, background: p2===50?"rgba(255,255,255,0.15)":"rgba(255,255,255,0.04)" }} />)}
                        {/* Avatar placeholder */}
                        <div className="absolute pointer-events-none rounded"
                          style={{
                            width: `${Math.min(p.avatarScale * 62, 100)}%`,
                            aspectRatio: "15/16",
                            left: `${50 + (p.avatarOffsetX / 200) * 50}%`,
                            bottom: `${5 - (p.avatarOffsetY / 200) * 50}%`,
                            transform: "translateX(-50%)",
                            background: p.avatarGreenUrl ? "transparent" : "rgba(124,58,237,0.2)",
                            border: "1px solid rgba(99,179,237,0.5)",
                          }}>
                          {p.avatarGreenUrl && (
                            <video src={p.avatarGreenUrl} className="w-full h-full object-cover" muted loop autoPlay playsInline />
                          )}
                          {!p.avatarGreenUrl && <User className="w-4 h-4 text-violet-400/40 m-auto mt-2" />}
                        </div>
                        {/* Dot indicator */}
                        <div className="absolute w-2 h-2 rounded-full border-2 border-cyan-400 bg-cyan-500/50 pointer-events-none"
                          style={{ left: `${50 + (p.avatarOffsetX / 200) * 50}%`, bottom: `${2 - (p.avatarOffsetY / 200) * 50}%`, transform: "translate(-50%, 50%)" }} />
                        {/* Coords label */}
                        <div className="absolute top-1 left-1 bg-black/75 text-[7px] text-white/70 px-1 py-0.5 rounded font-mono pointer-events-none leading-snug">
                          X:{p.avatarOffsetX}<br />Y:{p.avatarOffsetY}
                        </div>
                      </div>
                      {/* Sliders */}
                      <div className="flex-1 space-y-2 min-w-0">
                        {([
                          { label: "Size", value: p.avatarScale * 100, min: 10, max: 80, unit: "%", onChange: (v: number) => p.setAvatarScale(v / 100) },
                          { label: "Offset X", value: p.avatarOffsetX, min: -200, max: 200, unit: "px", onChange: p.setAvatarOffsetX },
                          { label: "Offset Y", value: p.avatarOffsetY, min: -200, max: 200, unit: "px", onChange: p.setAvatarOffsetY },
                        ]).map(({ label, value, min, max, unit, onChange }) => (
                          <div key={label}>
                            <div className="flex justify-between mb-0.5">
                              <span className="text-[9px] text-slate-600">{label}</span>
                              <span className="text-[9px] font-mono text-cyan-400">{Math.round(value)}{unit}</span>
                            </div>
                            <input type="range" min={min} max={max} step={1} value={Math.round(value)}
                              onChange={e => onChange(Number(e.target.value))}
                              className="w-full accent-cyan-400 h-1" />
                          </div>
                        ))}
                        <button onClick={() => { p.setAvatarOffsetX(0); p.setAvatarOffsetY(0); p.setAvatarScale(0.35); }}
                          className="text-[9px] text-slate-600 hover:text-slate-400 transition-colors w-full text-center">
                          ↺ Reset
                        </button>
                      </div>
                    </div>
                  </div>}

                  {/* Background Removal — แสดงทั้ง generate และ direct mode */}
                  <div className="rounded-lg overflow-hidden" style={{ border: "1px solid hsl(120 60% 40% / 0.2)", background: "hsl(120 60% 10% / 0.15)" }}>
                    <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: "1px solid hsl(120 60% 40% / 0.12)" }}>
                      <div className="flex items-center gap-1.5">
                        <span className="text-green-400/70 text-[11px]">✦</span>
                        <span className="text-[9px] font-bold uppercase tracking-widest text-green-400/60">Background Removal</span>
                      </div>
                      <span className="text-[8px] text-white/20">Adjust before Composite</span>
                    </div>
                    <div className="p-3 space-y-2.5">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-white/35 w-16 shrink-0">Green Color</span>
                        <div className="flex items-center gap-1.5 rounded px-2 py-0.5" style={{ background: "#0a1a0a", border: "1px solid hsl(120 60% 40% / 0.3)" }}>
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: "#00FF00" }} />
                          <span className="text-[9px] font-mono text-green-400">#00FF00</span>
                        </div>
                      </div>
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-white/35 w-16 shrink-0">Similarity</span>
                          <input type="range" min={0.10} max={0.55} step={0.01} value={p.chromaSimilarity}
                            onChange={e => p.setChromaSimilarity(Number(e.target.value))}
                            className="flex-1 accent-green-400 h-1" />
                          <span className="text-[9px] font-mono text-green-400 w-7 text-right">{p.chromaSimilarity.toFixed(2)}</span>
                        </div>
                        <p className="text-[8px] text-white/20 pl-[72px]">เขียวยังมี → เพิ่ม &nbsp;|&nbsp; ผิว/เสื้อหาย → ลด</p>
                      </div>
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-white/35 w-16 shrink-0">Blend</span>
                          <input type="range" min={0.00} max={0.20} step={0.01} value={p.chromaBlend}
                            onChange={e => p.setChromaBlend(Number(e.target.value))}
                            className="flex-1 accent-green-400 h-1" />
                          <span className="text-[9px] font-mono text-green-400 w-7 text-right">{p.chromaBlend.toFixed(2)}</span>
                        </div>
                        <p className="text-[8px] text-white/20 pl-[72px]">ขอบหยัก → เพิ่ม &nbsp;|&nbsp; ขอบนิ่ม → ลด</p>
                      </div>
                    </div>
                  </div>

                  {/* Generate mode: manual trigger button */}
                  {p.avatarInputMode === "generate" && (
                    <>
                      {p.avatarGreenUrl && (
                        <div className="text-[10px] text-emerald-400 truncate">✓ Avatar: {p.avatarGreenUrl.split("/").pop()}</div>
                      )}
                      <button onClick={p.runAvatarPipeline}
                        disabled={p.running || !p.pipeRenderedVideoUrl}
                        className={cn("w-full py-2 rounded-lg text-[11px] font-bold flex items-center justify-center gap-1.5 transition-all",
                          p.running || !p.pipeRenderedVideoUrl
                            ? "bg-[#1a1a22] border border-[#2a2a36] text-slate-600 cursor-not-allowed"
                            : "bg-violet-600 hover:bg-violet-500 text-white shadow-[0_0_12px_rgba(124,58,237,0.3)]")}>
                        <User className="w-3 h-3" />
                        {p.steps.avatar === "running" ? "กำลัง Gen Avatar (ต้น)..." : p.steps.avatarTail === "running" ? "กำลัง Gen Avatar (ท้าย)..." : p.steps.composite === "running" ? "กำลัง Composite..." : "สร้าง Avatar + Composite"}
                      </button>
                      {!p.pipeRenderedVideoUrl && (
                        <div className="text-[10px] text-slate-600 text-center">ต้อง Render วิดีโอก่อน</div>
                      )}
                    </>
                  )}
                  {/* Direct mode: composite runs automatically after render — show status only */}
                  {p.avatarInputMode === "direct" && (
                    <div className={cn("text-[10px] text-center py-1.5 rounded-lg border",
                      p.steps.composite === "running"
                        ? "text-violet-400 border-violet-500/30 bg-violet-500/5"
                        : p.steps.composite === "done"
                          ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/5"
                          : "text-slate-600 border-[#2a2a36]"
                    )}>
                      {p.steps.composite === "running" ? "⏳ กำลัง Composite..." : p.steps.composite === "done" ? "✓ Composite เสร็จแล้ว" : "Composite จะทำงานอัตโนมัติหลัง Render"}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════════════════════

export default function VideoEditorPage() {

  // ── Draft / project state ──────────────────────────────────────────────
  const [draftId, setDraftId] = useState(() => newDraftId());
  const [projectName, setProjectName] = useState("New Project");
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [showDraftList, setShowDraftList] = useState(false);
  const [drafts, setDrafts] = useState<EditorDraft[]>([]);

  // ── Script ────────────────────────────────────────────────────────────
  const [script, setScript] = useState("");
  const [activeSegIdx, setActiveSegIdx] = useState(0);

  // ── Pipeline state (copied from video-creator) ─────────────────────────
  const [steps, setSteps] = useState<StepState>({ ...DEFAULT_STEPS });
  const stepsRef = useRef<StepState>({ ...DEFAULT_STEPS });
  const [logs, setLogs] = useState<Partial<Record<keyof StepState, string>>>({});
  const [running, setRunning] = useState(false);
  const abortRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const stopRenderPollRef = useRef<(() => void) | null>(null);
  const pipe = useRef<Partial<PipelineData>>({});
  const runningRef = useRef(false);
  const activeJobIdRef = useRef<string | null>(null);

  // ── Media state ───────────────────────────────────────────────────────
  const [videoUrl, setVideoUrl] = useState("");
  const [preRenderUrl, setPreRenderUrl] = useState("");
  const [ttsUrl, setTtsUrl] = useState("");
  const [captions, setCaptionsRaw] = useState<Caption[]>([]);
  const historyRef = useRef<Caption[][]>([]);
  const historyIdxRef = useRef(-1);
  const setCaptions = useCallback((next: Caption[]) => {
    historyRef.current = historyRef.current.slice(0, historyIdxRef.current + 1).concat([next.map(c => ({ ...c }))]);
    historyIdxRef.current = historyRef.current.length - 1;
    captionsRef.current = next;
    setCaptionsRaw(next);
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  const [activeCaptionIdx, setActiveCaptionIdx] = useState(-1);
  const [editingCapIdx, setEditingCapIdx] = useState<number | null>(null);

  // ── Playback ──────────────────────────────────────────────────────────
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isEditorExpanded, setIsEditorExpanded] = useState(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const centerPanelRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // ── TTS / Voice ───────────────────────────────────────────────────────
  const [ttsProvider, setTtsProvider] = useState<"elevenlabs" | "gemini">("gemini");
  const [voiceId, setVoiceId] = useState("");
  const [geminiVoiceName, setGeminiVoiceName] = useState("Aoede");

  // ── Stock ─────────────────────────────────────────────────────────────
  const [stockSource, setStockSource] = useState<"pexels" | "pixabay" | "both">("both");
  const [stockVideos, setStockVideos] = useState<StockVideo[]>([]);
  const targetClipCount = 0;

  // ── Preferred LLM ─────────────────────────────────────────────────────
  const preferredLLMRef = useRef<"gemini" | null>(null);

  // ── Subtitle style ────────────────────────────────────────────────────
  const [subFontFamily, setSubFontFamily] = useState("'Mitr', sans-serif");
  const [subFontSize, setSubFontSize] = useState(80);
  const [subFontWeight, setSubFontWeight] = useState(900);
  const [subColor, setSubColor] = useState("#ffffff");
  const [subAccentColor, setSubAccentColor] = useState("#FFE500");
  const [subPreset, setSubPreset] = useState<SubPreset>("stroke");
  const [subEffect, setSubEffect] = useState<SubTextEffect>("pop");
  const [subPosition, setSubPosition] = useState(82);
  const [subShadow, setSubShadow] = useState(true);
  const [subOutline, setSubOutline] = useState(false);
  const [subOutlineSize, setSubOutlineSize] = useState(2);
  const [activeRightTab, setActiveRightTab] = useState<"style" | "font">("font");
  const [orderPanelOpen, setOrderPanelOpen] = useState(true);

  // ── Avatar (HeyGen pipeline) ───────────────────────────────────────────
  const [useAvatar, setUseAvatar] = useState(false);
  const [avatarId, setAvatarId] = useState("");
  const [avatarScale, setAvatarScale] = useState(2.02);
  const [avatarOffsetX, setAvatarOffsetX] = useState(0.0);
  const [avatarOffsetY, setAvatarOffsetY] = useState(0.13);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState("");
  const [avatarName, setAvatarName] = useState("");
  const [avatarTiming, setAvatarTiming] = useState<"full" | "bookend" | "bookend-both">("full");
  const [avatarBookendSecs, setAvatarBookendSecs] = useState(5);
  const [avatarTailSecs, setAvatarTailSecs] = useState(5);
  const [avatarGreenUrl, setAvatarGreenUrl] = useState("");
  const [avatarTailGreenUrl, setAvatarTailGreenUrl] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);

  // ── Split mode ────────────────────────────────────────────────────────
  const [splitMode, setSplitMode] = useState<"sentence" | "1" | "2" | "3" | "4" | "custom">("sentence");
  const [splitCustomN, setSplitCustomN] = useState(3);
  const [showSplitMenu, setShowSplitMenu] = useState(false);
  // เก็บ captions ต้นฉบับจาก Transcribe เพื่อ reset "sentence" ได้
  const originalCaptionsRef = useRef<Caption[]>([]);
  // ref ที่ sync กับ captions state — ใช้ใน rAF loop เพื่อหลีกเลี่ยง stale closure
  const captionsRef = useRef<Caption[]>([]);

  // ── Script override ก่อนส่ง LLM (TTS / Transcribe) ───────────────────
  const [scriptOverride, setScriptOverride] = useState("");
  const [showScriptOverride, setShowScriptOverride] = useState(false);

  // ── Avatar Direct URL mode ────────────────────────────────────────────
  const [avatarInputMode, setAvatarInputMode] = useState<"generate" | "direct">("generate");
  const [avatarDirectUrl, setAvatarDirectUrl] = useState("");
  const [chromaSimilarity, setChromaSimilarity] = useState(0.28);
  const [chromaBlend, setChromaBlend] = useState(0.04);

  // ── BGM ───────────────────────────────────────────────────────────────
  const [bgmEnabled, setBgmEnabled] = useState(false);
  const [bgmFile, setBgmFile] = useState("");
  const [bgmVolume, setBgmVolume] = useState(0.12);
  const [bgmUploading, setBgmUploading] = useState(false);
  interface SystemTrack { id: string; title: string; filename: string; }
  const [systemTracks, setSystemTracks] = useState<SystemTrack[]>([]);

  // ── Render progress ───────────────────────────────────────────────────
  const renderProgressRef = useRef(0);
  const [, setRenderProgressTick] = useState(0);
  const [renderProgressError, setRenderProgressError] = useState<string | null>(null);
  const renderProgress = renderProgressRef.current;
  function setRenderProgress(v: number) { renderProgressRef.current = v; setRenderProgressTick(t => t + 1); }

  // ── Last-rendered style snapshot (for reset + dirty detection) ────────
  interface RenderedStyle {
    fontFamily: string; fontSize: number; fontWeight: number;
    color: string; accentColor: string; preset: SubPreset;
    effect: SubTextEffect; position: number;
    captions: Caption[];
  }
  const lastRenderedStyleRef = useRef<RenderedStyle | null>(null);
  const [styleIsDirty, setStyleIsDirty] = useState(false);

  // ── Missing key modal ─────────────────────────────────────────────────
  const [missingKey, setMissingKey] = useState<{ type: RequiredKeyType; retryStep: keyof StepState | "runAll" | "runAvatarPipeline" } | null>(null);
  const [upgradeModal, setUpgradeModal] = useState<{ open: boolean; message?: string }>({ open: false });

  // ── Timeline zoom ─────────────────────────────────────────────────────
  const [tlZoom, setTlZoom] = useState(100);

  // ── Undo / Redo ────────────────────────────────────────────────────────
  function undo() {
    if (historyIdxRef.current <= 0) return;
    historyIdxRef.current--;
    setCaptions(historyRef.current[historyIdxRef.current].map(c => ({ ...c })));
  }
  function redo() {
    if (historyIdxRef.current >= historyRef.current.length - 1) return;
    historyIdxRef.current++;
    setCaptions(historyRef.current[historyIdxRef.current].map(c => ({ ...c })));
  }

  // ── Right panel open/close/wide/detach ───────────────────────────────
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [rightPanelWide, setRightPanelWide] = useState(false);
  const [panelDetached, setPanelDetached] = useState(false);
  const [panelPos, setPanelPos] = useState({ x: 80, y: 60 });
  const panelDragRef = useRef<{ startX: number; startY: number; startPx: number; startPy: number } | null>(null);
  const [panelDragging, setPanelDragging] = useState(false);

  // ── Panel resize ──────────────────────────────────────────────────────
  const [leftPanelWidth, setLeftPanelWidth] = useState(320);
  const [rightPanelWidth, setRightPanelWidth] = useState(268);
  const [timelineHeight, setTimelineHeight] = useState(192);
  const leftResizeRef = useRef<{ startX: number; startW: number } | null>(null);
  const rightResizeRef = useRef<{ startX: number; startW: number } | null>(null);
  const timelineResizeRef = useRef<{ startY: number; startH: number } | null>(null);

  // ── Search captions ────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  // ── Timeline clip resize drag ──────────────────────────────────────────
  const clipResizeRef = useRef<{ capIdx: number; edge: "left" | "right"; startX: number; startMs: number } | null>(null);

  // ── Subtitle drag on phone frame ──────────────────────────────────────
  const phoneFrameRef = useRef<HTMLDivElement>(null);
  const subDragRef = useRef<{ startY: number; startPos: number } | null>(null);

  function onSubPointerDown(e: React.PointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId);
    subDragRef.current = { startY: e.clientY, startPos: subPosition };
  }
  function onSubPointerMove(e: React.PointerEvent) {
    if (!subDragRef.current || !phoneFrameRef.current) return;
    const frameH = phoneFrameRef.current.getBoundingClientRect().height;
    const dy = e.clientY - subDragRef.current.startY;
    const dpct = (dy / frameH) * 100;
    setSubPosition(Math.min(95, Math.max(5, Math.round(subDragRef.current.startPos + dpct))));
  }
  function onSubPointerUp() { subDragRef.current = null; }

  // ── Panel resize pointer handlers ─────────────────────────────────────
  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (leftResizeRef.current) {
        const dx = e.clientX - leftResizeRef.current.startX;
        setLeftPanelWidth(Math.min(520, Math.max(240, leftResizeRef.current.startW + dx)));
      }
      if (rightResizeRef.current) {
        const dx = rightResizeRef.current.startX - e.clientX;
        setRightPanelWidth(Math.min(560, Math.max(220, rightResizeRef.current.startW + dx)));
      }
      if (timelineResizeRef.current) {
        const dy = timelineResizeRef.current.startY - e.clientY;
        setTimelineHeight(Math.min(480, Math.max(96, timelineResizeRef.current.startH + dy)));
      }
    }
    function onUp() {
      leftResizeRef.current = null;
      rightResizeRef.current = null;
      timelineResizeRef.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  // ── Sync volume/muted to video element ────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = volume;
    v.muted = muted;
  }, [volume, muted]);

  // ── Fullscreen listener ────────────────────────────────────────────────
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
      if (e.key === " ") { e.preventDefault(); playToggle(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Init ──────────────────────────────────────────────────────────────
  useEffect(() => {
    setDrafts(loadDrafts());
    fetch("/api/user/video-settings").then(r => r.json()).then(d => {
      if (d.heygenAvatarId) setAvatarId(d.heygenAvatarId);
      if (d.elevenlabsVoiceId) setVoiceId(d.elevenlabsVoiceId);
      if (d.ttsProvider === "gemini" || d.ttsProvider === "elevenlabs") setTtsProvider(d.ttsProvider);
      if (d.geminiVoiceName) setGeminiVoiceName(d.geminiVoiceName);
    }).catch(() => {});
    fetch("/api/music").then(r => r.json()).then(d => { if (d.tracks) setSystemTracks(d.tracks); }).catch(() => {});

    // ── Resume render polling ถ้ามี pending jobId จาก session ก่อน hot-reload/refresh ──
    const savedJobId = sessionStorage.getItem("ve_pending_render_jobId");
    const savedJobTs = Number(sessionStorage.getItem("ve_pending_render_ts") ?? "0");
    const AGE_LIMIT_MS = 3 * 60 * 60 * 1000; // 3 ชั่วโมง
    if (savedJobId && Date.now() - savedJobTs < AGE_LIMIT_MS) {
      console.log(`[render] resuming poll for job=${savedJobId}`);
      setStep("render", "running", "Rendering (resumed)...");
      setRunning(true); runningRef.current = true;
      activeJobIdRef.current = savedJobId;

      // Poll progress file (fast) — resolves UI ทันทีถ้า render เสร็จแล้ว
      const progressPoll = setInterval(async () => {
        try {
          const r = await fetch(`/api/videos/render-progress?jobId=${encodeURIComponent(savedJobId)}`, { cache: "no-store" });
          if (!r.ok) return;
          const d = await r.json() as { progress?: number; videoUrl?: string | null; error?: string | null };
          if (d.videoUrl) {
            clearInterval(progressPoll);
            sessionStorage.removeItem("ve_pending_render_jobId");
            sessionStorage.removeItem("ve_pending_render_ts");
            setPreRenderUrl(d.videoUrl); setVideoUrl(d.videoUrl);
            pipe.current.renderedVideoUrl = d.videoUrl;
            setStep("render", "done", d.videoUrl); setRenderProgress(100);
            setRunning(false); runningRef.current = false;
            toast.success("เรนเดอร์เสร็จแล้ว!");
            return;
          }
          if (d.error) {
            clearInterval(progressPoll);
            sessionStorage.removeItem("ve_pending_render_jobId");
            sessionStorage.removeItem("ve_pending_render_ts");
            setStep("render", "error", d.error); setRunning(false); runningRef.current = false;
            return;
          }
          const p = Number(d.progress);
          if (Number.isFinite(p)) { setRenderProgress(Math.min(100, Math.max(0, Math.round(p)))); setStep("render", "running", `Rendering... ${Math.round(p)}%`); }
        } catch {}
      }, 1500);

      // Poll render-status (slow) — fallback ถ้า progress file ไม่อัพเดต
      const statusPoll = setInterval(async () => {
        try {
          const sr = await fetch(`/api/videos/render-status?jobId=${encodeURIComponent(savedJobId)}`, { cache: "no-store" });
          const sd = await sr.json() as { status?: string; videoUrl?: string; error?: string };
          if (sd.status === "done" && sd.videoUrl) {
            clearInterval(progressPoll); clearInterval(statusPoll);
            sessionStorage.removeItem("ve_pending_render_jobId");
            sessionStorage.removeItem("ve_pending_render_ts");
            setPreRenderUrl(sd.videoUrl); setVideoUrl(sd.videoUrl);
            pipe.current.renderedVideoUrl = sd.videoUrl;
            setStep("render", "done", sd.videoUrl); setRenderProgress(100);
            setRunning(false); runningRef.current = false;
            toast.success("เรนเดอร์เสร็จแล้ว!");
          } else if (sd.status === "error") {
            clearInterval(progressPoll); clearInterval(statusPoll);
            sessionStorage.removeItem("ve_pending_render_jobId");
            sessionStorage.removeItem("ve_pending_render_ts");
            setStep("render", "error", sd.error ?? "Render failed");
            setRunning(false); runningRef.current = false;
          }
        } catch {}
      }, 5000);
    }
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch avatar preview image when avatarId changes (debounced)
  useEffect(() => {
    if (!avatarId || avatarId.length < 10) { setAvatarPreviewUrl(""); setAvatarName(""); return; }
    const t = setTimeout(() => {
      fetch(`/api/heygen/avatar-info?avatarId=${avatarId}`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d) { setAvatarPreviewUrl(d.previewImageUrl ?? ""); setAvatarName(d.name ?? ""); } })
        .catch(() => { setAvatarPreviewUrl(""); setAvatarName(""); });
    }, 600);
    return () => clearTimeout(t);
  }, [avatarId]);

  // ── Video sync — rAF loop for smooth subtitle tracking ────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let rafId = 0;
    let lastIdx = -1;

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const ms = v.currentTime * 1000;
      setCurrentMs(ms);
      const idx = captionsRef.current.findIndex(c => ms >= c.startMs && ms < c.endMs);
      if (idx !== lastIdx) {
        lastIdx = idx;
        setActiveCaptionIdx(idx);
        if (idx >= 0) setActiveSegIdx(idx);
      }
    };

    const onPlay    = () => { setPlaying(true);  rafId = requestAnimationFrame(tick); };
    const onPause   = () => { setPlaying(false); cancelAnimationFrame(rafId); };
    const onEnded   = () => { setPlaying(false); cancelAnimationFrame(rafId); };
    const onMeta    = () => setDurationMs(v.duration * 1000);
    // single timeupdate for when video is paused/seeking
    const onTime    = () => {
      const ms = v.currentTime * 1000;
      setCurrentMs(ms);
      const idx = captionsRef.current.findIndex(c => ms >= c.startMs && ms < c.endMs);
      setActiveCaptionIdx(idx);
      if (idx >= 0) setActiveSegIdx(idx);
    };

    v.addEventListener("play",        onPlay);
    v.addEventListener("pause",       onPause);
    v.addEventListener("ended",       onEnded);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("seeked",      onTime);

    if (!v.paused) { rafId = requestAnimationFrame(tick); }

    return () => {
      cancelAnimationFrame(rafId);
      v.removeEventListener("play",        onPlay);
      v.removeEventListener("pause",       onPause);
      v.removeEventListener("ended",       onEnded);
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("seeked",      onTime);
    };
  }, [captions, videoUrl, preRenderUrl]);  // re-run when video src changes so listeners attach to new element

  // ── Draft save (manual only) ───────────────────────────────────────────
  function loadDraftInto(d: EditorDraft) {
    setDraftId(d.id);
    setProjectName(d.name);
    setScript(d.script);
    if (d.scriptOverride !== undefined) setScriptOverride(d.scriptOverride);

    // Style
    if (d.style) {
      setSubFontFamily(d.style.fontFamily);
      setSubFontSize(d.style.fontSize);
      setSubFontWeight(d.style.fontWeight);
      setSubColor(d.style.color);
      setSubAccentColor(d.style.accentColor);
      setSubPreset(d.style.preset);
      setSubEffect(d.style.effect);
      setSubPosition(d.style.position);
      if (d.style.shadow !== undefined) setSubShadow(d.style.shadow);
      if (d.style.outline !== undefined) setSubOutline(d.style.outline);
      if (d.style.outlineSize !== undefined) setSubOutlineSize(d.style.outlineSize);
    }

    // TTS
    if (d.ttsProvider) setTtsProvider(d.ttsProvider);
    if (d.voiceId) setVoiceId(d.voiceId);
    if (d.geminiVoiceName) setGeminiVoiceName(d.geminiVoiceName);

    // Video + captions (preview)
    setVideoUrl(d.renderedUrl ?? "");
    setPreRenderUrl(d.renderedUrl ?? "");
    const caps = d.captions ?? [];
    setCaptionsRaw(caps);
    captionsRef.current = caps;

    // Stock source
    if (d.stockSource) setStockSource(d.stockSource);

    // BGM
    if (d.bgmEnabled !== undefined) setBgmEnabled(d.bgmEnabled);
    if (d.bgmFile !== undefined) setBgmFile(d.bgmFile);
    if (d.bgmVolume !== undefined) setBgmVolume(d.bgmVolume);

    // Avatar
    if (d.useAvatar !== undefined) setUseAvatar(d.useAvatar);
    if (d.avatarId !== undefined) setAvatarId(d.avatarId);
    if (d.avatarName !== undefined) setAvatarName(d.avatarName);
    if (d.avatarPreviewUrl !== undefined) setAvatarPreviewUrl(d.avatarPreviewUrl);
    if (d.avatarTiming) setAvatarTiming(d.avatarTiming);
    if (d.avatarBookendSecs !== undefined) setAvatarBookendSecs(d.avatarBookendSecs);
    if (d.avatarTailSecs !== undefined) setAvatarTailSecs(d.avatarTailSecs);
    if (d.avatarScale !== undefined) setAvatarScale(d.avatarScale);
    if (d.avatarOffsetX !== undefined) setAvatarOffsetX(d.avatarOffsetX);
    if (d.avatarOffsetY !== undefined) setAvatarOffsetY(d.avatarOffsetY);
    if (d.avatarInputMode) setAvatarInputMode(d.avatarInputMode);
    if (d.avatarDirectUrl !== undefined) setAvatarDirectUrl(d.avatarDirectUrl);
    if (d.chromaSimilarity !== undefined) setChromaSimilarity(d.chromaSimilarity);
    if (d.chromaBlend !== undefined) setChromaBlend(d.chromaBlend);
    if (d.avatarGreenUrl !== undefined) setAvatarGreenUrl(d.avatarGreenUrl);
    if (d.avatarTailGreenUrl !== undefined) setAvatarTailGreenUrl(d.avatarTailGreenUrl);

    // Pipeline cache — restore so steps can re-run from any point
    pipe.current.voiceUrl = d.voiceUrl ?? "";
    pipe.current.audioDurationMs = d.audioDurationMs ?? 0;
    pipe.current.renderedVideoUrl = d.renderedUrl ?? "";
    pipe.current.renderedVideoNoSubUrl = d.renderedVideoNoSubUrl ?? "";
    pipe.current.burnedVideoUrl = d.burnedVideoUrl ?? "";
    pipe.current.galleryVideoId = d.galleryVideoId ?? "";
    pipe.current.compositeUrl = d.compositeUrl ?? "";
    pipe.current.keywords = d.keywords ?? [];
    pipe.current.keywordAlternatives = d.keywordAlternatives ?? [];
    pipe.current.keywordsPerScene = d.keywordsPerScene ?? 0;
    pipe.current.sceneClipCounts = d.sceneClipCounts ?? [];
    pipe.current.sceneDurations = d.sceneDurations ?? [];
    pipe.current.scenes = d.scenes ?? [];
    pipe.current.visualDirection = d.visualDirection ?? "";
    pipe.current.stockVideos = d.stockVideos ?? [];
    pipe.current.captions = caps;
    pipe.current.config = d.config ?? null;

    // Mark steps as done for cached data so user sees what's already complete
    const restoredSteps: StepState = { ...DEFAULT_STEPS };
    const restoredLogs: Partial<Record<keyof StepState, string>> = {};
    if (d.keywords?.length)      { restoredSteps.keywords    = "done"; restoredLogs.keywords    = `${d.keywords.length} kw`; }
    if (d.stockVideos?.length)   { restoredSteps.fetchStock  = "done"; restoredLogs.fetchStock  = `${d.stockVideos.length} clips`; }
    if (d.voiceUrl)              { restoredSteps.tts         = "done"; restoredLogs.tts         = d.voiceUrl; }
    if (caps.length)             { restoredSteps.transcribe  = "done"; restoredLogs.transcribe  = `${caps.length} subs`; }
    if (d.config)                { restoredSteps.config      = "done"; }
    if (d.renderedVideoNoSubUrl || d.renderedUrl) { restoredSteps.render = "done"; restoredLogs.render = d.renderedUrl ?? ""; }
    if (d.burnedVideoUrl)        { restoredSteps.burnSubtitles = "done"; restoredLogs.burnSubtitles = d.burnedVideoUrl; }
    if (d.compositeUrl)          { restoredSteps.composite   = "done"; restoredLogs.composite   = d.compositeUrl; }
    setSteps(restoredSteps);
    stepsRef.current = restoredSteps;
    setLogs(restoredLogs);
    setRenderProgress(0);
    setLastSaved(new Date(d.updatedAt));
    setShowDraftList(false);
    toast.success(`โหลด "${d.name}" แล้ว`);
  }

  function saveDraftNow() {
    if (!script.trim()) { toast.error("ยังไม่มี script ที่จะบันทึก"); return; }
    const draft: EditorDraft = {
      id: draftId, name: projectName, updatedAt: Date.now(), script,
      scriptOverride: scriptOverride || undefined,
      style: {
        fontFamily: subFontFamily, fontSize: subFontSize, fontWeight: subFontWeight,
        color: subColor, accentColor: subAccentColor, preset: subPreset, effect: subEffect, position: subPosition,
        shadow: subShadow, outline: subOutline, outlineSize: subOutlineSize,
      },
      renderedUrl: videoUrl,
      renderedVideoNoSubUrl: pipe.current.renderedVideoNoSubUrl,
      burnedVideoUrl: pipe.current.burnedVideoUrl,
      galleryVideoId: pipe.current.galleryVideoId,
      compositeUrl: pipe.current.compositeUrl,

      ttsProvider, voiceId, geminiVoiceName,
      captions: captionsRef.current,
      voiceUrl: pipe.current.voiceUrl,
      audioDurationMs: pipe.current.audioDurationMs,

      // Pipeline cache so steps can be re-run from any point without redoing work
      keywords: pipe.current.keywords,
      keywordAlternatives: pipe.current.keywordAlternatives,
      keywordsPerScene: pipe.current.keywordsPerScene,
      sceneClipCounts: pipe.current.sceneClipCounts,
      sceneDurations: pipe.current.sceneDurations,
      scenes: pipe.current.scenes,
      visualDirection: pipe.current.visualDirection,
      stockVideos: pipe.current.stockVideos,
      config: pipe.current.config,

      stockSource,
      bgmEnabled, bgmFile, bgmVolume,

      useAvatar, avatarId, avatarName, avatarPreviewUrl,
      avatarTiming, avatarBookendSecs, avatarTailSecs,
      avatarScale, avatarOffsetX, avatarOffsetY,
      avatarInputMode, avatarDirectUrl,
      chromaSimilarity, chromaBlend,
      avatarGreenUrl, avatarTailGreenUrl,
    };
    const existing = loadDrafts().filter(d => d.id !== draftId);
    saveDrafts([draft, ...existing]);
    setDrafts([draft, ...existing]);
    setLastSaved(new Date());
    toast.success("บันทึก draft แล้ว");
  }

  // ── Pipeline helpers (copied from video-creator) ───────────────────────

  function setStep(key: keyof StepState, status: StepStatus, log?: string) {
    setSteps(s => { const next = { ...s, [key]: status }; stepsRef.current = next; return next; });
    if (log) setLogs(l => ({ ...l, [key]: log }));
  }

  function assertOk(prefix: string, res: Response, data: Record<string, unknown>) {
    if (!res.ok) throw new ApiCallError(prefix, data, res.status);
  }

  function handlePlanError(err: unknown): boolean {
    if (err instanceof ApiCallError && (err.data as any)._status === 403) {
      setUpgradeModal({ open: true, message: String(err.data.error ?? "") });
      return true;
    }
    // check via message contains "403"
    if (err instanceof ApiCallError) {
      const status = (err.data as any)._status;
      if (status === 403) {
        setUpgradeModal({ open: true, message: String(err.data.error ?? "") });
        return true;
      }
    }
    return false;
  }

  function friendlyError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === "AbortError") return "ยกเลิกโดยผู้ใช้";
    if (raw.includes("Unexpected token '<'") || raw.includes("<html")) return "Server ไม่ตอบสนอง (502/504)";
    if (raw.includes("ENOSPC")) return "พื้นที่ดิสก์บน Server เต็ม";
    if (raw.includes("429")) return "API เกิน Rate Limit — รอสักครู่แล้วลองใหม่";
    if (err instanceof ApiCallError) {
      const status = (err.data as any)._status as number | undefined;
      const errMsg = String(err.data.error ?? "");
      // Key ตั้งไว้แล้วแต่ invalid — บอกรายละเอียดแทนการให้ใส่ซ้ำ
      if (status === 401) {
        if (errMsg.toLowerCase().includes("elevenlabs")) return `ElevenLabs API key ไม่ถูกต้องหรือหมดอายุ — กรุณาตรวจสอบ key ใน Settings`;
        if (errMsg.toLowerCase().includes("heygen"))      return `HeyGen API key ไม่ถูกต้องหรือหมดอายุ — กรุณาตรวจสอบ key ใน Settings`;
        if (errMsg.toLowerCase().includes("gemini"))      return `Gemini API key ไม่ถูกต้องหรือหมดอายุ — กรุณาตรวจสอบ key ใน Settings`;
        return `API key ไม่ถูกต้องหรือหมดอายุ (401) — ${errMsg || "กรุณาตรวจสอบ key ใน Settings"}`;
      }
      if (status === 403 && !err.data.missingKey) {
        // 403 แต่ไม่ใช่ missingKey (เช่น credit หมด, quota เกิน)
        if (errMsg.toLowerCase().includes("elevenlabs")) return `ElevenLabs: ${errMsg} — อาจ credit หมดหรือ plan ไม่รองรับ`;
        if (errMsg.toLowerCase().includes("heygen"))     return `HeyGen: ${errMsg} — อาจ credit หมดหรือ plan ไม่รองรับ`;
        if (errMsg.toLowerCase().includes("pexels"))     return `Pexels API key ไม่ถูกต้องหรือเกิน quota`;
        if (errMsg.toLowerCase().includes("pixabay"))    return `Pixabay API key ไม่ถูกต้องหรือเกิน quota`;
      }
      if (err.data.error) return errMsg;
    }
    return raw.split("\n")[0].slice(0, 200) || "เกิดข้อผิดพลาด";
  }

  function handleMissingKey(err: unknown, fallback: keyof StepState | "runAll" | "runAvatarPipeline"): boolean {
    if (err instanceof ApiCallError && err.data.retryable === false) return false;
    let keyType = null;
    if (err instanceof ApiCallError) keyType = detectMissingKeyType(err.data);
    if (!keyType) return false;
    const runningStep = (Object.keys(stepsRef.current) as (keyof StepState)[]).find(k => stepsRef.current[k] === "running");
    setMissingKey({ type: keyType, retryStep: runningStep ?? fallback });
    return true;
  }

  function splitScenes(text: string) {
    return text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  }

  function preprocessScript(raw: string) {
    return raw
      .replace(/\r?\n/g, "")   // ลบ newline ทั้งหมด ไม่เว้นวรรค
      .replace(/\s{2,}/g, " ") // ลด multiple spaces เหลือ 1
      .trim();
  }

  // ── Step runners (same logic as video-creator) ─────────────────────────

  async function runKeywords(): Promise<string[]> {
    setStep("keywords", "running");
    const sc = splitScenes(script);
    pipe.current.scenes = sc;
    // ส่ง audioDurationSec เพื่อให้ extract-keywords คำนวณจำนวน keywords ที่เหมาะสม
    // Priority order: actual TTS duration > script-based estimate
    //
    // Thai TTS speaks at ~2 Thai chars/sec for natural pace (slower than English).
    // We add 10% buffer to over-estimate slightly — better too many keywords than too few.
    const knownDurSec = pipe.current.audioDurationMs ? pipe.current.audioDurationMs / 1000 : 0;
    const thaiCharCount = (script.match(/[฀-๿]/g) ?? []).length;
    const englishWordCount = script.replace(/[฀-๿]/g, " ").split(/\s+/).filter(Boolean).length;
    // ~2 Thai chars/sec + ~3 English words/sec (TTS natural rate)
    const scriptEstimate = thaiCharCount / 2 + englishWordCount / 3;
    const estimatedDurSec = knownDurSec > 0
      ? knownDurSec
      : Math.ceil(scriptEstimate * 1.1);  // 10% buffer
    console.log(`[runKeywords] dur estimate: known=${knownDurSec}s, script=${scriptEstimate.toFixed(1)}s → using ${estimatedDurSec}s (thaiChars=${thaiCharCount}, enWords=${englishWordCount})`);
    const res = await fetch("/api/videos/extract-keywords", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenes: sc, audioDurationSec: estimatedDurSec, preferredLLM: preferredLLMRef.current }),
      signal: abortControllerRef.current?.signal,
    });
    const data = await res.json();
    assertOk("Keywords", res, data);
    const kws: string[] = data.keywords ?? [];
    pipe.current.keywords = kws;
    pipe.current.keywordAlternatives = data.keywordAlternatives ?? [];
    pipe.current.keywordsPerScene = data.keywordsPerScene ?? 5;
    pipe.current.sceneClipCounts = data.sceneClipCounts ?? [];
    pipe.current.sceneDurations = data.sceneDurations ?? [];
    pipe.current.visualDirection = data.visualDirection ?? "";
    const totalClips = (data.sceneClipCounts ?? []).reduce((a: number, b: number) => a + b, kws.length);
    setStep("keywords", "done", `${sc.length} ฉาก → ${kws.length} keywords (${totalClips} คลิปที่ต้องการ)`);
    return kws;
  }

  async function runFetchStock(kws: string[]): Promise<StockVideo[]> {
    const srcLabel = stockSource === "pexels" ? "Pexels" : stockSource === "pixabay" ? "Pixabay" : "Pexels+Pixabay";
    setStep("fetchStock", "running", `${kws.length} keywords → ${srcLabel}...`);
    const sceneDurations: number[] = pipe.current.sceneDurations ?? [];
    const totalDurationSec = sceneDurations.length > 0
      ? sceneDurations.reduce((a, b) => a + b, 0)
      : Math.max(30, Math.ceil((pipe.current.scenes ?? []).reduce((s, sc) => s + sc.replace(/\s/g,"").length, 0) / 3));
    const res = await fetch("/api/videos/fetch-stock", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keywords: kws, download: true, totalDurationSec, stockSource,
        preferredLLM: preferredLLMRef.current,
        ...(targetClipCount > 0 ? { overrideClipCount: targetClipCount } : {}),
        ...(pipe.current.visualDirection ? { visualDirection: pipe.current.visualDirection } : {}),
        ...(pipe.current.keywordAlternatives?.length ? { keywordAlternatives: pipe.current.keywordAlternatives } : {}),
        ...(pipe.current.sceneCaptions?.length ? { subtitleTexts: pipe.current.sceneCaptions.map(c => c.text) } : {}),
      }),
      signal: abortControllerRef.current?.signal,
    });
    const data = await res.json();
    assertOk("Stock", res, data);
    const sv: StockVideo[] = (data.results ?? []).filter((r: StockVideo) => r.localUrl || r.videoUrl);
    if (!sv.length) throw new Error("ไม่พบ stock video");
    pipe.current.stockVideos = sv;
    setStockVideos(sv);
    const pexelsCnt = sv.filter(v => v.pexelsId < 9_000_000).length;
    const pixabayCnt = sv.filter(v => v.pexelsId >= 9_000_000).length;
    const srcBreakdown = stockSource === "both" ? ` (P:${pexelsCnt} B:${pixabayCnt})` : "";
    setStep("fetchStock", "done", `ได้ ${sv.length} คลิป สำหรับ ${Math.round(totalDurationSec)}s${srcBreakdown}`);
    return sv;
  }

  async function runTts(): Promise<string> {
    if (ttsProvider === "gemini") {
      setStep("tts", "running", "Gemini TTS...");
      const res = await fetch("/api/videos/tts-gemini", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: scriptOverride.trim() || preprocessScript(script), voiceName: geminiVoiceName }),
        signal: abortControllerRef.current?.signal,
      });
      const data = await res.json();
      assertOk("TTS", res, data);
      const url = data.voiceUrl as string;
      pipe.current.voiceUrl = url; setTtsUrl(url);
      setStep("tts", "done", url); return url;
    } else {
      setStep("tts", "running", "ElevenLabs...");
      const res = await fetch("/api/videos/tts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: scriptOverride.trim() || preprocessScript(script), voiceId, languageCode: "th" }),
        signal: abortControllerRef.current?.signal,
      });
      const data = await res.json();
      assertOk("TTS", res, data);
      const url = data.voiceUrl as string;
      pipe.current.voiceUrl = url; setTtsUrl(url);
      setStep("tts", "done", url); return url;
    }
  }

  async function runTranscribe(voiceUrl: string): Promise<Caption[]> {
    setStep("transcribe", "running", "Whisper transcribing...");
    const cleanScriptForTx = scriptOverride.trim() || preprocessScript(script);
    const fullUrl = voiceUrl.startsWith("http") ? voiceUrl : `${window.location.origin}${voiceUrl}`;
    const res = await fetch("/api/videos/transcribe", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audioUrl: fullUrl,
        scriptPrompt: cleanScriptForTx.slice(0, 800),
        script: cleanScriptForTx,
        preferredLLM: preferredLLMRef.current,
      }),
      signal: abortControllerRef.current?.signal,
    });
    const data = await res.json();
    assertOk("Transcribe", res, data);

    const whisperWords: { word: string; startMs: number; endMs: number }[] = data.words ?? [];
    const rawCaptions: Caption[] = data.captions ?? [];
    const durationFromServer = Number.isFinite(Number(data.audioDurationMs)) ? Number(data.audioDurationMs) : 0;
    const audioDurationMs = durationFromServer > 0
      ? durationFromServer
      : whisperWords.length ? whisperWords[whisperWords.length - 1].endMs
      : rawCaptions.length ? Math.max(...rawCaptions.map(c => c.endMs))
      : 60000;

    const MAX_CHARS = 52;
    const MIN_CHARS = 12;

    const forceSplitByLength = (cap: Caption, tag: "hook" | "body" | "cta" | undefined): Caption[] => {
      const src = (cap.text ?? "").trim();
      const capTag = tag ?? (cap.tag as "hook" | "body" | "cta" | undefined);
      if (!src) return [{ ...cap, text: src, tag: capTag }];
      if (src.length <= MAX_CHARS) return [{ ...cap, text: src, tag: capTag }];
      // ใช้ Intl.Segmenter แบ่งคำภาษาไทยได้ถูกต้อง
      const words = segmentWords(src);
      if (words.length <= 1) return [{ ...cap, text: src, tag: capTag }];
      // สร้าง chunk เป็น token arrays แล้วค่อย join ด้วย joinWords (รองรับไทย)
      const tokenChunks: string[][] = [];
      let buf: string[] = [];
      for (const tok of words) {
        const candidate = [...buf, tok];
        const candidateStr = joinWords(candidate);
        if (candidateStr.length > MAX_CHARS && buf.length > 0) {
          tokenChunks.push(buf);
          buf = [tok];
        } else {
          buf = candidate;
        }
      }
      if (buf.length > 0) tokenChunks.push(buf);
      if (!tokenChunks.length) return [{ ...cap, text: src, tag: capTag }];

      // Rebalance: รวม chunk ที่สั้นเกินเข้ากับก่อนหน้า
      const rebalanced: string[][] = [];
      for (const chunk of tokenChunks) {
        const chunkStr = joinWords(chunk);
        if (chunkStr.length < MIN_CHARS && rebalanced.length > 0) {
          const prevMerged = [...rebalanced[rebalanced.length - 1], ...chunk];
          if (joinWords(prevMerged).length <= MAX_CHARS * 2) {
            rebalanced[rebalanced.length - 1] = prevMerged;
            continue;
          }
        }
        rebalanced.push(chunk);
      }
      const finalChunks = rebalanced.filter(c => c.length > 0);
      if (finalChunks.length <= 1) return [{ ...cap, text: src, tag: capTag }];
      const span = Math.max(cap.endMs - cap.startMs, 1);
      return finalChunks.map((tokens, i) => {
        const start = cap.startMs + Math.floor((span * i) / finalChunks.length);
        const end = i === finalChunks.length - 1 ? cap.endMs : cap.startMs + Math.floor((span * (i + 1)) / finalChunks.length);
        return { text: joinWords(tokens), startMs: start, endMs: Math.max(start + 240, end), tag: capTag };
      });
    };

    let sceneCaptions: Caption[] = [];
    if (rawCaptions.length > 0) {
      sceneCaptions = rawCaptions.flatMap((cap, i) => {
        const tag = (cap.tag as "hook" | "body" | "cta" | undefined) ?? (i === 0 ? "hook" : "body");
        return forceSplitByLength(cap, tag);
      });
    }

    sceneCaptions = sceneCaptions
      .map((c, idx) => ({
        ...c, text: (c.text ?? "").trim(),
        tag: c.tag ?? (idx === 0 ? "hook" : "body"),
        startMs: Number.isFinite(c.startMs) ? Math.max(0, Math.floor(c.startMs)) : 0,
        endMs: Number.isFinite(c.endMs) ? Math.floor(c.endMs) : 0,
      }))
      .filter(c => c.text.length > 0)
      .sort((a, b) => a.startMs - b.startMs)
      .reduce<Caption[]>((acc, c) => {
        if (!acc.length) return [{ ...c, endMs: c.endMs > c.startMs ? c.endMs : c.startMs + 240 }];
        const last = acc[acc.length - 1];
        const safeStart = Math.max(c.startMs, Math.min(c.endMs - 1, last.endMs + 1));
        const safeEnd = safeStart < c.endMs ? c.endMs : safeStart + Math.max(240, c.endMs - c.startMs);
        if (safeStart >= safeEnd) return [...acc, { ...c, startMs: safeStart, endMs: safeStart + 240 }];
        return [...acc, { ...c, startMs: safeStart, endMs: safeEnd }];
      }, []);

    // ── Post-process: merge segments ที่สั้นเกินไป (< 800ms) หรือคำขาดกลางประโยค ──
    const MIN_DUR_MS = 800;
    const MAX_MERGE_CHARS = 60; // ไม่ merge ถ้าผลลัพธ์ยาวเกินนี้
    if (sceneCaptions.length > 1) {
      const merged: Caption[] = [];
      let i = 0;
      while (i < sceneCaptions.length) {
        const cur = sceneCaptions[i];
        const dur = cur.endMs - cur.startMs;
        const next = sceneCaptions[i + 1];

        // Merge เมื่อ: สั้นเกิน หรือ ข้อความดูเหมือนขาดกลางคำ (ไม่ลงท้ายด้วย punctuation/สระ/สระไทย)
        const looksIncomplete = !/[.!?ๆะ-ู็-๎เ-ไ]$/.test(cur.text.trim());
        const shouldMerge = next && (dur < MIN_DUR_MS || looksIncomplete) &&
          (cur.text.length + next.text.length + 1) <= MAX_MERGE_CHARS;

        if (shouldMerge) {
          // รวม cur + next แล้วข้ามไป i+2
          merged.push({
            text: cur.text + next.text,
            startMs: cur.startMs,
            endMs: next.endMs,
            tag: cur.tag,
          });
          i += 2;
        } else {
          merged.push(cur);
          i++;
        }
      }
      sceneCaptions = merged;
    }

    if (!sceneCaptions.length && whisperWords.length > 0) {
      const groups: Caption[] = [];
      let bucket: typeof whisperWords = [];
      let chars = 0;
      const flush = () => {
        if (!bucket.length) return;
        groups.push({ text: bucket.map(w => w.word).join(" "), startMs: bucket[0].startMs, endMs: bucket[bucket.length - 1].endMs, tag: groups.length === 0 ? "hook" : "body" });
        bucket = []; chars = 0;
      };
      for (const w of whisperWords) {
        const wc = w.word.replace(/\s/g, "").length;
        const gap = bucket.length > 0 ? w.startMs - bucket[bucket.length - 1].endMs : 0;
        if (bucket.length > 0 && (gap >= 500 || chars + wc > 20)) flush();
        bucket.push(w); chars += wc;
      }
      flush();
      sceneCaptions = groups;
    }

    pipe.current.captions = rawCaptions;
    pipe.current.sceneCaptions = sceneCaptions;
    pipe.current.audioDurationMs = audioDurationMs;
    pipe.current.words = whisperWords;
    originalCaptionsRef.current = sceneCaptions;
    setCaptions(sceneCaptions);
    setSplitMode("sentence");
    setStep("transcribe", "done", `${sceneCaptions.length} ซับ · ${(audioDurationMs / 1000).toFixed(1)}s`);
    return sceneCaptions;
  }

  async function runConfig(sv: StockVideo[], voiceUrl: string, audioDurationMs: number, caps: Caption[]) {
    setStep("config", "running");
    const res = await fetch("/api/videos/generate-config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      signal: abortControllerRef.current?.signal,
      body: JSON.stringify({
        sceneCaptions: caps, stockVideos: sv, voiceFile: voiceUrl, audioDurationMs,
        fontFamily: subFontFamily, subtitlePosition: subPosition, subtitleSize: subFontSize,
        subtitleColor: subColor, subtitleAccentColor: subAccentColor,
        subtitleStylePreset: subPreset, subtitleTextEffect: subEffect, subtitleFontWeight: subFontWeight,
        scenes: pipe.current.scenes ?? [], keywordsPerScene: pipe.current.keywordsPerScene ?? 5,
        sceneClipCounts: pipe.current.sceneClipCounts ?? [], sceneDurations: pipe.current.sceneDurations ?? [],
        preferredLLM: preferredLLMRef.current,
      }),
    });
    const data = await res.json();
    assertOk("Config", res, data);
    const cfg = data.config;
    if (bgmEnabled && bgmFile) { cfg.bgmFile = bgmFile; cfg.bgmVolume = bgmVolume; } else { delete cfg.bgmFile; }
    pipe.current.config = cfg;
    setStep("config", "done", `${(cfg.durationInFrames / 30).toFixed(0)}s`);
    return cfg;
  }

  // ── Save to Gallery (auto-called after render/burn/composite) ───────────
  // Stores videoId in pipe to UPDATE the same record across stages (no duplicates)
  async function saveToGallery(opts: {
    videoUrl: string;
    videoUrlNoSub?: string;
    audioUrl?: string;
    avatarVideoUrl?: string;
    status?: "COMPLETED" | "PROCESSING" | "FAILED";
  }) {
    try {
      // Generate thumbnail in background (don't block)
      let thumbnailUrl: string | null = null;
      try {
        const seekTime = Math.min(1.0, (pipe.current.audioDurationMs ?? 5000) / 1000 * 0.1);
        const thumbRes = await fetch("/api/videos/generate-thumbnail", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoUrl: opts.videoUrl, seekTime }),
        });
        if (thumbRes.ok) {
          const td = await thumbRes.json();
          thumbnailUrl = td.thumbnailUrl ?? null;
        }
      } catch (e) {
        console.warn("[saveToGallery] thumbnail failed:", e);
      }

      const existingVideoId = pipe.current.galleryVideoId;
      const payload = {
        videoUrl: opts.videoUrl,
        audioUrl: opts.audioUrl ?? pipe.current.voiceUrl ?? null,
        avatarVideoUrl: opts.avatarVideoUrl ?? null,
        thumbnail: thumbnailUrl,
        script: script.trim() || null,
        avatarModel: avatarId || "none",
        voiceModel: voiceId || geminiVoiceName || "unknown",
        sceneCount: pipe.current.scenes?.length ?? 1,
        renderConfig: pipe.current.config ?? null,
        status: opts.status ?? "COMPLETED",
      };

      if (existingVideoId) {
        // UPDATE existing record
        await fetch(`/api/videos/${existingVideoId}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }).catch(() => {});
      } else {
        // CREATE new record
        const res = await fetch("/api/videos", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.id) pipe.current.galleryVideoId = data.id;
        }
      }
    } catch (e) {
      console.warn("[saveToGallery] failed (non-critical):", e);
    }
  }

  async function runRender(config: unknown): Promise<string> {
    setStep("render", "running", "Rendering...");
    setRenderProgressError(null);
    renderProgressRef.current = 0;

    let renderPollTimer: ReturnType<typeof setInterval> | null = null;
    let pollStopped = false;
    let renderFailedMessage: string | null = null;
    let resolveRenderUrl: ((url: string) => void) | null = null;
    let currentJobId: string | null = null;

    const stopPoll = () => {
      pollStopped = true;
      if (renderPollTimer) { clearInterval(renderPollTimer); renderPollTimer = null; }
    };
    stopRenderPollRef.current = stopPoll;

    renderPollTimer = setInterval(async () => {
      if (pollStopped || !currentJobId) return;
      try {
        const r = await fetch(`/api/videos/render-progress?jobId=${encodeURIComponent(currentJobId)}`, { cache: "no-store", signal: abortControllerRef.current?.signal });
        if (!r.ok) return;
        const d = await r.json() as { progress?: number; videoUrl?: string | null; error?: string | null };
        if (d.videoUrl) {
          // progress file บอก done → resolve ทันที แล้วหยุด poll ทั้งคู่
          if (resolveRenderUrl) { resolveRenderUrl(d.videoUrl); resolveRenderUrl = null; }
          stopPoll();
          return;
        }
        if (d.error) { renderFailedMessage = d.error; setRenderProgressError(d.error); setStep("render", "error", d.error); return; }
        const p = Number(d.progress);
        if (Number.isFinite(p)) { setRenderProgress(Math.min(100, Math.max(0, Math.round(p)))); setStep("render", "running", `Rendering... ${Math.round(p)}%`); }
      } catch {}
    }, 600);

    try {
      // Always rebuild keywordPopups from current captions so render matches preview exactly
      const fps = 30;
      const currentCaps = captionsRef.current;
      const freshPopups = currentCaps.map(c => ({
        text: c.text,
        start: Math.round(c.startMs / 1000 * fps),
        end: Math.round(c.endMs / 1000 * fps),
        tag: c.tag ?? "body",
        isHighlight: c.tag === "hook",
        color: subPreset === "karaoke-box" ? subColor : c.tag === "hook" ? subAccentColor : subColor,
        accentColor: subAccentColor,
        fontWeight: subFontWeight,
        topPercent: subPosition,
        size: subFontSize,
        stylePreset: subPreset,
      }));
      // includeSubtitles=false → ส่ง keywordPopups เปล่า → Remotion ไม่แสดงซับ
      // Always render without subtitles — Burn Subtitles step adds them via SubtitleOverlayComposition
      const patchedConfig = config && typeof config === "object" ? {
        ...(config as Record<string, unknown>),
        subtitleStylePreset: subPreset,
        subtitleTextEffect: subEffect,
        subtitleAccentColor: subAccentColor,
        fontFamily: subFontFamily,
        keywordPopups: [],
      } : config;

      const res = await fetch("/api/videos/render", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shortVideoConfig: patchedConfig }),
        signal: abortControllerRef.current?.signal,
      });
      if (renderFailedMessage) throw new Error(renderFailedMessage);
      const data = await res.json();
      assertOk("Render", res, data);

      const jobId = data.jobId as string | undefined;
      const immediateUrl = data.videoUrl as string | undefined;
      if (immediateUrl) {
        pipe.current.renderedVideoUrl = immediateUrl;
        setPreRenderUrl(immediateUrl); setVideoUrl(immediateUrl);
        setStep("render", "done", immediateUrl); setRenderProgress(100); return immediateUrl;
      }
      if (!jobId) throw new Error("Render server did not return jobId");
      currentJobId = jobId; activeJobIdRef.current = jobId;
      // Save jobId ลง sessionStorage เพื่อ resume ถ้า hot-reload หรือ page refresh
      try { sessionStorage.setItem("ve_pending_render_jobId", jobId); sessionStorage.setItem("ve_pending_render_ts", String(Date.now())); } catch {}

      let statusNotFoundCount = 0;
      const url = await new Promise<string>((resolve, reject) => {
        resolveRenderUrl = resolve;
        const si = setInterval(async () => {
          if (activeJobIdRef.current !== jobId) { clearInterval(si); resolveRenderUrl = null; reject(new Error("__SUPERSEDED__")); return; }
          if (renderFailedMessage) { clearInterval(si); reject(new Error(renderFailedMessage)); return; }
          // ถ้า progress poll resolve แล้ว resolveRenderUrl จะเป็น null → หยุด si ด้วย
          if (!resolveRenderUrl) { clearInterval(si); return; }
          try {
            const sr = await fetch(`/api/videos/render-status?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store", signal: abortControllerRef.current?.signal });
            const sd = await sr.json();
            if (activeJobIdRef.current !== jobId) { clearInterval(si); resolveRenderUrl = null; reject(new Error("__SUPERSEDED__")); return; }
            if (sd.status === "done" && sd.videoUrl) { clearInterval(si); resolveRenderUrl = null; resolve(sd.videoUrl as string); }
            else if (sd.status === "error") { clearInterval(si); resolveRenderUrl = null; reject(new Error(sd.error ?? "Render failed")); }
            else if (sd.status === "not_found" || sr.status === 404) {
              statusNotFoundCount++;
              // hot-reload ทำให้ in-memory jobs หายไป — อ่าน progress file โดยตรงแทน
              // ถ้า not_found >=3 ครั้ง ให้ fallback ไปรอ progress poll เพียงอย่างเดียว (จะ resolve ผ่าน renderPollTimer)
              if (statusNotFoundCount >= 3) {
                clearInterval(si);
                // ไม่ reject — ปล่อยให้ renderPollTimer (600ms) ทำงานต่อ
                // มันจะ resolve เมื่อ progress file มี videoUrl
                console.warn(`[render] render-status not_found ×${statusNotFoundCount} — falling back to progress-file polling`);
              }
            }
          } catch (e) { if (e instanceof Error && e.name === "AbortError") { clearInterval(si); resolveRenderUrl = null; reject(e); } }
        }, 3000);
      });

      if (activeJobIdRef.current !== jobId) throw new Error("__SUPERSEDED__");
      // Render always produces a no-sub video — Burn Subtitles adds them separately
      pipe.current.renderedVideoUrl = url;
      pipe.current.renderedVideoNoSubUrl = url;
      setPreRenderUrl(url); setVideoUrl(url);
      // Auto-save to gallery (creates record on first render, updates on subsequent)
      saveToGallery({ videoUrl: url, videoUrlNoSub: url, status: "COMPLETED" });
      // Snapshot style at render time so user can reset back to this
      lastRenderedStyleRef.current = {
        fontFamily: subFontFamily, fontSize: subFontSize, fontWeight: subFontWeight,
        color: subColor, accentColor: subAccentColor, preset: subPreset,
        effect: subEffect, position: subPosition,
        captions: captionsRef.current.map(c => ({ ...c })),
      };
      setStyleIsDirty(false);
      try { sessionStorage.removeItem("ve_pending_render_jobId"); sessionStorage.removeItem("ve_pending_render_ts"); } catch {}
      setStep("render", "done", url); setRenderProgress(100); return url;
    } catch (err) {
      if (err instanceof Error && err.message === "__SUPERSEDED__") throw err;
      try { sessionStorage.removeItem("ve_pending_render_jobId"); sessionStorage.removeItem("ve_pending_render_ts"); } catch {}
      if (!renderFailedMessage && !(err instanceof Error && err.name === "AbortError")) {
        const msg = friendlyError(err);
        setRenderProgressError(msg); setStep("render", "error", msg);
      }
      throw err;
    } finally {
      stopPoll(); stopRenderPollRef.current = null;
    }
  }

  // ── Avatar pipeline ────────────────────────────────────────────────────

  async function runAvatar(audioUrl: string, trimSecs?: number): Promise<string> {
    // Direct URL mode — skip HeyGen, use URL directly
    if (avatarInputMode === "direct") {
      if (!avatarDirectUrl.trim()) throw new Error("กรอก Avatar Video URL ก่อน");
      setStep("avatar", "running", "Using direct URL...");
      setAvatarGreenUrl(avatarDirectUrl.trim());
      setStep("avatar", "done", avatarDirectUrl.trim());
      return avatarDirectUrl.trim();
    }

    setStep("avatar", "running", "HeyGen generating...");
    setAvatarGreenUrl("");

    // Trim audio only for bookend modes
    let avatarAudioUrl = audioUrl;
    if ((avatarTiming === "bookend" || avatarTiming === "bookend-both") && (trimSecs ?? avatarBookendSecs) > 0) {
      const secs = trimSecs ?? avatarBookendSecs;
      setStep("avatar", "running", `Trimming intro audio to ${secs}s...`);
      const trimRes = await fetch("/api/videos/trim-audio", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioUrl, durationSecs: secs }),
        signal: abortControllerRef.current?.signal,
      });
      const trimData = await trimRes.json();
      assertOk("Trim audio", trimRes, trimData);
      avatarAudioUrl = trimData.audioUrl;
    }

    const genRes = await fetch("/api/heygen/generate-with-bg", {
      method: "POST", headers: { "Content-Type": "application/json" },
      signal: abortControllerRef.current?.signal,
      body: JSON.stringify({ audioUrl: avatarAudioUrl, avatarId, greenScreen: true, scale: avatarScale, offsetX: avatarOffsetX, offsetY: avatarOffsetY }),
    });
    const genData = await genRes.json();
    assertOk("Avatar", genRes, genData);
    const heygenVideoId = genData.videoId as string;
    setStep("avatar", "running", `HeyGen: ${heygenVideoId} — polling...`);

    let avatarVideoUrl = "";
    for (let i = 0; i < 360; i++) {
      await new Promise(r => setTimeout(r, 5000));
      if (abortRef.current) throw new Error("__SUPERSEDED__");
      if (document.visibilityState === "hidden") {
        await new Promise<void>(resolve => {
          const h = () => { if (abortRef.current || document.visibilityState === "visible") { document.removeEventListener("visibilitychange", h); resolve(); } };
          document.addEventListener("visibilitychange", h);
        });
      }
      if (abortRef.current) throw new Error("__SUPERSEDED__");
      try {
        const pollRes = await fetch("/api/videos/poll-avatar", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoId: heygenVideoId }),
          signal: abortControllerRef.current?.signal,
        });
        const pollData = await pollRes.json();
        if (pollData.status === "completed" && pollData.videoUrl) { avatarVideoUrl = pollData.videoUrl; break; }
        if (pollData.status === "failed") throw new Error(`Avatar failed: ${pollData.errorMsg ?? "unknown"}`);
        setStep("avatar", "running", `HeyGen: ${pollData.status} (${i + 1}) ~${Math.round((i + 1) * 5 / 60)}min`);
      } catch (e) { if (e instanceof Error && (e.name === "AbortError" || e.message === "__SUPERSEDED__")) throw e; }
    }
    if (!avatarVideoUrl) throw new Error("Avatar: timeout หลัง 30 นาที");
    setAvatarGreenUrl(avatarVideoUrl);
    setStep("avatar", "done", "Avatar พร้อม");
    return avatarVideoUrl;
  }

  async function runComposite(bgVideoUrl: string, avatarUrl: string, tailAvatarUrl?: string): Promise<string> {
    const isDirect = avatarInputMode === "direct";
    setStep("composite", "running", isDirect ? "วางทับวิดีโอ (Direct URL)..." : "Chromakey + composite...");
    const compRes = await fetch("/api/heygen/composite", {
      method: "POST", headers: { "Content-Type": "application/json" },
      signal: abortControllerRef.current?.signal,
      body: isDirect
        ? JSON.stringify({
            avatarVideoUrl: avatarUrl,
            bgVideoUrl,
            mode: "chromakey",
            noScale: true,
            chromaColor: "0x00ff00",
            chromaSimilarity,
            chromaBlend,
          })
        : JSON.stringify({
            avatarVideoUrl: avatarUrl,
            ...(avatarTiming === "bookend-both" && tailAvatarUrl ? { tailAvatarVideoUrl: tailAvatarUrl } : {}),
            bgVideoUrl,
            mode: "chromakey",
            avatarTiming,
            avatarBookendSecs,
            avatarTailSecs,
            avatarScale,
            avatarOffsetX,
            avatarOffsetY,
            chromaColor: "0x00ff00",
            chromaSimilarity,
            chromaBlend,
          }),
    });
    const compData = await compRes.json();
    assertOk("Composite", compRes, compData);
    const finalUrl = compData.videoUrl as string;
    pipe.current.compositeUrl = finalUrl;
    setVideoUrl(finalUrl);
    setStep("composite", "done", finalUrl);
    // Update Gallery — composite is the final video for avatar mode
    saveToGallery({
      videoUrl: finalUrl,
      avatarVideoUrl: avatarUrl,
      status: "COMPLETED",
    });
    return finalUrl;
  }

  async function runAvatarTail(audioUrl: string): Promise<string> {
    setStep("avatarTail", "running", `Trimming tail audio ${avatarTailSecs}s...`);
    setAvatarTailGreenUrl("");
    const trimRes = await fetch("/api/videos/trim-audio", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioUrl, durationSecs: avatarTailSecs, fromEnd: true }),
      signal: abortControllerRef.current?.signal,
    });
    const trimData = await trimRes.json();
    assertOk("Trim tail audio", trimRes, trimData);
    setStep("avatarTail", "running", "HeyGen generating tail avatar...");
    const genRes = await fetch("/api/heygen/generate-with-bg", {
      method: "POST", headers: { "Content-Type": "application/json" },
      signal: abortControllerRef.current?.signal,
      body: JSON.stringify({ audioUrl: trimData.audioUrl, avatarId, greenScreen: true, scale: avatarScale, offsetX: avatarOffsetX, offsetY: avatarOffsetY }),
    });
    const genData = await genRes.json();
    assertOk("Tail Avatar", genRes, genData);
    let tailUrl = "";
    for (let i = 0; i < 360; i++) {
      await new Promise(r => setTimeout(r, 5000));
      if (abortRef.current) throw new Error("__SUPERSEDED__");
      const pollRes = await fetch("/api/videos/poll-avatar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: genData.videoId }),
        signal: abortControllerRef.current?.signal,
      });
      const pollData = await pollRes.json();
      if (pollData.status === "completed" && pollData.videoUrl) { tailUrl = pollData.videoUrl; break; }
      if (pollData.status === "failed") throw new Error(`Tail avatar failed: ${pollData.errorMsg}`);
    }
    if (!tailUrl) throw new Error("Tail avatar: timeout");
    setAvatarTailGreenUrl(tailUrl);
    setStep("avatarTail", "done", "Tail avatar พร้อม");
    return tailUrl;
  }

  async function runAvatarPipeline() {
    if (!pipe.current.renderedVideoUrl) { toast.error("ต้อง Render วิดีโอก่อน"); return; }
    const isDirect = avatarInputMode === "direct";
    if (isDirect) {
      if (!avatarDirectUrl.trim()) { toast.error("กรอก Avatar Video URL ก่อน"); return; }
    } else {
      if (!avatarId.trim()) { toast.error("กรอก HeyGen Avatar ID ก่อน"); return; }
      if (!pipe.current.voiceUrl) { toast.error("ต้องสร้างเสียง TTS ก่อน"); return; }
    }
    if (runningRef.current) return;
    runningRef.current = true; setRunning(true);
    abortRef.current = false;
    abortControllerRef.current = new AbortController();
    try {
      // Direct mode: avatar video URL มีเสียงอยู่แล้ว — ไม่ต้องใช้ voiceUrl
      const audioUrl = isDirect ? avatarDirectUrl.trim() : pipe.current.voiceUrl!;
      const avUrl = avatarGreenUrl || await runAvatar(audioUrl);
      if (abortRef.current) return;
      let tailUrl: string | undefined;
      if (!isDirect && avatarTiming === "bookend-both") {
        tailUrl = avatarTailGreenUrl || await runAvatarTail(audioUrl);
        if (abortRef.current) return;
      }
      await runComposite(pipe.current.renderedVideoUrl, avUrl, tailUrl);
      toast.success("Avatar composite เสร็จแล้ว!");
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.message === "__SUPERSEDED__")) return;
      if (handlePlanError(err)) return;
      if (!handleMissingKey(err, "runAvatarPipeline")) toast.error(friendlyError(err));
    } finally {
      runningRef.current = false; setRunning(false);
    }
  }

  // ── ตรวจสอบว่าซับตรงกับเสียง + script จริงๆ ──────────────────────────
  function checkCaptionAlignment(
    caps: Caption[],
    rawScript: string,
    sceneCount: number,
    audioDurationMs: number,
  ) {
    // 1. Count check — ซับน้อยเกินไปเทียบกับ scene
    if (sceneCount > 0 && caps.length < Math.ceil(sceneCount / 2)) {
      toast.warning(
        `⚠ ได้ซับเพียง ${caps.length} segment สำหรับ ${sceneCount} scene — เสียงอาจไม่ตรงกับ script`,
        { duration: 10000 }
      );
      return; // ปัญหาชัดเจนมากแล้ว ไม่ต้องตรวจต่อ
    }

    // 2. Token overlap — เปรียบเทียบคำใน script กับ transcribed text
    const cleanThai = (s: string) =>
      s.replace(/[^฀-๿a-zA-Z0-9]/g, " ").toLowerCase().trim();

    const scriptTokens = segmentWords(cleanThai(rawScript)).filter(t => t.length >= 2);
    const transText = caps.map(c => c.text).join(" ");
    const transTokens = new Set(segmentWords(cleanThai(transText)).filter(t => t.length >= 2));

    if (scriptTokens.length === 0) return; // script ว่าง ข้ามได้

    const matched = scriptTokens.filter(t => transTokens.has(t)).length;
    const coverage = matched / scriptTokens.length;

    // 3. Timing check — ซับสุดท้ายกับ audio duration ต่างกันมากไหม
    let timingMsg = "";
    if (audioDurationMs > 0 && caps.length > 0) {
      const lastSubMs = Math.max(...caps.map(c => c.endMs));
      const gapSec = Math.abs(lastSubMs - audioDurationMs) / 1000;
      if (gapSec > 5) {
        timingMsg = ` · ซับสิ้นสุดที่ ${(lastSubMs / 1000).toFixed(1)}s แต่เสียงยาว ${(audioDurationMs / 1000).toFixed(1)}s`;
      }
    }

    if (coverage < 0.40) {
      // ตรงกันน้อยกว่า 40% — น่าจะผิดภาษาหรือ script ไม่ตรงกับเสียง
      toast.error(
        `❌ ซับตรงกับ script เพียง ${Math.round(coverage * 100)}% — อาจเกิดจาก: เสียงไม่ตรงกับ script, ภาษาต่างกัน, หรือ script มีอักขระพิเศษ${timingMsg}`,
        { duration: 12000 }
      );
    } else if (coverage < 0.65) {
      // ตรงกัน 40–65% — แจ้งเตือน
      toast.warning(
        `⚠ ซับตรงกับ script ${Math.round(coverage * 100)}% — บางส่วนอาจคลาดเคลื่อน กรุณาตรวจสอบใน Subtitle panel${timingMsg}`,
        { duration: 8000 }
      );
    } else if (timingMsg) {
      // coverage OK แต่ timing ห่าง
      toast.warning(`⚠ ซับ OK (${Math.round(coverage * 100)}%)${timingMsg} — ตรวจสอบ Transcribe`, { duration: 6000 });
    }
    // coverage >= 65% และ timing OK → ไม่แจ้ง (ปกติดี)
  }

  // ── Run all pipeline ───────────────────────────────────────────────────

  const runAll = useCallback(async () => {
    if (runningRef.current || !script.trim()) return;

    // Item 1: ตรวจสอบ API keys ที่จำเป็นก่อนเริ่ม pipeline
    try {
      const keysRes = await fetch("/api/user/api-keys");
      if (keysRes.ok) {
        const keysData = await keysRes.json();
        // Gemini ต้องการสำหรับ extract-keywords, transcribe, config
        if (!keysData.geminiKey) {
          setMissingKey({ type: "gemini", retryStep: "runAll" });
          return;
        }
        // ElevenLabs TTS ต้องการ key
        if (ttsProvider === "elevenlabs" && !keysData.elevenlabsKey) {
          setMissingKey({ type: "elevenlabs", retryStep: "runAll" });
          return;
        }
        // HeyGen avatar ต้องการ key (ถ้าเปิดใช้งาน generate mode)
        if (useAvatar && avatarInputMode === "generate" && !keysData.heygenKey) {
          setMissingKey({ type: "heygen", retryStep: "runAll" });
          return;
        }
        // Pexels/Pixabay key check
        if ((stockSource === "pexels" || stockSource === "both") && !keysData.pexelsKey) {
          setMissingKey({ type: "pexels", retryStep: "runAll" });
          return;
        }
        if ((stockSource === "pixabay" || stockSource === "both") && !keysData.pixabayKey) {
          setMissingKey({ type: "pixabay", retryStep: "runAll" });
          return;
        }
      }
    } catch { /* ถ้าตรวจสอบ key ไม่ได้ ปล่อยผ่านและให้ pipeline จัดการ */ }

    runningRef.current = true; setRunning(true);
    abortRef.current = false;
    abortControllerRef.current = new AbortController();
    setSteps({ ...DEFAULT_STEPS }); stepsRef.current = { ...DEFAULT_STEPS };

    const isDirectMode = avatarInputMode === "direct" && !!avatarDirectUrl.trim();

    try {
      // ── TTS first to know actual audio duration ──
      // This makes keyword count accurate (was previously estimating from script length).
      let vUrl: string;
      if (isDirectMode) {
        setStep("tts", "skip", "ข้าม — ใช้เสียงจาก Direct URL");
        vUrl = avatarDirectUrl.trim();
        pipe.current.voiceUrl = vUrl;
      } else {
        vUrl = await runTts();
        if (abortRef.current) return;
      }

      // ── Transcribe to get audioDurationMs into pipe.current ──
      const caps = await runTranscribe(vUrl);
      if (abortRef.current) return;

      // ── Now extract keywords with accurate duration ──
      const kws  = await runKeywords();
      if (abortRef.current) return;
      const sv   = await runFetchStock(kws);
      if (abortRef.current) return;

      // ── ตรวจสอบว่าซับตรงกับเสียงจริงๆ ไหม ──
      checkCaptionAlignment(caps, script, (pipe.current.scenes ?? []).length, pipe.current.audioDurationMs ?? 0);

      const cfg  = await runConfig(sv, vUrl, pipe.current.audioDurationMs ?? 0, caps);
      if (abortRef.current) return;
      const renderedUrl = await runRender(cfg);
      if (abortRef.current) return;

      if (isDirectMode) {
        const avUrl = await runAvatar(vUrl);
        if (abortRef.current) return;
        await runComposite(renderedUrl, avUrl);
        if (abortRef.current) return;
      }

      await runBurnSubtitles();
      if (!abortRef.current) toast.success("เสร็จแล้ว! วิดีโอพร้อม Download");
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.message === "__SUPERSEDED__")) return;
      if (handlePlanError(err)) return;
      if (!handleMissingKey(err, "runAll")) toast.error(friendlyError(err));
    } finally {
      runningRef.current = false; setRunning(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [script, ttsProvider, voiceId, geminiVoiceName, subFontFamily, subFontSize, subFontWeight, subColor, subAccentColor, subPreset, subEffect, subPosition, bgmEnabled, bgmFile, bgmVolume, stockSource, useAvatar, avatarId, avatarInputMode, avatarDirectUrl]);

  // Resume pipeline from a specific step — reuses cached data for earlier steps
  async function runFrom(startStep: keyof StepState) {
    if (runningRef.current) return;
    if (!script.trim()) { toast.error("กรุณาใส่ script ก่อน"); return; }
    runningRef.current = true; setRunning(true);
    abortRef.current = false;
    abortControllerRef.current = new AbortController();
    try {
      // ── Always ensure we have voice + caps first (so keywords gets accurate duration) ──
      let vUrl = pipe.current.voiceUrl ?? "";
      if (!vUrl || startStep === "tts") {
        vUrl = await runTts();
        if (abortRef.current) return;
      }

      let caps = pipe.current.captions ?? [];
      if (caps.length === 0 || startStep === "transcribe" || startStep === "tts") {
        caps = await runTranscribe(vUrl);
        if (abortRef.current) return;
        checkCaptionAlignment(caps, script, (pipe.current.scenes ?? []).length, pipe.current.audioDurationMs ?? 0);
      }

      // ── Now keywords + stock with accurate duration ──
      let kws = pipe.current.keywords ?? [];
      if (startStep === "keywords" || kws.length === 0) {
        kws = await runKeywords();
        if (abortRef.current) return;
        startStep = "fetchStock";
      }

      let sv = pipe.current.stockVideos ?? [];
      if (startStep === "fetchStock" || sv.length === 0) {
        sv = await runFetchStock(kws);
        if (abortRef.current) return;
      }

      let cfg = pipe.current.config;
      if (startStep === "config" || !cfg) {
        cfg = await runConfig(sv, vUrl, pipe.current.audioDurationMs ?? 0, caps);
        if (abortRef.current) return;
        startStep = "render";
      }

      if (startStep === "render") {
        await runRender(cfg);
        if (abortRef.current) return;
      }

      await runBurnSubtitles();
      if (!abortRef.current) toast.success("เสร็จแล้ว! วิดีโอพร้อม Download");
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.message === "__SUPERSEDED__")) return;
      if (handlePlanError(err)) return;
      if (!handleMissingKey(err, "runAll")) toast.error(friendlyError(err));
    } finally {
      runningRef.current = false; setRunning(false);
    }
  }

  // Re-run render only (ใช้ stock/voice/config เดิม เปลี่ยนแค่ซับ+style)
  async function runRenderOnly() {
    if (runningRef.current) return;
    if (!pipe.current.config) { toast.error("ต้อง Run pipeline ครั้งแรกก่อน"); return; }
    runningRef.current = true; setRunning(true);
    abortRef.current = false;
    abortControllerRef.current = new AbortController();
    try {
      await runRender(pipe.current.config);
      if (abortRef.current) return;
      await runBurnSubtitles();
      if (!abortRef.current) toast.success("Render + Burn Subtitles เสร็จแล้ว!");
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.message === "__SUPERSEDED__")) return;
      if (!handlePlanError(err)) toast.error(friendlyError(err));
    } finally {
      runningRef.current = false; setRunning(false);
    }
  }

  // Burn subtitles onto an already-rendered (no-sub) video using SubtitleOverlayComposition
  async function runBurnSubtitles() {
    const baseVideo = pipe.current.renderedVideoNoSubUrl;
    if (!baseVideo) { toast.error("ต้อง Render วิดีโอก่อน แล้วค่อย Burn Subtitles"); return; }
    if (!captions.length) { toast.error("ไม่มีซับให้ Burn — กรุณา Transcribe ก่อน"); return; }
    if (runningRef.current) return;
    runningRef.current = true; setRunning(true);
    abortRef.current = false;
    abortControllerRef.current = new AbortController();
    setStep("burnSubtitles", "running", "Burning subtitles...");
    setRenderProgressError(null);
    renderProgressRef.current = 0;

    let burnPollTimer: ReturnType<typeof setInterval> | null = null;
    let pollStopped = false;
    let burnFailedMessage: string | null = null;
    let resolveBurnUrl: ((url: string) => void) | null = null;
    let currentJobId: string | null = null;

    const stopPoll = () => {
      pollStopped = true;
      if (burnPollTimer) { clearInterval(burnPollTimer); burnPollTimer = null; }
    };

    burnPollTimer = setInterval(async () => {
      if (pollStopped || !currentJobId) return;
      try {
        const r = await fetch(`/api/videos/render-progress?jobId=${encodeURIComponent(currentJobId)}`, { cache: "no-store", signal: abortControllerRef.current?.signal });
        if (!r.ok) return;
        const d = await r.json() as { progress?: number; videoUrl?: string | null; error?: string | null };
        if (d.videoUrl && resolveBurnUrl) { resolveBurnUrl(d.videoUrl); resolveBurnUrl = null; return; }
        if (d.error) { burnFailedMessage = d.error; setRenderProgressError(d.error); setStep("burnSubtitles", "error", d.error); return; }
        const p = Number(d.progress);
        if (Number.isFinite(p)) { setRenderProgress(Math.min(100, Math.max(0, Math.round(p)))); setStep("burnSubtitles", "running", `Burning... ${Math.round(p)}%`); }
      } catch {}
    }, 600);

    try {
      const fps = 30;
      const currentCaps = captionsRef.current;
      const keywordPopups = currentCaps.map(c => ({
        text: c.text,
        start: Math.round(c.startMs / 1000 * fps),
        end: Math.round(c.endMs / 1000 * fps),
        tag: c.tag ?? "body",
        isHighlight: c.tag === "hook",
        color: subPreset === "karaoke-box" ? subColor : c.tag === "hook" ? subAccentColor : subColor,
        accentColor: subAccentColor,
        fontWeight: subFontWeight,
        topPercent: subPosition,
        size: subFontSize,
        stylePreset: subPreset,
      }));

      // คำนวณ durationInFrames จาก audioDurationMs หรือ captions สุดท้าย
      const audioDurMs = pipe.current.audioDurationMs ?? 0;
      const lastCapMs = currentCaps.length > 0 ? Math.max(...currentCaps.map(c => c.endMs)) : 0;
      const durMs = Math.max(audioDurMs, lastCapMs, 1000);
      const durationInFrames = Math.max(Math.round(durMs / 1000 * fps), fps);

      const subtitleOverlayConfig = {
        videoUrl: baseVideo,
        keywordPopups,
        durationInFrames,
        fontFamily: subFontFamily,
        subtitleStylePreset: subPreset,
        subtitleTextEffect: subEffect,
        subtitleAccentColor: subAccentColor,
      };

      const res = await fetch("/api/videos/render", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subtitleOverlayConfig }),
        signal: abortControllerRef.current?.signal,
      });
      const data = await res.json() as { jobId?: string; videoUrl?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Burn subtitles failed");

      const finalizeBurn = (url: string) => {
        // Store in dedicated field only — do not touch preview (videoUrl/preRenderUrl)
        pipe.current.burnedVideoUrl = url;
        lastRenderedStyleRef.current = {
          fontFamily: subFontFamily, fontSize: subFontSize, fontWeight: subFontWeight,
          color: subColor, accentColor: subAccentColor, preset: subPreset, effect: subEffect, position: subPosition,
          captions: captionsRef.current.map(c => ({ ...c })),
        };
        setStep("burnSubtitles", "done", url);
        setRenderProgress(100);
        // Update Gallery: replace videoUrl with the burned-in version (final result)
        saveToGallery({
          videoUrl: url,
          videoUrlNoSub: pipe.current.renderedVideoNoSubUrl,
          status: "COMPLETED",
        });
        toast.success("Burn Subtitles เสร็จแล้ว! วิดีโอมีซับพร้อม Download");
      };

      if (data.videoUrl) {
        finalizeBurn(data.videoUrl);
        return;
      }

      const jobId = data.jobId;
      if (!jobId) throw new Error("Burn subtitles: no jobId returned");
      currentJobId = jobId;
      activeJobIdRef.current = jobId;

      // Check immediately in case server already finished (fast burn or bundle was cached)
      const checkOnce = async (): Promise<string | null> => {
        try {
          // Try progress file first (more reliable, written before in-memory job map)
          const pr = await fetch(`/api/videos/render-progress?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store" });
          if (pr.ok) {
            const pd = await pr.json() as { progress?: number; videoUrl?: string | null; error?: string | null };
            if (pd.videoUrl) return pd.videoUrl;
            if (pd.error) throw new Error(pd.error);
          }
          const sr = await fetch(`/api/videos/render-status?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store" });
          const sd = await sr.json() as { status?: string; videoUrl?: string; error?: string };
          if (sd.status === "done" && sd.videoUrl) return sd.videoUrl;
          if (sd.status === "error") throw new Error(sd.error ?? "Burn subtitles failed");
        } catch (e) {
          if (e instanceof Error && e.message && e.message !== "Failed to fetch") throw e;
        }
        return null;
      };

      const immediate = await checkOnce();
      if (immediate) { finalizeBurn(immediate); return; }

      const url = await new Promise<string>((resolve, reject) => {
        resolveBurnUrl = resolve;
        const si = setInterval(async () => {
          if (activeJobIdRef.current !== jobId) { clearInterval(si); resolveBurnUrl = null; reject(new Error("__SUPERSEDED__")); return; }
          if (burnFailedMessage) { clearInterval(si); reject(new Error(burnFailedMessage)); return; }
          try {
            const found = await checkOnce();
            if (activeJobIdRef.current !== jobId) { clearInterval(si); resolveBurnUrl = null; reject(new Error("__SUPERSEDED__")); return; }
            if (found) { clearInterval(si); resolveBurnUrl = null; resolve(found); }
          } catch (e) {
            if (e instanceof Error && e.name === "AbortError") { clearInterval(si); resolveBurnUrl = null; reject(e); return; }
            clearInterval(si); resolveBurnUrl = null; reject(e instanceof Error ? e : new Error(String(e)));
          }
        }, 2000);
      });

      finalizeBurn(url);
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.message === "__SUPERSEDED__")) return;
      const msg = err instanceof Error ? err.message : String(err);
      setStep("burnSubtitles", "error", msg);
      toast.error(msg);
    } finally {
      stopPoll();
      runningRef.current = false; setRunning(false);
    }
  }

  // Mark dirty เมื่อ style หรือ captions เปลี่ยนหลัง render
  useEffect(() => {
    const snap = lastRenderedStyleRef.current;
    if (!snap) return;
    const changed =
      snap.fontFamily !== subFontFamily || snap.fontSize !== subFontSize ||
      snap.fontWeight !== subFontWeight || snap.color !== subColor ||
      snap.accentColor !== subAccentColor || snap.preset !== subPreset ||
      snap.effect !== subEffect || snap.position !== subPosition ||
      snap.captions.length !== captionsRef.current.length ||
      snap.captions.some((c, i) => {
        const cur = captionsRef.current[i];
        return !cur || c.text !== cur.text || c.startMs !== cur.startMs || c.endMs !== cur.endMs;
      });
    setStyleIsDirty(changed);
  }, [subFontFamily, subFontSize, subFontWeight, subColor, subAccentColor, subPreset, subEffect, subPosition, captions]);

  function stopAll() {
    abortRef.current = true;
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController(); // fresh controller for next run
    stopRenderPollRef.current?.();
    stopRenderPollRef.current = null;
    runningRef.current = false;
    setRunning(false);
    // Reset any step stuck in "running" → idle
    setSteps(prev => {
      const next = { ...prev };
      (Object.keys(next) as (keyof StepState)[]).forEach(k => {
        if (next[k] === "running") next[k] = "idle";
      });
      return next;
    });
    toast("หยุดแล้ว");
  }

  // ── Segments from script (left panel preview only — NOT used for video overlay) ──
  const segments = script.split(/\n+/).map(s => s.trim()).filter(Boolean);

  // displayCaptions = real transcribed captions after render, or [] before render
  // We never use script-segments as fake captions for the video overlay
  const displayCaptions = captions; // always real captions from transcribe step

  // Script segments for left panel list when no captions yet
  const scriptSegments = captions.length === 0
    ? segments.map((s, i) => ({ text: s, startMs: i * 3000, endMs: (i + 1) * 3000, tag: i === 0 ? "hook" as const : i === segments.length - 1 ? "cta" as const : "body" as const }))
    : captions;

  const totalMs = durationMs > 0 ? durationMs : 0;

  // activeSub: only show when video is ready AND a caption is active at current time
  const hasVideo = !!(videoUrl || preRenderUrl);
  const activeSub = hasVideo && captions.length > 0 && activeCaptionIdx >= 0
    ? captions[activeCaptionIdx]
    : null;

  function fmtMs(ms: number) {
    const s = Math.floor(ms / 1000); const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  }

  // แบ่งคำภาษาไทย/ผสมด้วย Intl.Segmenter (built-in ใน Node 16+ และ browser ทุกตัว)
  // ถ้า runtime ไม่รองรับ Segmenter จะ fallback เป็น split ด้วย space
  function segmentWords(text: string): string[] {
    const isThai = /[฀-๿]/.test(text);
    if (!isThai) return text.split(/\s+/).filter(Boolean);
    try {
      // word granularity — ตัด "คำ" ไม่ใช่ "ตัวอักษร"
      const seg = new Intl.Segmenter("th", { granularity: "word" });
      return [...seg.segment(text)]
        .filter(s => s.isWordLike)
        .map(s => s.segment)
        .filter(Boolean);
    } catch {
      // fallback: แบ่งที่ space (ภาษาอังกฤษ) หรือส่งทั้งก้อน (ไทย)
      return text.split(/\s+/).filter(Boolean);
    }
  }

  // Join token list กลับเป็น string — ไทย+ไทย ไม่ใส่ space, อื่นๆ ใส่ space
  function joinWords(words: string[]): string {
    const isThai = (s: string) => /[฀-๿]/.test(s);
    let out = "";
    for (const raw of words) {
      const w = raw.trim();
      if (!w) continue;
      if (!out) { out = w; continue; }
      const prev = out[out.length - 1];
      const noSpace = isThai(prev) && isThai(w[0]);
      out += noSpace ? w : ` ${w}`;
    }
    return out;
  }

  // Merge Whisper syllables ที่อยู่ติดกัน (gap < threshold) เป็น "คำ" เดียว
  // Whisper ภาษาไทยมักแยก วง+การ, นัก+พัฒนา ฯลฯ เป็น syllable แยก
  function mergeWhisperSyllables(
    rawWords: { word: string; startMs: number; endMs: number }[],
    syllableGapMs = 80,
  ): { word: string; startMs: number; endMs: number }[] {
    if (rawWords.length === 0) return [];
    const isThai = (s: string) => /[฀-๿]/.test(s);
    // ── Detect interpolated input ───────────────────────────────────────
    // If most words are already full Thai words (>=2 chars) AND >50% have
    // back-to-back timing (gap == 0), this came from segment-interpolation,
    // not from real Whisper syllable splits. In that case skip merging entirely.
    const total = rawWords.length;
    let backToBack = 0;
    let multiCharThai = 0;
    for (let i = 0; i < total; i++) {
      const w = rawWords[i];
      if (isThai(w.word) && w.word.length >= 2) multiCharThai++;
      if (i > 0 && w.startMs - rawWords[i - 1].endMs <= 1) backToBack++;
    }
    const looksInterpolated = multiCharThai / total > 0.6 && backToBack / Math.max(1, total - 1) > 0.5;
    if (looksInterpolated) {
      // Already word-level — return cleaned but unmerged
      return rawWords.map(w => ({ ...w, word: w.word.trim() })).filter(w => w.word.length > 0);
    }

    // Real Whisper syllables — merge tightly-spaced Thai fragments
    const merged: { word: string; startMs: number; endMs: number }[] = [];
    let cur = { ...rawWords[0], word: rawWords[0].word.trim() };
    for (let i = 1; i < rawWords.length; i++) {
      const w = { ...rawWords[i], word: rawWords[i].word.trim() };
      if (!w.word) continue;
      const gap = w.startMs - cur.endMs;
      // Merge เฉพาะ Whisper syllables: single-char Thai + tight gap
      const isSyllableFragment = cur.word.length <= 2 || w.word.length <= 2;
      if (gap <= syllableGapMs && isSyllableFragment && isThai(cur.word[cur.word.length - 1]) && isThai(w.word[0])) {
        cur = { word: cur.word + w.word, startMs: cur.startMs, endMs: w.endMs };
      } else {
        merged.push(cur);
        cur = w;
      }
    }
    merged.push(cur);
    return merged;
  }

  // แบ่งซับไตเติลตาม mode ที่เลือก
  function splitCaptionsByMode(mode?: typeof splitMode, customN?: number) {
    const m = mode ?? splitMode;
    const n = m === "sentence" ? 0 : m === "custom" ? (customN ?? splitCustomN) : parseInt(m);

    // sentence mode = reset กลับ captions ต้นฉบับจาก transcribe
    if (m === "sentence") {
      const orig = originalCaptionsRef.current;
      if (orig.length > 0) {
        setCaptions(orig.map(c => ({ ...c })));
        toast(`รีเซ็ตเป็นซับต้นฉบับ ${orig.length} ช่วง`);
      } else {
        toast("ยังไม่มีซับต้นฉบับ (ต้อง Transcribe ก่อน)");
      }
      return;
    }

    if (captions.length === 0) { toast.error("ยังไม่มีซับ"); return; }
    if (n < 1) return;

    const wordsData = pipe.current.words ?? [];
    const hasWords = wordsData.length > 0;
    const result: Caption[] = [];

    if (hasWords) {
      // Step 1: merge syllables ที่ Whisper แยกผิด (วง+การ → วงการ)
      const merged = mergeWhisperSyllables(wordsData);

      // Step 2: แบ่ง chunk ตาม N คำ แต่ตัดที่ silence ≥ 220ms ก่อนเสมอ (phrase boundary)
      const PHRASE_BREAK_MS = 220;
      const chunks: (typeof merged)[] = [];
      let current: typeof merged = [];
      for (let i = 0; i < merged.length; i++) {
        const w = merged[i];
        if (current.length > 0) {
          const gap = w.startMs - current[current.length - 1].endMs;
          const hitPhrase = gap >= PHRASE_BREAK_MS;
          const hitMax = current.length >= n;
          if (hitMax || hitPhrase) {
            chunks.push(current);
            current = [];
          }
        }
        current.push(w);
      }
      if (current.length > 0) chunks.push(current);

      // Step 3: ถ้า chunk ไหนยาวเกิน n*1.8 ให้แตกซ้ำที่ silence ที่ใหญ่ที่สุด
      const finalChunks: (typeof merged)[] = [];
      for (const chunk of chunks) {
        if (chunk.length <= Math.ceil(n * 1.8)) {
          finalChunks.push(chunk);
          continue;
        }
        // หา silence ที่ใหญ่สุดเพื่อแตก
        let bestIdx = -1, bestGap = -1;
        for (let i = 1; i < chunk.length; i++) {
          const g = chunk[i].startMs - chunk[i - 1].endMs;
          if (g > bestGap) { bestGap = g; bestIdx = i; }
        }
        if (bestIdx > 0) {
          finalChunks.push(chunk.slice(0, bestIdx));
          finalChunks.push(chunk.slice(bestIdx));
        } else {
          finalChunks.push(chunk);
        }
      }

      finalChunks.forEach((chunk, idx) => {
        const lastWord = chunk[chunk.length - 1];
        const endMs = lastWord.endMs > 0
          ? lastWord.endMs
          : (idx < finalChunks.length - 1 ? finalChunks[idx + 1][0].startMs : (pipe.current.audioDurationMs || lastWord.startMs + 500));
        result.push({
          text: joinWords(chunk.map(w => w.word)),
          startMs: chunk[0].startMs,
          endMs,
          tag: idx === 0 ? "hook" : idx === finalChunks.length - 1 ? "cta" : "body",
        });
      });
    } else {
      // Fallback: ไม่มี word timing — แบ่งตาม text แล้ว interpolate เวลา
      toast("⚠ ไม่มี word timing — ซับอาจไม่ตรงเสียง กด Transcribe ใหม่เพื่อให้แม่นขึ้น");
      const src = originalCaptionsRef.current.length > 0 ? originalCaptionsRef.current : captions;
      src.forEach(cap => {
        // ใช้ Intl.Segmenter แบ่งคำภาษาไทยได้ถูกต้อง
        const words = segmentWords(cap.text.trim());
        const dur = cap.endMs - cap.startMs;
        for (let i = 0; i < words.length; i += n) {
          const chunk = words.slice(i, i + n);
          const s = cap.startMs + (i / words.length) * dur;
          const e = cap.startMs + (Math.min(i + n, words.length) / words.length) * dur;
          result.push({ text: joinWords(chunk), startMs: Math.round(s), endMs: Math.round(e), tag: result.length === 0 ? "hook" : "body" });
        }
      });
      if (result.length > 0) result[result.length - 1].tag = "cta";
    }

    if (result.length > 0) {
      setCaptions(result);
      const label = m === "custom" ? `${n} คำ` : `${m} คำ`;
      toast.success(`แบ่งซับ ${label}/ช่วง → ${result.length} ช่วง`);
    }
  }

  function playToggle() {
    const v = videoRef.current;
    if (!v) return;
    playing ? v.pause() : v.play();
  }

  function tagColor(tag?: string) {
    if (tag === "hook") return "text-amber-400";
    if (tag === "cta")  return "text-emerald-400";
    return "text-violet-400";
  }
  function tagBg(tag?: string) {
    if (tag === "hook") return "bg-amber-500/10 border-amber-500/30";
    if (tag === "cta")  return "bg-emerald-500/10 border-emerald-500/30";
    return "bg-violet-500/10 border-violet-500/30";
  }
  function tagClipBg(tag?: string) {
    if (tag === "hook") return "bg-amber-500/15 border-amber-500/40 text-amber-300";
    if (tag === "cta")  return "bg-emerald-500/12 border-emerald-500/35 text-emerald-300";
    return "bg-violet-500/12 border-violet-500/30 text-violet-300";
  }

  const previewScale = 260 / 1080;

  // ── RENDER ────────────────────────────────────────────────────────────
  return (
    <div className={cn(
      "ve-no-padding flex flex-col bg-[#0c0c0f] text-slate-100 overflow-hidden text-[13px]",
      isEditorExpanded ? "fixed inset-0 z-[200]" : "h-full"
    )}>

      {/* ── TOPBAR ── */}
      <div className="h-12 bg-[#111115] border-b border-[#1e1e28] flex items-center gap-2 px-4 flex-shrink-0">
        <div className="w-px h-5 bg-[#2a2a36] mx-1" />

        {/* Project name (editable) + pencil hint */}
        <div className="flex items-center gap-1 group">
          <input
            value={projectName}
            onChange={e => setProjectName(e.target.value)}
            className="bg-transparent font-semibold text-sm outline-none border-b border-transparent hover:border-[#2a2a36] focus:border-violet-500 transition-colors px-1 max-w-[160px]"
          />
          <svg className="w-3 h-3 text-slate-600 group-hover:text-slate-400 transition-colors flex-shrink-0 pointer-events-none" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l-4 1 1-4L14.768 1.768a2 2 0 012.828 0l1.636 1.636a2 2 0 010 2.828L9 13z" />
          </svg>
        </div>

        {lastSaved && <span className="text-[10px] text-emerald-500/70 ml-1">● {lastSaved.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })}</span>}

        {/* Drafts toggle */}
        <button onClick={() => setShowDraftList(d => !d)}
          className={cn("flex items-center gap-1 px-2 py-1.5 rounded-md text-[11px] font-semibold transition-colors ml-1",
            showDraftList ? "bg-violet-500/15 text-violet-300 border border-violet-500/30" : "bg-[#1a1a22] border border-[#2a2a36] text-slate-500 hover:text-slate-300")}>
          <ChevronDown className={cn("w-3 h-3 transition-transform", showDraftList && "rotate-180")} />
          Draft ({drafts.length})
        </button>

        <div className="w-px h-5 bg-[#2a2a36] mx-2" />

        {/* Middle toolbar */}
        <div className="flex items-center gap-1 flex-1 justify-center">
          <button className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-[#1a1a22] border border-[#2a2a36] text-slate-400 hover:text-slate-200 hover:border-[#3a3a4a] text-[11px] font-semibold transition-colors" title="อัตราส่วนภาพ (9:16 เท่านั้น)">
            9:16 · เต็มจอ <ChevronDown className="w-3 h-3 ml-0.5 opacity-40" />
          </button>
          <div className="w-px h-4 bg-[#2a2a36] mx-1" />
          <button onClick={undo} title="ย้อนกลับ (Ctrl+Z)"
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-[#1a1a22] border border-[#2a2a36] text-slate-400 hover:text-slate-200 text-[11px] font-semibold transition-colors disabled:opacity-30"
            disabled={historyIdxRef.current <= 0}>↩</button>
          <button onClick={redo} title="ทำซ้ำ (Ctrl+Y)"
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-[#1a1a22] border border-[#2a2a36] text-slate-400 hover:text-slate-200 text-[11px] font-semibold transition-colors disabled:opacity-30"
            disabled={historyIdxRef.current >= historyRef.current.length - 1}>↪</button>
        </div>

        {/* Right actions */}
        <div className="flex items-center gap-2">
          {/* Reset to last-rendered style */}
          {lastRenderedStyleRef.current && styleIsDirty && !running && (
            <button
              onClick={() => {
                const snap = lastRenderedStyleRef.current;
                if (!snap) return;
                setSubFontFamily(snap.fontFamily);
                setSubFontSize(snap.fontSize);
                setSubFontWeight(snap.fontWeight);
                setSubColor(snap.color);
                setSubAccentColor(snap.accentColor);
                setSubPreset(snap.preset);
                setSubEffect(snap.effect);
                setSubPosition(snap.position);
                setCaptions(snap.captions.map(c => ({ ...c })));
                setStyleIsDirty(false);
                toast("รีเซ็ตกลับ style และซับที่ Render ล่าสุด");
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold bg-amber-600/20 border border-amber-500/40 text-amber-400 hover:bg-amber-600/30 transition-colors"
              title="รีเซ็ตกลับ style/ซับที่ Render ล่าสุด"
            >
              ↺ Reset to last render
            </button>
          )}
          {videoUrl && !running && (() => {
            const burnedClean = pipe.current.burnedVideoUrl && !styleIsDirty;
            const needsBurn = !burnedClean;
            const dlUrl = burnedClean ? pipe.current.burnedVideoUrl! : null;
            return (
              <button
                onClick={async () => {
                  if (dlUrl) {
                    const a = document.createElement("a");
                    a.href = dlUrl; a.download = ""; a.click();
                  } else {
                    if (!pipe.current.renderedVideoNoSubUrl) { toast.error("ต้อง Render วิดีโอก่อน"); return; }
                    toast("กำลัง Burn Subtitles...", { duration: 3000 });
                    await runBurnSubtitles();
                    const burned = pipe.current.burnedVideoUrl;
                    if (burned) {
                      const a = document.createElement("a"); a.href = burned; a.download = ""; a.click();
                    }
                  }
                }}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-colors text-white",
                  needsBurn
                    ? "bg-amber-600 hover:bg-amber-500"
                    : "bg-emerald-600 hover:bg-emerald-500"
                )}
                title={needsBurn ? "Burn ซับใหม่แล้ว Download" : "Download วิดีโอที่มีซับล่าสุด"}
              >
                <Download className="w-3 h-3" />
                {needsBurn ? "Burn & Download" : "Download"}
              </button>
            );
          })()}
          <button onClick={saveDraftNow}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold bg-[#1a1a22] border border-[#2a2a36] text-slate-400 hover:text-emerald-400 hover:border-emerald-500/40 transition-colors">
            <Save className="w-3 h-3" /> Save
          </button>
          <button
            onClick={() => setIsEditorExpanded(v => !v)}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:bg-[#1e1e28] hover:text-slate-200 transition-colors border border-[#2a2a36]"
            title={isEditorExpanded ? "Exit fullscreen" : "Expand editor (fullscreen)"}>
            {isEditorExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          <button onClick={() => running ? stopAll() : runAll()} disabled={!script.trim()}
            className={cn("flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[12px] font-bold transition-all",
              running
                ? "bg-red-600 hover:bg-red-700 text-white"
                : "bg-violet-600 hover:bg-violet-500 text-white shadow-[0_0_16px_rgba(124,58,237,0.4)] disabled:opacity-40 disabled:shadow-none")}>
            {running ? <><Loader2 className="w-3 h-3 animate-spin" /> Stop</> : <><Play className="w-3 h-3" /> Render</>}
          </button>
        </div>
      </div>

      {/* Draft dropdown */}
      {showDraftList && (
        <div className="absolute top-12 left-0 right-0 z-50 mx-auto pointer-events-none flex justify-start px-4">
          <div className="pointer-events-auto bg-[#18181f] border border-[#2a2a36] rounded-xl shadow-2xl w-72 p-2" style={{ marginLeft: 120 }}>
            <div className="flex items-center justify-between px-2 py-1.5 mb-1">
              <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Drafts</span>
              <button onClick={() => {
                  setDraftId(newDraftId());
                  setProjectName("New Project");
                  setScript("");
                  setScriptOverride("");
                  setVideoUrl(""); setPreRenderUrl("");
                  setCaptionsRaw([]); captionsRef.current = [];
                  setSteps({ ...DEFAULT_STEPS }); stepsRef.current = { ...DEFAULT_STEPS };
                  setLogs({});
                  setRenderProgress(0);
                  setLastSaved(null);
                  // Wipe pipeline cache so old data doesn't leak into the new project
                  pipe.current = {};
                  setShowDraftList(false);
                  toast.success("เริ่ม project ใหม่แล้ว");
                }}
                className="flex items-center gap-1 text-[10px] text-violet-400 hover:text-violet-300 transition-colors">
                <Plus className="w-3 h-3" /> New
              </button>
            </div>
            {drafts.length === 0 && <div className="text-[11px] text-slate-600 px-2 py-3 text-center">No drafts yet</div>}
            <div className="max-h-72 overflow-y-auto space-y-0.5">
              {drafts.map(d => (
                <div key={d.id} className="group relative flex items-center rounded-lg hover:bg-[#22222e] transition-colors">
                  <button onClick={() => { loadDraftInto(d); }}
                    className="flex-1 text-left px-3 py-2 pr-8 min-w-0">
                    <div className="text-[12px] font-semibold text-slate-200 truncate">{d.name}</div>
                    <div className="text-[10px] text-slate-600">{new Date(d.updatedAt).toLocaleString("th-TH", { day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" })}</div>
                  </button>
                  <button onClick={() => {
                      const next = drafts.filter(x => x.id !== d.id);
                      saveDrafts(next); setDrafts(next);
                      toast.success("ลบ draft แล้ว");
                    }}
                    className="absolute right-2 w-5 h-5 rounded flex items-center justify-center text-slate-700 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                    title="ลบ draft">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── MAIN BODY ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── LEFT: TRANSCRIPT ── */}
        <div className="relative flex-shrink-0 bg-[#111115] border-r border-[#1e1e28] flex flex-col" style={{ width: leftPanelWidth }}>
          {/* Left resize handle */}
          <div
            className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize z-10 group"
            onPointerDown={e => { e.preventDefault(); leftResizeRef.current = { startX: e.clientX, startW: leftPanelWidth }; }}
          >
            <div className="absolute right-0 top-0 bottom-0 w-px bg-[#1e1e28] group-hover:bg-violet-500/60 group-active:bg-violet-500 transition-colors" />
          </div>
          <div className="px-4 py-3 border-b border-[#1e1e28] flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-bold text-[13px] tracking-tight">Transcript</div>
              <div className="text-[10px] text-slate-600 mt-0.5">{displayCaptions.length} segments · {fmtMs(totalMs)}</div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button onClick={() => { setSearchOpen(v => !v); if (searchOpen) setSearchQuery(""); }}
                className={cn("w-7 h-7 rounded-lg flex items-center justify-center transition-colors", searchOpen ? "bg-violet-500/20 text-violet-300" : "text-slate-600 hover:bg-[#1e1e28] hover:text-slate-300")}>
                <Search className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Search bar */}
          {searchOpen && (
            <div className="px-3 py-2 border-b border-[#1e1e28] flex items-center gap-2">
              <Search className="w-3 h-3 text-slate-600 flex-shrink-0" />
              <input autoFocus value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                placeholder="ค้นหาซับ..."
                className="flex-1 bg-transparent text-[12px] text-slate-300 placeholder-slate-600 outline-none" />
              {searchQuery && (
                <button onClick={() => setSearchQuery("")} className="text-slate-600 hover:text-slate-400 text-[11px]">✕</button>
              )}
            </div>
          )}

          <div className="flex-1 overflow-y-auto py-2 px-2 flex flex-col gap-1 scrollbar-thin scrollbar-thumb-[#2a2a36]">

            {/* ── SCRIPT + PRE-LLM SETTINGS ── */}
            <div className="px-2 mb-1 space-y-2">

              {/* Script textarea (ซ่อนเมื่อมี captions) */}
              {captions.length === 0 && (
                <div>
                  <div className="text-[10px] text-slate-600 mb-1.5 font-semibold uppercase tracking-wider">Script</div>
                  <textarea
                    value={script}
                    onChange={e => { setScript(e.target.value); setScriptOverride(""); }}
                    placeholder={"พิมพ์ script ที่นี่...\n\n(แต่ละบรรทัด = 1 เซ็กเมนต์)\n\nเริ่มด้วย hook ที่ดึงดูด"}
                    className="w-full bg-[#1a1a22] border border-[#2a2a36] rounded-lg p-3 text-[12px] text-slate-300 placeholder-slate-600 resize-none outline-none focus:border-violet-500/50 transition-colors h-40 leading-relaxed"
                  />
                  <div className="mt-1 text-[10px] text-slate-600">{script.length} ตัวอักษร · {segments.length} บรรทัด</div>
                </div>
              )}

              {/* ── Script ที่จะส่ง TTS (แก้ได้) ── */}
              {script.trim().length > 0 && (
                <div className="rounded-xl border border-[#2a2a36] bg-[#111118] overflow-hidden">
                  <button
                    onClick={() => {
                      if (!showScriptOverride && !scriptOverride.trim()) {
                        setScriptOverride(preprocessScript(script));
                      }
                      setShowScriptOverride(v => !v);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-[#1a1a22] transition-colors"
                  >
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider flex-1">✏️ TTS Script</span>
                    {scriptOverride.trim() && (
                      <span className="text-[9px] bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded px-1.5 py-0.5 font-bold">แก้แล้ว</span>
                    )}
                    <span className={cn("text-slate-600 text-[10px] transition-transform", showScriptOverride ? "rotate-180" : "")}>▼</span>
                  </button>
                  {showScriptOverride && (
                    <div className="px-3 pb-3 space-y-2 border-t border-[#2a2a36]">
                      <div className="text-[9px] text-slate-600 pt-2 leading-snug">
                        แก้ข้อความก่อนส่งให้ TTS และ Transcribe — ลบ emoji, คำเสริม, จัดประโยค
                      </div>
                      <textarea
                        value={scriptOverride}
                        onChange={e => setScriptOverride(e.target.value)}
                        rows={5}
                        className="w-full bg-[#0e0e13] border border-amber-500/25 rounded-lg p-2.5 text-[11px] text-slate-200 resize-none outline-none focus:border-amber-500/50 transition-colors leading-relaxed placeholder-slate-700"
                        placeholder="Script ที่จะส่งให้ TTS..."
                      />
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setScriptOverride(preprocessScript(script))}
                          className="text-[9px] px-2 py-1 rounded-md bg-[#1a1a22] border border-[#2a2a36] text-slate-500 hover:text-slate-300 transition-colors"
                        >↺ รีเซ็ต</button>
                        <button
                          onClick={() => { setScriptOverride(""); }}
                          className="text-[9px] px-2 py-1 rounded-md bg-[#1a1a22] border border-[#2a2a36] text-slate-500 hover:text-red-400 transition-colors"
                        >✕ ล้าง</button>
                        <span className="ml-auto text-[9px] text-slate-700">{(scriptOverride || preprocessScript(script)).length} ตัว</span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── แบ่งซับ ── */}
              {(captions.length > 0 || originalCaptionsRef.current.length > 0) && (
                <div className="rounded-xl border border-[#2a2a36] bg-[#111118] overflow-hidden">
                  <div className="px-3 py-2.5 flex items-center gap-2">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider flex-1">✂️ Split Subtitles</span>
                    <span className="text-[9px] text-slate-600">{captions.length} ช่วง</span>
                  </div>
                  <div className="border-t border-[#2a2a36] px-3 py-2.5 space-y-2">
                    {/* Mode buttons */}
                    <div className="grid grid-cols-3 gap-1">
                      {([
                        { mode: "sentence", label: "ประโยค" },
                        { mode: "1",        label: "1 คำ" },
                        { mode: "2",        label: "2 คำ" },
                        { mode: "3",        label: "3 คำ" },
                        { mode: "4",        label: "4 คำ" },
                        { mode: "custom",   label: "กำหนด" },
                      ] as const).map(({ mode, label }) => (
                        <button
                          key={mode}
                          onClick={() => {
                            setSplitMode(mode);
                            if (mode !== "custom") splitCaptionsByMode(mode);
                          }}
                          className={cn(
                            "py-1.5 rounded-lg text-[10px] font-bold transition-colors border",
                            splitMode === mode
                              ? "bg-violet-600 border-violet-500 text-white"
                              : "bg-[#1a1a22] border-[#2a2a36] text-slate-500 hover:text-slate-300 hover:border-[#3a3a4a]"
                          )}
                        >{label}</button>
                      ))}
                    </div>
                    {/* Custom input */}
                    {splitMode === "custom" && (
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-slate-500 flex-shrink-0">จำนวนคำ/ช่วง:</span>
                        <input
                          type="number" min={1} max={20} value={splitCustomN}
                          onChange={e => setSplitCustomN(Math.max(1, parseInt(e.target.value) || 1))}
                          className="w-14 bg-[#0e0e13] border border-[#2a2a36] rounded-lg px-2 py-1 text-[11px] text-slate-300 outline-none text-center focus:border-violet-500/50"
                        />
                        <button
                          onClick={() => splitCaptionsByMode("custom", splitCustomN)}
                          className="flex-1 py-1 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-[10px] font-bold transition-colors"
                        >แบ่งเลย</button>
                      </div>
                    )}
                    {splitMode !== "custom" && splitMode !== "sentence" && (
                      <div className="text-[9px] text-slate-700 text-center">
                        {splitMode === "1" && "เน้นทีละคำ — แรงมาก"}
                        {splitMode === "2" && "เร็ว พลิ้ว — นิยมใน TikTok"}
                        {splitMode === "3" && "แนะนำ — อ่านง่าย"}
                        {splitMode === "4" && "ประโยคสั้น — ไหลลื่น"}
                      </div>
                    )}
                    {splitMode === "sentence" && (
                      <div className="text-[9px] text-slate-700 text-center">คืนค่าซับต้นฉบับจาก Transcribe</div>
                    )}
                  </div>
                </div>
              )}

            </div>

            {captions.length > 0 && scriptSegments
              .map((cap, i) => ({ cap, i }))
              .filter(({ cap }) => !searchQuery || cap.text.toLowerCase().includes(searchQuery.toLowerCase()))
              .map(({ cap, i }) => {
              const isActive = i === activeSegIdx || i === activeCaptionIdx;
              const isEditing = editingCapIdx === i;
              return (
                <div key={i}
                  className={cn("rounded-xl border transition-all group",
                    isActive ? "bg-violet-500/10 border-violet-500/40" : "bg-transparent border-transparent hover:bg-[#1a1a22] hover:border-[#2a2a36]")}>

                  {/* Header row */}
                  <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1 cursor-pointer"
                    onClick={() => {
                      setActiveSegIdx(i);
                      setActiveCaptionIdx(i);
                      if (videoRef.current && cap.startMs) videoRef.current.currentTime = cap.startMs / 1000;
                    }}>
                    <div className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", tagColor(cap.tag).replace("text-", "bg-"))} />
                    <span className={cn("text-[9px] font-black uppercase tracking-wider", tagColor(cap.tag))}>
                      #{i + 1} · {cap.tag ?? "body"}
                    </span>
                    <span className="ml-auto text-[9px] text-slate-700 tabular-nums">{fmtMs(cap.startMs)}–{fmtMs(cap.endMs)}</span>
                  </div>

                  {/* Text — click to edit inline */}
                  <div className="px-3 pb-1">
                    {isEditing ? (
                      <textarea
                        autoFocus
                        defaultValue={cap.text}
                        onBlur={e => {
                          const newText = e.target.value.trim();
                          if (newText && newText !== cap.text) {
                            const updated = captions.map((c, j) => j === i ? { ...c, text: newText } : c);
                            setCaptions(updated);
                          }
                          setEditingCapIdx(null);
                        }}
                        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } if (e.key === "Escape") setEditingCapIdx(null); }}
                        className="w-full bg-[#111115] border border-violet-500/50 rounded px-2 py-1 text-[12px] text-slate-100 resize-none outline-none leading-relaxed"
                        rows={2}
                        onClick={e => e.stopPropagation()}
                      />
                    ) : (
                      <div
                        className={cn("text-[12px] leading-relaxed cursor-text rounded px-1 -mx-1 py-0.5 hover:bg-white/5 transition-colors", isActive ? "text-slate-100 font-semibold" : "text-slate-400")}
                        onDoubleClick={e => { e.stopPropagation(); setEditingCapIdx(i); }}
                        title="ดับเบิ้ลคลิกเพื่อแก้ข้อความ"
                      >
                        {cap.text}
                      </div>
                    )}
                  </div>

                  {/* Actions row */}
                  <div className="flex items-center gap-1 px-3 pb-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="text-[9px] text-slate-600 tabular-nums mr-auto">{((cap.endMs - cap.startMs) / 1000).toFixed(1)}s</span>
                    {/* Tag cycle */}
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        const tags: Caption["tag"][] = ["hook", "body", "cta"];
                        const next = tags[(tags.indexOf(cap.tag ?? "body") + 1) % 3];
                        setCaptions(captions.map((c, j) => j === i ? { ...c, tag: next } : c));
                      }}
                      className={cn("px-1.5 py-0.5 rounded text-[9px] font-bold border transition-colors", tagBg(cap.tag))}
                    >{cap.tag ?? "body"}</button>
                    {/* Edit */}
                    <button onClick={e => { e.stopPropagation(); setEditingCapIdx(i); }} className="w-5 h-5 rounded flex items-center justify-center text-slate-600 hover:text-slate-300 hover:bg-white/10">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    {/* Delete */}
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        const updated = captions.filter((_, j) => j !== i);
                        setCaptions(updated);
                        if (activeSegIdx >= updated.length) setActiveSegIdx(Math.max(0, updated.length - 1));
                      }}
                      className="w-5 h-5 rounded flex items-center justify-center text-slate-600 hover:text-red-400 hover:bg-red-500/10"
                    ><Trash2 className="w-3 h-3" /></button>
                  </div>
                </div>
              );
            })}

            {/* Add segment button */}
            <button
              onClick={() => {
                const last = captions[captions.length - 1];
                const newCap: Caption = { text: "ข้อความใหม่", startMs: last ? last.endMs : 0, endMs: last ? last.endMs + 3000 : 3000, tag: "body" };
                setCaptions([...captions, newCap]);
                setTimeout(() => setEditingCapIdx(captions.length), 50);
              }}
              className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-slate-600 hover:bg-[#1a1a22] hover:text-slate-400 text-[12px] transition-colors mt-1"
            >
              <Plus className="w-3.5 h-3.5" /> Add Segment
            </button>
          </div>

          {/* Pipeline status */}
          <div className="border-t border-[#1e1e28] p-3 overflow-y-auto flex-shrink-0 max-h-[55%]">
            <div className="text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-2">Process</div>
            <div className="flex flex-col gap-0.5">
              {([ ["keywords","Keywords"], ["fetchStock","B-roll"], ["tts","TTS Voice"], ["transcribe","Transcribe"], ["config","Config"], ["render","Render"], ["avatar","Avatar"], ["avatarTail","Avatar Tail"], ["composite","Composite"], ["burnSubtitles","Burn Subtitles"] ] as [keyof StepState, string][]).filter(([k]) => {
                if (!useAvatar && (k === "avatar" || k === "avatarTail" || k === "composite")) return false;
                if (k === "avatarTail" && avatarTiming !== "bookend-both") return false;
                if (k === "burnSubtitles" && steps.burnSubtitles === "idle" && steps.render === "idle") return false;
                return true;
              }).map(([k, label]) => {
                const isDone = steps[k] === "done";
                const isError = steps[k] === "error";
                const isIdle = steps[k] === "idle";
                const isRunning = steps[k] === "running";
                const log = logs[k] ?? "";
                const burnedUrl = k === "burnSubtitles" ? (pipe.current.burnedVideoUrl ?? "") : "";
                const isVideoUrl = isDone && (k === "render" || k === "tts" || k === "avatar" || k === "avatarTail" || k === "composite") && log.startsWith("/");
                const isBurnDone = isDone && k === "burnSubtitles" && !!burnedUrl;
                const isClickable = isDone || isError;

                // Determine the run action for this step
                const stepRunAction: (() => void) | null = !running ? (() => {
                  if (k === "burnSubtitles") return () => runBurnSubtitles();
                  if (k === "avatar" || k === "avatarTail" || k === "composite") return useAvatar ? () => runAvatarPipeline() : null;
                  if (k === "render") return pipe.current.config ? () => runRenderOnly() : () => runFrom("render");
                  return () => runFrom(k as keyof StepState);
                })() : null;

                // "▶ Run" shown always when idle (and runnable), "↺" shown on hover when done/error
                const showRunBtn = !running && isIdle && stepRunAction !== null && (
                  k !== "burnSubtitles" || (!!pipe.current.renderedVideoNoSubUrl && captions.length > 0 && !running)
                ) && (
                  k !== "avatar" && k !== "avatarTail" && k !== "composite" || useAvatar
                );
                const showRerunBtn = !running && (isDone || isError) && stepRunAction !== null;

                const labelColor = isRunning ? "text-violet-300"
                  : isDone ? "text-emerald-400 group-hover:text-emerald-300"
                  : isError ? "text-red-400"
                  : showRunBtn ? "text-slate-400"
                  : "text-slate-600";

                return (
                  <div key={k}
                    className={cn("flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors group",
                      isClickable ? "cursor-pointer hover:bg-[#1a1a22]" : "")}
                    onClick={() => {
                      if (!isClickable) return;
                      if (isBurnDone) { setVideoUrl(burnedUrl); }
                      else if (isVideoUrl) { setVideoUrl(log); }
                      else if (k === "tts" && log.startsWith("/")) { setTtsUrl(log); }
                      else if (isDone && log) { toast(log.length > 120 ? log.slice(0, 120) + "…" : log); }
                    }}
                    title={isClickable ? (isBurnDone || isVideoUrl ? "คลิกเพื่อโหลดวิดีโอ" : log || undefined) : undefined}
                  >
                    <StepIcon status={steps[k]} />
                    <span className={cn("text-[11px] flex-1 min-w-0", labelColor)}>
                      {label}
                    </span>
                    {isDone && (
                      <span className="text-[9px] text-slate-700 truncate max-w-[60px] group-hover:text-slate-500 transition-colors">
                        {isBurnDone ? "▶ with sub" :
                         isVideoUrl ? "▶" :
                         k === "keywords" ? `${pipe.current.keywords?.length ?? 0} kw` :
                         k === "fetchStock" ? `${pipe.current.stockVideos?.length ?? 0} clips` :
                         k === "transcribe" ? `${captions.length} subs` :
                         log.slice(0, 12)}
                      </span>
                    )}
                    {isError && log && (
                      <span className="text-[9px] text-red-600 truncate max-w-[60px]">{log.slice(0, 12)}</span>
                    )}
                    {isRunning && (
                      <span className="text-[9px] text-slate-700 truncate max-w-[60px]">{log.slice(0, 12)}</span>
                    )}
                    {showRunBtn && (
                      <button
                        onClick={e => { e.stopPropagation(); stepRunAction?.(); }}
                        className={cn("px-2 py-0.5 rounded text-[9px] font-bold text-white transition-colors",
                          k === "burnSubtitles" ? "bg-emerald-600/80 hover:bg-emerald-500" : "bg-violet-700/70 hover:bg-violet-600"
                        )}
                      >▶ Run</button>
                    )}
                    {showRerunBtn && (
                      <button
                        onClick={e => { e.stopPropagation(); stepRunAction?.(); }}
                        className="opacity-0 group-hover:opacity-100 transition-opacity px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-600/80 hover:bg-violet-500 text-white"
                        title="รันซ้ำ"
                      >↺</button>
                    )}
                  </div>
                );
              })}
            </div>
            {renderProgressError && <div className="mt-2 text-[11px] text-red-400 bg-red-500/10 rounded-lg px-2 py-1.5 leading-snug">{renderProgressError}</div>}
            {steps.render === "running" && renderProgress > 0 && (
              <div className="mt-2">
                <div className="flex justify-between text-[10px] text-slate-600 mb-1"><span>Rendering</span><span>{renderProgress}%</span></div>
                <div className="h-1 bg-[#2a2a36] rounded-full overflow-hidden">
                  <div className="h-full bg-violet-500 rounded-full transition-all" style={{ width: `${renderProgress}%` }} />
                </div>
              </div>
            )}

            {/* Step result popup for non-video steps */}
            {(() => {
              // Keywords result
              if (steps.keywords === "done" && pipe.current.keywords?.length) {
                return (
                  <div className="mt-2 bg-[#1a1a22] border border-[#2a2a36] rounded-lg p-2">
                    <div className="text-[9px] font-bold text-slate-600 uppercase tracking-wider mb-1">Keywords ({pipe.current.keywords.length})</div>
                    <div className="flex flex-wrap gap-1">
                      {pipe.current.keywords.slice(0, 12).map((kw, i) => (
                        <span key={i} className="text-[9px] bg-violet-500/10 border border-violet-500/20 text-violet-400 rounded px-1.5 py-0.5">{kw}</span>
                      ))}
                      {(pipe.current.keywords.length > 12) && <span className="text-[9px] text-slate-700">+{pipe.current.keywords.length - 12}</span>}
                    </div>
                  </div>
                );
              }
              return null;
            })()}
          </div>
        </div>

        {/* ── CENTER: PREVIEW ── */}
        <div ref={centerPanelRef} className="flex-1 flex flex-col bg-[#0c0c0f] min-w-0">
          {/* Preview area with dot grid */}
          <div className="flex-1 flex items-center justify-center relative overflow-hidden"
            style={{ backgroundImage: "radial-gradient(circle,#1e1e2a 1px,transparent 1px)", backgroundSize: "24px 24px" }}>

            {/* Phone frame */}
            <div ref={phoneFrameRef} className="relative select-none" style={{ width: 260, height: 462 }}>

              {/* Video layer */}
              <div className="absolute inset-0 rounded-2xl overflow-hidden shadow-[0_0_0_1px_#2a2a36,0_24px_64px_rgba(0,0,0,0.8)]"
                style={{ background: "linear-gradient(160deg,#0f0f1a 0%,#1a0f2e 40%,#0f1a2e 100%)" }}>
                {(videoUrl || preRenderUrl) ? (
                  <video
                    ref={videoRef}
                    src={videoUrl || preRenderUrl}
                    className="w-full h-full object-cover"
                    loop playsInline
                    onClick={playToggle}
                    style={{ cursor: "pointer" }}
                    onLoadedMetadata={e => setDurationMs((e.target as HTMLVideoElement).duration * 1000)}
                    onTimeUpdate={e => {
                      const ms = (e.target as HTMLVideoElement).currentTime * 1000;
                      setCurrentMs(ms);
                    }}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onEnded={() => setPlaying(false)}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center flex-col gap-3">
                    <div className="text-4xl opacity-10">🎬</div>
                    <div className="text-[11px] text-slate-700 text-center px-6 leading-relaxed">
                      พิมพ์ script แล้วกด <span className="text-violet-500 font-bold">Render</span>
                    </div>
                  </div>
                )}
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-black/40">
                  <div className="h-full bg-violet-500 transition-none" style={{ width: totalMs > 0 ? `${(currentMs / totalMs) * 100}%` : "0%" }} />
                </div>
              </div>

              {/* Subtitle overlay — draggable, clickable */}
              {(() => {
                // Show active caption when playing, or first caption when paused/before play
                const cap = activeSub ?? (!playing && displayCaptions.length > 0 ? displayCaptions[0] : null);
                if (!cap) return null;
                const isDragging = !!subDragRef.current;
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
                      <button onClick={e => { e.stopPropagation(); setActiveRightTab("style"); }}
                        className="px-1.5 py-0.5 bg-violet-600 rounded text-[9px] text-white font-bold hover:bg-violet-500">Style</button>
                      <button onClick={e => { e.stopPropagation(); setActiveRightTab("font"); }}
                        className="px-1.5 py-0.5 bg-[#1e1e28] border border-[#3a3a4a] rounded text-[9px] text-slate-300 hover:bg-[#2a2a36]">Font</button>
                      <button onClick={e => { e.stopPropagation(); setSubPosition(82); }}
                        className="px-1.5 py-0.5 bg-[#1e1e28] border border-[#3a3a4a] rounded text-[9px] text-slate-400 hover:bg-[#2a2a36]">↺</button>
                    </div>

                    {/* Subtitle text — matches Remotion render exactly */}
                    <div style={{ width: "100%", textAlign: "center" }} onClick={e => { e.stopPropagation(); setActiveRightTab("font"); }}>
                      {renderSubEl(cap.text, subColor, subAccentColor, cap.tag === "hook", subPreset, subFontFamily, subFontSize, subFontWeight, previewScale)}
                    </div>
                  </div>
                );
              })()}

              {/* Border overlay */}
              <div className="absolute inset-0 rounded-2xl pointer-events-none" style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.07)" }} />
            </div>

            {/* TTS audio preview (bottom-left, small) */}
            {ttsUrl && (
              <div className="absolute bottom-3 left-3 right-3">
                <audio src={ttsUrl} controls muted={avatarInputMode === "direct"} className="w-full h-7 opacity-60 hover:opacity-100 transition-opacity" />
                {avatarInputMode === "direct" && (
                  <div className="text-center text-[9px] text-slate-600 mt-0.5">🔇 Direct URL — เสียงอยู่ในวิดีโอ</div>
                )}
              </div>
            )}
          </div>

          {/* ── Playback controls ── */}
          <div className="h-12 bg-[#111115] border-t border-[#1e1e28] flex items-center gap-2 px-4 flex-shrink-0">
            {/* Skip back */}
            <button onClick={() => { if (videoRef.current) videoRef.current.currentTime = 0; }}
              className="w-7 h-7 rounded flex items-center justify-center text-slate-500 hover:bg-[#1e1e28] hover:text-slate-200 transition-colors flex-shrink-0">
              <SkipBack className="w-3.5 h-3.5" />
            </button>

            {/* Play / Pause */}
            <button onClick={playToggle}
              className="w-8 h-8 rounded-lg bg-violet-600 flex items-center justify-center text-white hover:bg-violet-500 transition-colors flex-shrink-0">
              {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            </button>

            {/* Skip forward 5s */}
            <button onClick={() => { if (videoRef.current) videoRef.current.currentTime = Math.min((videoRef.current.duration || 0), videoRef.current.currentTime + 5); }}
              className="w-7 h-7 rounded flex items-center justify-center text-slate-500 hover:bg-[#1e1e28] hover:text-slate-200 transition-colors flex-shrink-0">
              <SkipForward className="w-3.5 h-3.5" />
            </button>

            <div className="w-px h-4 bg-[#2a2a36] mx-1 flex-shrink-0" />

            {/* Time */}
            <span className="text-[11px] text-slate-500 tabular-nums flex-shrink-0">{fmtMs(currentMs)}</span>

            {/* Scrubber — always show thumb, bigger during scrub */}
            <div className="flex-1 relative py-3 cursor-pointer group"
              onPointerDown={e => {
                e.currentTarget.setPointerCapture(e.pointerId);
                setIsScrubbing(true);
                if (!videoRef.current) return;
                const r = e.currentTarget.getBoundingClientRect();
                const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
                const dur = videoRef.current.duration || (durationMs / 1000);
                videoRef.current.currentTime = pct * dur;
                setCurrentMs(pct * dur * 1000);
              }}
              onPointerMove={e => {
                if (e.buttons !== 1 || !videoRef.current) return;
                const r = e.currentTarget.getBoundingClientRect();
                const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
                const dur = videoRef.current.duration || (durationMs / 1000);
                videoRef.current.currentTime = pct * dur;
                setCurrentMs(pct * dur * 1000);
              }}
              onPointerUp={() => setIsScrubbing(false)}
              onPointerCancel={() => setIsScrubbing(false)}
            >
              <div className={cn("absolute top-1/2 left-0 right-0 -translate-y-1/2 rounded overflow-hidden transition-all", isScrubbing ? "h-2" : "h-1 group-hover:h-1.5")} style={{ background: "#2a2a36" }}>
                <div className="h-full bg-violet-500 rounded" style={{ width: totalMs > 0 ? `${(currentMs / totalMs) * 100}%` : "0%" }} />
              </div>
              {/* Thumb — always visible when scrubbing, hover otherwise */}
              <div className={cn("absolute top-1/2 -translate-y-1/2 -translate-x-1/2 rounded-full bg-white border-2 border-violet-500 shadow-[0_0_6px_rgba(124,58,237,0.6)] transition-all",
                isScrubbing ? "w-4 h-4 opacity-100" : "w-3 h-3 opacity-0 group-hover:opacity-100")}
                style={{ left: totalMs > 0 ? `${(currentMs / totalMs) * 100}%` : "0%" }} />
            </div>

            <span className="text-[11px] text-slate-600 tabular-nums flex-shrink-0">/ {fmtMs(totalMs)}</span>

            <div className="w-px h-4 bg-[#2a2a36] mx-1 flex-shrink-0" />

            {/* Volume — click icon to mute, hover to show slider */}
            <div className="relative flex items-center flex-shrink-0" onMouseEnter={() => setShowVolumeSlider(true)} onMouseLeave={() => setShowVolumeSlider(false)}>
              <button onClick={() => setMuted(m => !m)}
                className="w-7 h-7 rounded flex items-center justify-center text-slate-500 hover:text-slate-200 transition-colors">
                {muted || volume === 0 ? <VolumeX className="w-3.5 h-3.5" /> : volume < 0.5 ? <Volume1 className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
              </button>
              {/* Volume slider popup */}
              {showVolumeSlider && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-[#1a1a22] border border-[#2a2a36] rounded-xl p-3 shadow-2xl flex flex-col items-center gap-2 z-50" style={{ width: 36 }}>
                  {/* Vertical slider */}
                  <div className="relative h-20 w-1.5 bg-[#2a2a36] rounded cursor-pointer flex-shrink-0"
                    onClick={e => {
                      const r = e.currentTarget.getBoundingClientRect();
                      const pct = 1 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
                      const v = Math.round(pct * 100) / 100;
                      setVolume(v);
                      if (videoRef.current) videoRef.current.volume = v;
                      setMuted(v === 0);
                    }}
                    onPointerDown={e => {
                      e.currentTarget.setPointerCapture(e.pointerId);
                    }}
                    onPointerMove={e => {
                      if (e.buttons !== 1) return;
                      const r = e.currentTarget.getBoundingClientRect();
                      const pct = 1 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
                      const v = Math.round(pct * 100) / 100;
                      setVolume(v);
                      if (videoRef.current) videoRef.current.volume = v;
                      setMuted(v === 0);
                    }}
                  >
                    <div className="absolute bottom-0 left-0 right-0 bg-violet-500 rounded" style={{ height: `${(muted ? 0 : volume) * 100}%` }} />
                    <div className="absolute left-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-white border-2 border-violet-500 shadow" style={{ bottom: `calc(${(muted ? 0 : volume) * 100}% - 6px)` }} />
                  </div>
                  <span className="text-[9px] text-slate-500 tabular-nums">{muted ? 0 : Math.round(volume * 100)}</span>
                </div>
              )}
            </div>

            {/* Fullscreen — toggles panel fullscreen (not native video) */}
            <button onClick={() => {
                if (!document.fullscreenElement) {
                  centerPanelRef.current?.requestFullscreen?.();
                } else {
                  document.exitFullscreen?.();
                }
              }}
              className="w-7 h-7 rounded flex items-center justify-center text-slate-500 hover:text-slate-200 transition-colors flex-shrink-0">
              {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* ── RIGHT: SUBTITLE SETTINGS ── */}
        {!rightPanelOpen && !panelDetached && (
          <button onClick={() => setRightPanelOpen(true)}
            className="flex-shrink-0 w-8 bg-[#111115] border-l border-[#1e1e28] flex items-center justify-center text-slate-600 hover:text-slate-300 hover:bg-[#1a1a22] transition-colors"
            title="Open settings panel">
            <span className="text-[11px] rotate-90 whitespace-nowrap font-bold tracking-wider">Settings ▶</span>
          </button>
        )}

        {/* Order panel — ลำดับการทำงาน (ซ้ายของตั้งค่า) */}
        {rightPanelOpen && !panelDetached && (
          <OrderPanel
            open={orderPanelOpen} onToggle={() => setOrderPanelOpen(v => !v)}
            ttsProvider={ttsProvider} geminiVoiceName={geminiVoiceName} voiceId={voiceId}
            setTtsProvider={setTtsProvider} setGeminiVoiceName={setGeminiVoiceName} setVoiceId={setVoiceId}
            bgmEnabled={bgmEnabled} bgmFile={bgmFile} bgmVolume={bgmVolume}
            setBgmEnabled={setBgmEnabled} setBgmFile={setBgmFile} setBgmVolume={setBgmVolume}
            bgmUploading={bgmUploading} setBgmUploading={setBgmUploading} systemTracks={systemTracks}
            useAvatar={useAvatar} avatarId={avatarId} avatarTiming={avatarTiming}
            avatarBookendSecs={avatarBookendSecs} avatarTailSecs={avatarTailSecs}
            avatarScale={avatarScale} avatarOffsetX={avatarOffsetX} avatarOffsetY={avatarOffsetY}
            avatarPreviewUrl={avatarPreviewUrl} avatarName={avatarName}
            avatarGreenUrl={avatarGreenUrl} running={running} steps={steps}
            avatarInputMode={avatarInputMode} avatarDirectUrl={avatarDirectUrl}
            setAvatarInputMode={setAvatarInputMode} setAvatarDirectUrl={setAvatarDirectUrl}
            chromaSimilarity={chromaSimilarity} setChromaSimilarity={setChromaSimilarity}
            chromaBlend={chromaBlend} setChromaBlend={setChromaBlend}
            setUseAvatar={setUseAvatar} setAvatarId={setAvatarId} setAvatarTiming={setAvatarTiming}
            setAvatarBookendSecs={setAvatarBookendSecs} setAvatarTailSecs={setAvatarTailSecs}
            setAvatarScale={setAvatarScale} setAvatarOffsetX={setAvatarOffsetX} setAvatarOffsetY={setAvatarOffsetY}
            runAvatarPipeline={runAvatarPipeline} pipeRenderedVideoUrl={videoUrl || preRenderUrl || pipe.current.renderedVideoUrl}
            onPlanError={(msg) => setUpgradeModal({ open: true, message: msg })}
            stockSource={stockSource} setStockSource={setStockSource}
          />
        )}

        {/* Inline docked panel — ตั้งค่าซับ */}
        {rightPanelOpen && !panelDetached && (
          <div className="relative flex-shrink-0 border-l border-[#1e1e28] flex flex-col h-full" style={{ width: rightPanelWidth }}>
            {/* Right resize handle */}
            <div
              className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10 group"
              onPointerDown={e => { e.preventDefault(); rightResizeRef.current = { startX: e.clientX, startW: rightPanelWidth }; }}
            >
              <div className="absolute left-0 top-0 bottom-0 w-px bg-[#1e1e28] group-hover:bg-violet-500/60 group-active:bg-violet-500 transition-colors" />
            </div>
          <RightSettingsPanel
            wide={rightPanelWide} detached={false} dragging={false}
            panelPos={panelPos} panelWidth={rightPanelWidth}
            onDetach={() => { const pw = rightPanelWide ? 520 : 268; setPanelPos({ x: Math.max(40, window.innerWidth - pw - 60), y: 60 }); setPanelDetached(true); }}
            onDock={() => { setPanelDetached(false); setRightPanelOpen(true); }}
            onToggleWide={() => { setRightPanelWide(v => { const next = !v; setRightPanelWidth(next ? 520 : 268); return next; }); }}
            onClose={() => { setRightPanelOpen(false); setRightPanelWide(false); setRightPanelWidth(268); }}
            onDragStart={() => {}} onDragMove={() => {}} onDragEnd={() => {}}
            activeTab={activeRightTab} onTab={setActiveRightTab}
            subColor={subColor} subAccentColor={subAccentColor} subPreset={subPreset}
            subFontFamily={subFontFamily} subFontSize={subFontSize} subFontWeight={subFontWeight}
            subEffect={subEffect} subPosition={subPosition} subShadow={subShadow}
            subOutline={subOutline} subOutlineSize={subOutlineSize}
            setSubPreset={setSubPreset} setSubEffect={setSubEffect} setSubFontFamily={setSubFontFamily}
            setSubFontSize={setSubFontSize} setSubFontWeight={setSubFontWeight} setSubColor={setSubColor}
            setSubAccentColor={setSubAccentColor} setSubPosition={setSubPosition}
            setSubShadow={setSubShadow} setSubOutline={setSubOutline} setSubOutlineSize={setSubOutlineSize}
            displayCaptions={displayCaptions} activeSegIdx={activeSegIdx}
            ttsProvider={ttsProvider} geminiVoiceName={geminiVoiceName} voiceId={voiceId}
            setTtsProvider={setTtsProvider} setGeminiVoiceName={setGeminiVoiceName} setVoiceId={setVoiceId}
            bgmEnabled={bgmEnabled} bgmFile={bgmFile} bgmVolume={bgmVolume}
            setBgmEnabled={setBgmEnabled} setBgmFile={setBgmFile} setBgmVolume={setBgmVolume}
            bgmUploading={bgmUploading} setBgmUploading={setBgmUploading} systemTracks={systemTracks}
            useAvatar={useAvatar} avatarId={avatarId} avatarTiming={avatarTiming}
            avatarBookendSecs={avatarBookendSecs} avatarTailSecs={avatarTailSecs}
            avatarScale={avatarScale} avatarOffsetX={avatarOffsetX} avatarOffsetY={avatarOffsetY}
            avatarPreviewUrl={avatarPreviewUrl} avatarName={avatarName}
            avatarGreenUrl={avatarGreenUrl} running={running} steps={steps}
            avatarInputMode={avatarInputMode} avatarDirectUrl={avatarDirectUrl}
            setAvatarInputMode={setAvatarInputMode} setAvatarDirectUrl={setAvatarDirectUrl}
            chromaSimilarity={chromaSimilarity} setChromaSimilarity={setChromaSimilarity}
            chromaBlend={chromaBlend} setChromaBlend={setChromaBlend}
            setUseAvatar={setUseAvatar} setAvatarId={setAvatarId} setAvatarTiming={setAvatarTiming}
            setAvatarBookendSecs={setAvatarBookendSecs} setAvatarTailSecs={setAvatarTailSecs}
            setAvatarScale={setAvatarScale} setAvatarOffsetX={setAvatarOffsetX} setAvatarOffsetY={setAvatarOffsetY}
            runAvatarPipeline={runAvatarPipeline} pipeRenderedVideoUrl={videoUrl || preRenderUrl || pipe.current.renderedVideoUrl}
            projectName={projectName} onSaveTemplate={() => {
              const templates = JSON.parse(localStorage.getItem("ve_templates_v1") ?? "[]");
              localStorage.setItem("ve_templates_v1", JSON.stringify([{ id: `tpl_${Date.now()}`, name: projectName, savedAt: Date.now(), style: { fontFamily: subFontFamily, fontSize: subFontSize, fontWeight: subFontWeight, color: subColor, accentColor: subAccentColor, preset: subPreset, effect: subEffect, position: subPosition } }, ...templates].slice(0, 20)));
              toast.success("Template saved");
            }}
            onPlanError={(msg) => setUpgradeModal({ open: true, message: msg })}
          />
          </div>
        )}
      </div>

      {/* Floating detached panel */}
      {panelDetached && (
        <div
          className="fixed z-[200] flex flex-col bg-[#111115] border border-[#2a2a36] rounded-2xl shadow-[0_8px_40px_rgba(0,0,0,0.7)] overflow-hidden"
          style={{ left: panelPos.x, top: panelPos.y, width: rightPanelWide ? 520 : 360, height: "80vh", maxHeight: 700 }}
        >
          <RightSettingsPanel
            wide={rightPanelWide} detached={true} dragging={panelDragging}
            panelPos={panelPos}
            onDetach={() => {}}
            onDock={() => { setPanelDetached(false); setRightPanelOpen(true); }}
            onToggleWide={() => setRightPanelWide(v => !v)}
            onClose={() => { setPanelDetached(false); setRightPanelOpen(false); setRightPanelWide(false); }}
            onDragStart={(sx, sy) => { panelDragRef.current = { startX: sx, startY: sy, startPx: panelPos.x, startPy: panelPos.y }; setPanelDragging(true); }}
            onDragMove={(cx, cy) => { if (!panelDragRef.current) return; setPanelPos({ x: Math.max(0, panelDragRef.current.startPx + cx - panelDragRef.current.startX), y: Math.max(0, panelDragRef.current.startPy + cy - panelDragRef.current.startY) }); }}
            onDragEnd={() => { panelDragRef.current = null; setPanelDragging(false); }}
            activeTab={activeRightTab} onTab={setActiveRightTab}
            subColor={subColor} subAccentColor={subAccentColor} subPreset={subPreset}
            subFontFamily={subFontFamily} subFontSize={subFontSize} subFontWeight={subFontWeight}
            subEffect={subEffect} subPosition={subPosition} subShadow={subShadow}
            subOutline={subOutline} subOutlineSize={subOutlineSize}
            setSubPreset={setSubPreset} setSubEffect={setSubEffect} setSubFontFamily={setSubFontFamily}
            setSubFontSize={setSubFontSize} setSubFontWeight={setSubFontWeight} setSubColor={setSubColor}
            setSubAccentColor={setSubAccentColor} setSubPosition={setSubPosition}
            setSubShadow={setSubShadow} setSubOutline={setSubOutline} setSubOutlineSize={setSubOutlineSize}
            displayCaptions={displayCaptions} activeSegIdx={activeSegIdx}
            ttsProvider={ttsProvider} geminiVoiceName={geminiVoiceName} voiceId={voiceId}
            setTtsProvider={setTtsProvider} setGeminiVoiceName={setGeminiVoiceName} setVoiceId={setVoiceId}
            bgmEnabled={bgmEnabled} bgmFile={bgmFile} bgmVolume={bgmVolume}
            setBgmEnabled={setBgmEnabled} setBgmFile={setBgmFile} setBgmVolume={setBgmVolume}
            bgmUploading={bgmUploading} setBgmUploading={setBgmUploading} systemTracks={systemTracks}
            useAvatar={useAvatar} avatarId={avatarId} avatarTiming={avatarTiming}
            avatarBookendSecs={avatarBookendSecs} avatarTailSecs={avatarTailSecs}
            avatarScale={avatarScale} avatarOffsetX={avatarOffsetX} avatarOffsetY={avatarOffsetY}
            avatarPreviewUrl={avatarPreviewUrl} avatarName={avatarName}
            avatarGreenUrl={avatarGreenUrl} running={running} steps={steps}
            avatarInputMode={avatarInputMode} avatarDirectUrl={avatarDirectUrl}
            setAvatarInputMode={setAvatarInputMode} setAvatarDirectUrl={setAvatarDirectUrl}
            chromaSimilarity={chromaSimilarity} setChromaSimilarity={setChromaSimilarity}
            chromaBlend={chromaBlend} setChromaBlend={setChromaBlend}
            setUseAvatar={setUseAvatar} setAvatarId={setAvatarId} setAvatarTiming={setAvatarTiming}
            setAvatarBookendSecs={setAvatarBookendSecs} setAvatarTailSecs={setAvatarTailSecs}
            setAvatarScale={setAvatarScale} setAvatarOffsetX={setAvatarOffsetX} setAvatarOffsetY={setAvatarOffsetY}
            runAvatarPipeline={runAvatarPipeline} pipeRenderedVideoUrl={videoUrl || preRenderUrl || pipe.current.renderedVideoUrl}
            projectName={projectName} onSaveTemplate={() => {
              const templates = JSON.parse(localStorage.getItem("ve_templates_v1") ?? "[]");
              localStorage.setItem("ve_templates_v1", JSON.stringify([{ id: `tpl_${Date.now()}`, name: projectName, savedAt: Date.now(), style: { fontFamily: subFontFamily, fontSize: subFontSize, fontWeight: subFontWeight, color: subColor, accentColor: subAccentColor, preset: subPreset, effect: subEffect, position: subPosition } }, ...templates].slice(0, 20)));
              toast.success("Template saved");
            }}
            onPlanError={(msg) => setUpgradeModal({ open: true, message: msg })}
          />
        </div>
      )}

      {/* ── TIMELINE ── */}
      <div className="relative flex-shrink-0 bg-[#0e0e13] border-t border-[#1e1e28] flex flex-col" style={{ height: timelineHeight }}>
        {/* Timeline resize handle */}
        <div
          className="absolute top-0 left-0 right-0 h-1 cursor-row-resize z-10 group"
          onPointerDown={e => { e.preventDefault(); timelineResizeRef.current = { startY: e.clientY, startH: timelineHeight }; }}
        >
          <div className="absolute top-0 left-0 right-0 h-px bg-[#1e1e28] group-hover:bg-violet-500/60 group-active:bg-violet-500 transition-colors" />
        </div>

        {/* Timeline toolbar */}
        <div className="h-10 bg-[#111115] border-b border-[#1e1e28] flex items-center gap-2 px-4 flex-shrink-0">
          <span className="text-violet-400 font-bold tabular-nums text-[12px]">{fmtMs(currentMs)}</span>
          <span className="text-slate-700 text-[11px]">/ {fmtMs(totalMs)}</span>

          <div className="flex gap-0.5 ml-3">
            <button onClick={() => { if (videoRef.current) videoRef.current.currentTime = 0; }}
              className="w-6 h-6 rounded flex items-center justify-center text-slate-600 hover:bg-[#1e1e28] hover:text-slate-300" title="ต้น">
              <SkipBack className="w-3 h-3" />
            </button>
            <button onClick={playToggle}
              className="w-6 h-6 rounded flex items-center justify-center text-white bg-violet-600 hover:bg-violet-500">
              {playing ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
            </button>
            <button onClick={() => { if (videoRef.current) videoRef.current.currentTime = Math.min(videoRef.current.duration || 0, videoRef.current.currentTime + 5); }}
              className="w-6 h-6 rounded flex items-center justify-center text-slate-600 hover:bg-[#1e1e28] hover:text-slate-300" title="+5s">
              <SkipForward className="w-3 h-3" />
            </button>
          </div>

          <div className="w-px h-4 bg-[#2a2a36] mx-1" />

          <div className="flex gap-0.5">
            {/* Split at playhead */}
            <button
              onClick={() => {
                if (currentMs <= 0 || activeSegIdx < 0 || activeSegIdx >= displayCaptions.length) return;
                const cap = displayCaptions[activeSegIdx];
                if (currentMs <= cap.startMs || currentMs >= cap.endMs) return;
                const a: Caption = { ...cap, endMs: currentMs };
                const b: Caption = { ...cap, text: cap.text, startMs: currentMs };
                const next = [...displayCaptions];
                next.splice(activeSegIdx, 1, a, b);
                setCaptions(next);
              }}
              className="w-6 h-6 rounded flex items-center justify-center text-slate-600 hover:bg-[#1e1e28] hover:text-slate-300" title="แยก ณ เวลาปัจจุบัน">
              <Scissors className="w-3 h-3" />
            </button>
            {/* Delete active segment */}
            <button
              onClick={() => {
                if (activeSegIdx < 0 || activeSegIdx >= displayCaptions.length) return;
                const next = displayCaptions.filter((_, j) => j !== activeSegIdx);
                setCaptions(next);
                setActiveSegIdx(Math.max(0, activeSegIdx - 1));
              }}
              className="w-6 h-6 rounded flex items-center justify-center text-slate-600 hover:bg-[#1e1e28] hover:text-red-400" title="Delete selected segment">
              <Trash2 className="w-3 h-3" />
            </button>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <ZoomIn className="w-3 h-3 text-slate-600" />
            <div className="relative w-14 h-1 bg-[#2a2a36] rounded cursor-pointer"
              onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setTlZoom(Math.round(50 + ((e.clientX - r.left) / r.width) * 150)); }}>
              <div className="absolute left-0 top-0 h-full bg-slate-600 rounded" style={{ width: `${((tlZoom - 50) / 150) * 100}%` }} />
            </div>
            <span className="text-[11px] text-slate-600 tabular-nums">{tlZoom}%</span>
          </div>
        </div>

        {/* Timeline tracks */}
        <div className="flex flex-1 overflow-hidden">
          {/* Track labels */}
          <div className="w-[110px] flex-shrink-0 border-r border-[#1e1e28]">
            <div className="h-[18px] border-b border-[#1e1e28]" />
            {[["💬","Subtitles"],["🎬","B-roll"],["🎤","Voice"],["🎵","Music"]].map(([icon, label]) => (
              <div key={label} className="h-[38px] flex items-center gap-2 px-3 border-b border-[#1a1a20] last:border-b-0">
                <span className="text-[11px] opacity-60">{icon}</span>
                <span className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">{label}</span>
              </div>
            ))}
          </div>

          {/* Track content */}
          <div className="flex-1 overflow-x-auto overflow-y-hidden relative scrollbar-thin scrollbar-thumb-[#2a2a36]"
            onPointerMove={e => {
              const r = clipResizeRef.current;
              if (!r || e.buttons !== 1) return;
              const trackEl = e.currentTarget.querySelector(".tl-subtitle-track") as HTMLElement | null;
              if (!trackEl) return;
              const trackW = trackEl.getBoundingClientRect().width;
              const dxPx = e.clientX - r.startX;
              const dxMs = (dxPx / trackW) * totalMs;
              setCaptionsRaw(prev => {
                const next = prev.map((c, j) => {
                  if (j !== r.capIdx) return c;
                  if (r.edge === "left") {
                    const newStart = Math.max(0, Math.min(c.endMs - 200, r.startMs + dxMs));
                    return { ...c, startMs: Math.round(newStart) };
                  } else {
                    const newEnd = Math.max(c.startMs + 200, Math.min(totalMs || 999999, r.startMs + dxMs));
                    return { ...c, endMs: Math.round(newEnd) };
                  }
                });
                captionsRef.current = next;
                return next;
              });
            }}
            onPointerUp={() => {
              if (clipResizeRef.current) {
                setCaptions(captions); // push to history on release
                clipResizeRef.current = null;
              }
            }}
          >
            <div className="relative" style={{ minWidth: `${Math.max(600, displayCaptions.length * 120 * (tlZoom / 100))}px` }}>

              {/* Ruler — click/drag to seek */}
              <div className="h-[18px] bg-[#0a0a10] border-b border-[#1e1e28] relative flex items-end cursor-pointer"
                onPointerDown={e => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  if (!videoRef.current || !totalMs) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
                  videoRef.current.currentTime = pct * (totalMs / 1000);
                  setCurrentMs(pct * totalMs);
                }}
                onPointerMove={e => {
                  if (e.buttons !== 1 || !videoRef.current || !totalMs) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
                  videoRef.current.currentTime = pct * (totalMs / 1000);
                  setCurrentMs(pct * totalMs);
                }}
              >
                {[0,0.15,0.32,0.5,0.68,0.82,1].map((pct, i) => (
                  <div key={i} className="absolute bottom-0 flex flex-col items-center pointer-events-none" style={{ left: `${pct * 100}%` }}>
                    <span className="text-[9px] text-slate-700 font-mono mb-[3px]">{fmtMs(totalMs * pct)}</span>
                    <div className="w-px h-[5px] bg-[#2a2a36]" />
                  </div>
                ))}
              </div>

              {/* Subtitle clips */}
              <div className="tl-subtitle-track h-[38px] relative border-b border-[#1a1a20]">
                {displayCaptions.map((cap, i) => {
                  const left = totalMs > 0 ? (cap.startMs / totalMs) * 100 : i * (100 / displayCaptions.length);
                  const width = totalMs > 0 ? ((cap.endMs - cap.startMs) / totalMs) * 100 : (100 / displayCaptions.length) - 0.5;
                  return (
                    <div key={i} onClick={() => { setActiveSegIdx(i); if (videoRef.current) videoRef.current.currentTime = cap.startMs / 1000; }}
                      className={cn("absolute top-1.5 h-[26px] rounded-md flex items-center px-2 text-[10px] font-semibold overflow-hidden whitespace-nowrap cursor-pointer border transition-all hover:brightness-125",
                        i === activeSegIdx ? `${tagClipBg(cap.tag)} ring-1 ring-white/20` : tagClipBg(cap.tag))}
                      style={{ left: `${left}%`, width: `${Math.max(3, width)}%` }}>
                      <div className="absolute left-0 top-0 bottom-0 w-2.5 cursor-ew-resize hover:bg-white/20 rounded-l-md z-10 flex items-center justify-center"
                        onPointerDown={e => { e.stopPropagation(); e.currentTarget.parentElement!.parentElement!.parentElement!.setPointerCapture(e.pointerId); clipResizeRef.current = { capIdx: i, edge: "left", startX: e.clientX, startMs: cap.startMs }; }} />
                      <span className="truncate px-2">{cap.text.slice(0, 20)}{cap.text.length > 20 ? "..." : ""}</span>
                      <div className="absolute right-0 top-0 bottom-0 w-2.5 cursor-ew-resize hover:bg-white/20 rounded-r-md z-10 flex items-center justify-center"
                        onPointerDown={e => { e.stopPropagation(); e.currentTarget.parentElement!.parentElement!.parentElement!.setPointerCapture(e.pointerId); clipResizeRef.current = { capIdx: i, edge: "right", startX: e.clientX, startMs: cap.endMs }; }} />
                    </div>
                  );
                })}
              </div>

              {/* B-roll clips — all stockVideos */}
              <div className="h-[38px] relative border-b border-[#1a1a20]">
                {stockVideos.length > 0 ? stockVideos.map((sv, i) => {
                  const n = stockVideos.length;
                  const left = (i / n) * 100;
                  const width = (1 / n) * 100 - 0.3;
                  return (
                    <div key={i} className="absolute top-1.5 h-[26px] rounded-md flex items-center px-2 text-[10px] font-semibold bg-sky-500/10 border border-sky-500/25 text-sky-300 overflow-hidden whitespace-nowrap cursor-pointer hover:brightness-125 transition-all"
                      style={{ left: `${left}%`, width: `${width}%` }}>
                      <div className="absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize bg-white/10 rounded-l-md" />
                      <span className="truncate">{sv.keyword || `Clip ${i + 1}`}</span>
                      <div className="absolute right-0 top-0 bottom-0 w-1 cursor-ew-resize bg-white/10 rounded-r-md" />
                    </div>
                  );
                }) : (
                  <div className="absolute top-1.5 left-0 right-0 h-[26px] rounded-md border border-dashed border-[#2a2a36] flex items-center justify-center text-[10px] text-slate-700">
                    B-roll shown after render
                  </div>
                )}
              </div>

              {/* Voice track */}
              <div className="h-[38px] relative border-b border-[#1a1a20]">
                <div className="absolute top-1.5 left-0 right-0 h-[26px] rounded-md flex items-center px-3 text-[10px] font-semibold overflow-hidden"
                  style={{ background: ttsUrl ? "linear-gradient(90deg,rgba(16,185,129,0.12),rgba(16,185,129,0.08))" : "transparent", border: ttsUrl ? "1px solid rgba(16,185,129,0.25)" : "1px dashed #2a2a36", color: ttsUrl ? "#34d399" : "#3a3a4a" }}>
                  🎤 {ttsUrl ? "Voice TTS" : "No voice yet — click Render to generate"}
                </div>
              </div>

              {/* Music track */}
              <div className="h-[38px] relative">
                <div className="absolute top-1.5 left-0 right-0 h-[26px] rounded-md flex items-center px-3 text-[10px] font-semibold overflow-hidden"
                  style={{ background: bgmEnabled ? "rgba(124,58,237,0.1)" : "transparent", border: bgmEnabled ? "1px solid rgba(124,58,237,0.25)" : "1px dashed #2a2a36", color: bgmEnabled ? "#a78bfa" : "#3a3a4a", opacity: bgmEnabled ? 1 : 0.5 }}>
                  🎵 {bgmEnabled ? (bgmFile || "Background Music") : "No music selected"}
                </div>
              </div>

              {/* Playhead */}
              <div className="absolute top-0 bottom-0 w-[1.5px] bg-violet-500 pointer-events-none z-10"
                style={{ left: totalMs > 0 ? `${(currentMs / totalMs) * 100}%` : "0%" }}>
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-violet-500 shadow-[0_0_6px_rgba(124,58,237,0.8)]" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Missing key modal */}
      {missingKey && (
        <ApiKeyModal
          keyType={missingKey.type}
          onClose={() => setMissingKey(null)}
          onSaved={() => {
            const step = missingKey.retryStep;
            setMissingKey(null);
            if (step === "runAvatarPipeline") runAvatarPipeline();
            else runAll();
          }}
        />
      )}

      <UpgradeModal
        open={upgradeModal.open}
        message={upgradeModal.message}
        onClose={() => setUpgradeModal({ open: false })}
      />

      {/* Hidden audio element for TTS preview before video is ready */}
      <audio ref={audioRef} src={ttsUrl || undefined} muted={avatarInputMode === "direct"} style={{ display: "none" }} />
    </div>
  );
}
