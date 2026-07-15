"use client";

/**
 * /video-editor-mobile — Mobile-first, CapCut-style editor (UI prototype).
 *
 * A vertical phone editor: preview on top → center-playhead timeline → a
 * horizontally-scrolling tool bar → bottom sheets per tool. State is local
 * (no backend wiring yet); this is the UI shell the full pipeline can plug
 * into. Single accent = brand violet (#8b5cf6), per CLAUDE.md.
 *
 * On a phone this fills the screen; on desktop it centres as a 480px column.
 */

import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  X, Undo2, Redo2, Download, Play, Pause, Maximize2, Settings2, ZoomIn, Plus,
  ChevronDown, Scissors, Captions, Type, Sparkles, Mic, Music, User,
  Image as ImageIcon, Crop, Copy, Trash2, Gauge, VolumeX, RefreshCw, Check,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// ─── data ────────────────────────────────────────────────────────────────
type SheetKey = "caption" | "style" | "split" | "voice" | "music" | "avatar" | "broll" | "ratio";

const CLIPS = [
  { w: 80, grad: "linear-gradient(150deg,#5b4ea0,#2b2540)", dur: "4.0s" },
  { w: 92, grad: "linear-gradient(150deg,#a0623e,#3a261c)", dur: "4.6s", sel: true },
  { w: 84, grad: "linear-gradient(150deg,#3e7aa0,#1c2e3a)", dur: "4.2s" },
  { w: 90, grad: "linear-gradient(150deg,#7a9b4e,#2e3a1c)", dur: "4.5s" },
  { w: 88, grad: "linear-gradient(150deg,#9b4e8a,#3a1c33)", dur: "4.4s" },
  { w: 94, grad: "linear-gradient(150deg,#4e9b8a,#1c3a33)", dur: "4.7s" },
  { w: 86, grad: "linear-gradient(150deg,#9b864e,#3a311c)", dur: "4.3s" },
];

const CAP_PILLS = [
  { w: 78, t: "รู้มั้ย คนรวย" }, { w: 90, t: "ข้อแรก จ่ายก่อน" }, { w: 82, t: "หักออม 10%" },
  { w: 88, t: "ไม่ซื้อเพื่ออวด" }, { w: 86, t: "พอร์ตโต" }, { w: 92, t: "ลงทุนความรู้" },
];

const MAIN_TOOLS: { icon: LucideIcon; label: string; sheet?: SheetKey; clip?: boolean }[] = [
  { icon: Scissors, label: "ตัด", clip: true },
  { icon: Captions, label: "ซับอัตโนมัติ", sheet: "caption" },
  { icon: Type, label: "สไตล์ซับ", sheet: "style" },
  { icon: Sparkles, label: "แบ่งคำ", sheet: "split" },
  { icon: Mic, label: "เสียง", sheet: "voice" },
  { icon: Music, label: "เพลง", sheet: "music" },
  { icon: User, label: "Avatar", sheet: "avatar" },
  { icon: ImageIcon, label: "B-roll", sheet: "broll" },
  { icon: Crop, label: "อัตราส่วน", sheet: "ratio" },
];

const CLIP_TOOLS: { icon: LucideIcon; label: string; sheet?: SheetKey; leave?: boolean }[] = [
  { icon: Scissors, label: "แยก", leave: true },
  { icon: RefreshCw, label: "แทนที่", sheet: "broll" },
  { icon: Copy, label: "ก็อปปี้" },
  { icon: Gauge, label: "ความเร็ว" },
  { icon: VolumeX, label: "ปิดเสียง" },
  { icon: Trash2, label: "ลบ", leave: true },
];

const SHEET_TITLE: Record<SheetKey, string> = {
  caption: "ซับอัตโนมัติ", style: "สไตล์ซับ", split: "แบ่งคำ / ช่วงซับ", voice: "เสียงพากย์",
  music: "เพลงประกอบ", avatar: "AI Avatar", broll: "เปลี่ยน B-roll", ratio: "อัตราส่วน",
};

// deterministic waveform heights (no Math.random → stable render)
const WAVE = Array.from({ length: 60 }, (_, i) => {
  const t = i / 60;
  return 0.3 + 0.55 * Math.abs(Math.sin(t * 22 + Math.sin(t * 7) * 3)) * (0.6 + 0.4 * Math.sin(t * 3.1));
});

// ─── small building blocks ─────────────────────────────────────────────────
function Chip({ active, onClick, children }: { active?: boolean; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "h-[34px] shrink-0 rounded-full px-4 text-[12.5px] font-semibold transition-colors",
        active
          ? "bg-gradient-to-b from-violet-500 to-violet-600 text-white shadow-[0_4px_12px_-2px_rgba(139,92,246,0.5)]"
          : "border border-[#2A2A31] bg-[#1E1E23] text-[#9A9AA3] hover:text-[#F2F2F5]"
      )}
    >
      {children}
    </button>
  );
}

function Swatch({ color, active, onClick }: { color: string; active?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={`สี ${color}`}
      className={cn(
        "h-[34px] w-[34px] shrink-0 rounded-full border border-white/15 transition-shadow",
        active && "ring-2 ring-violet-500 ring-offset-2 ring-offset-[#161619]"
      )}
      style={{ background: color }}
    />
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-2.5 text-[10px] font-bold uppercase tracking-[0.07em] text-[#9A9AA3]">{children}</div>;
}

function Slider({ value }: { value: number }) {
  return (
    <div className="relative h-1.5 flex-1 rounded-full bg-[#0E0E11]">
      <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-violet-500 to-[#a98bff]" style={{ width: `${value}%` }} />
      <div className="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_2px_6px_rgba(0,0,0,0.5)]" style={{ left: `${value}%` }} />
    </div>
  );
}

function Toggle({ on }: { on: boolean }) {
  return (
    <span className={cn("relative h-6 w-[42px] shrink-0 rounded-full transition-colors", on ? "bg-violet-500" : "bg-[#3a3a44]")}>
      <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all", on ? "left-[20px]" : "left-0.5")} />
    </span>
  );
}

function Waveform({ className }: { className?: string }) {
  return (
    <div className={cn("flex h-full items-center gap-[2px]", className)}>
      {WAVE.map((h, i) => (
        <span key={i} className="flex-1 rounded-full bg-emerald-400/55" style={{ height: `${Math.max(10, h * 100)}%` }} />
      ))}
    </div>
  );
}

// ─── page ──────────────────────────────────────────────────────────────────
export default function VideoEditorMobilePage() {
  const [sheet, setSheet] = useState<SheetKey | null>(null);
  const [clipMode, setClipMode] = useState(false);
  const [playing, setPlaying] = useState(false);

  // sheet selections (prototype state)
  const [split, setSplit] = useState("≤2 คำ");
  const [font, setFont] = useState("Bai Jamjuree");
  const [textColor, setTextColor] = useState("#ffffff");
  const [hiColor, setHiColor] = useState("#8B5CF6");
  const [pos, setPos] = useState(6);
  const [karaoke, setKaraoke] = useState(true);
  const [shadow, setShadow] = useState(false);
  const [preset, setPreset] = useState("ไวรัลคำเด่น");
  const [lang, setLang] = useState("ไทย");
  const [voice, setVoice] = useState("พลอย — หญิง สดใส");
  const [provider, setProvider] = useState("Gemini TTS");
  const [genre, setGenre] = useState("ฮิตติ้ง");
  const [track, setTrack] = useState("Rise Up");
  const [avatarMode, setAvatarMode] = useState("เปิด–ปิดท้าย");
  const [brollSrc, setBrollSrc] = useState("AI สร้างภาพ");
  const [ratio, setRatio] = useState("9:16 · TikTok/Reels");

  const closeSheet = () => setSheet(null);
  const enterClip = () => { setSheet(null); setClipMode(true); };
  const leaveClip = () => { setSheet(null); setClipMode(false); };

  return (
    <div className="ve-no-padding relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#08080a]">
      {/* centred phone column (fills screen on real mobile) */}
      <div className="relative mx-auto flex min-h-0 w-full max-w-[480px] flex-1 flex-col overflow-hidden bg-[#0B0B0D] text-[#F2F2F5]">

        {/* ── top bar ── */}
        <div className="flex h-[50px] shrink-0 items-center gap-1.5 px-3.5">
          <button className="grid h-[34px] w-[34px] place-items-center rounded-[10px] text-[#F2F2F5] active:bg-[#1E1E23]" aria-label="ปิด">
            <X className="h-[22px] w-[22px]" />
          </button>
          <button className="grid h-[34px] w-[34px] place-items-center rounded-[10px] text-[#62626C] active:bg-[#1E1E23]" aria-label="ย้อนกลับ">
            <Undo2 className="h-5 w-5" />
          </button>
          <button className="grid h-[34px] w-[34px] place-items-center rounded-[10px] text-[#62626C] active:bg-[#1E1E23]" aria-label="ทำซ้ำ">
            <Redo2 className="h-5 w-5" />
          </button>
          <div className="flex-1" />
          <button className="flex h-[30px] items-center gap-1.5 rounded-[9px] bg-[#1E1E23] px-2.5 font-mono text-[11.5px] font-bold">
            1080P <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button className="flex h-[34px] items-center gap-1.5 rounded-[11px] bg-gradient-to-b from-[#9168ff] to-[#7a4ff0] px-4 text-[12.5px] font-extrabold text-white shadow-[0_5px_16px_-4px_rgba(139,92,246,0.6),inset_0_1px_0_rgba(255,255,255,0.25)] active:brightness-95">
            <Download className="h-[15px] w-[15px]" /> ส่งออก
          </button>
        </div>

        {/* ── preview ── */}
        <button
          type="button"
          onClick={() => { setClipMode(false); setSheet(null); }}
          className="relative flex min-h-0 flex-1 cursor-default items-center justify-center bg-[radial-gradient(70%_60%_at_50%_35%,#141119,#0a0a0c)] px-4 pb-1 pt-2 text-left"
        >
          <div className="relative h-full overflow-hidden rounded-lg bg-black shadow-[0_10px_30px_-12px_rgba(0,0,0,0.7)]" style={{ aspectRatio: "9 / 16", maxHeight: "100%" }}>
            <div className="absolute inset-0" style={{ background: "radial-gradient(70% 50% at 28% 22%, rgba(139,92,246,.5), transparent 60%), radial-gradient(80% 60% at 82% 92%, rgba(245,140,60,.42), transparent 55%), linear-gradient(200deg,#2a2440,#121019 72%)" }} />
            <div className="absolute inset-0 shadow-[inset_0_-64px_80px_-34px_rgba(0,0,0,0.7)]" />
            {/* live subtitle */}
            <div className="absolute inset-x-0 bottom-[20%] px-3.5 text-center">
              <div className="font-[var(--f-disp)] text-[clamp(18px,5.4vw,30px)] font-extrabold leading-[1.16] text-white [text-shadow:0_2px_0_rgba(0,0,0,0.5)]" style={{ fontFamily: '"Bai Jamjuree",sans-serif' }}>
                ข้อแรก{" "}
                <span className="inline-block -rotate-[1.5deg] rounded-md bg-violet-500 px-[7px] shadow-[0_4px_14px_rgba(139,92,246,0.6)]">จ่ายให้ตัวเองก่อน</span>
              </div>
            </div>
            {/* selected caption bbox */}
            <div className="pointer-events-none absolute inset-x-[8%] bottom-[17%] h-[23%] rounded-lg border-[1.4px] border-white">
              {["-left-[7px] -top-[7px]", "-right-[7px] -top-[7px]", "-left-[7px] -bottom-[7px]", "-right-[7px] -bottom-[7px]"].map((p, i) => (
                <span key={i} className={cn("absolute h-3.5 w-3.5 rounded-full bg-white", p)} />
              ))}
            </div>
            {/* bottom controls */}
            <div className="absolute inset-x-0 bottom-2 flex items-center gap-2.5 px-5">
              <button
                onClick={(e) => { e.stopPropagation(); setPlaying(p => !p); }}
                className="grid h-[30px] w-[30px] place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm"
                aria-label={playing ? "หยุด" : "เล่น"}
              >
                {playing ? <Pause className="h-3.5 w-3.5 fill-white" /> : <Play className="h-3.5 w-3.5 fill-white" />}
              </button>
              <span className="font-mono text-[11px] text-white">00:11 <span className="text-white/55">/ 00:48</span></span>
              <button onClick={(e) => e.stopPropagation()} className="ml-auto grid h-[30px] w-[30px] place-items-center rounded-lg bg-black/45 text-white" aria-label="เต็มจอ">
                <Maximize2 className="h-[15px] w-[15px]" />
              </button>
            </div>
          </div>
        </button>

        {/* ── timeline ── */}
        <div className="relative h-[148px] shrink-0 overflow-hidden border-t border-[#2A2A31] bg-[#0B0B0D]">
          <div className="flex h-[30px] items-center gap-2.5 px-3.5 text-[11px] text-[#9A9AA3]">
            <span className="font-mono font-semibold text-[#F2F2F5]">00:11</span>
            <span className="text-[#62626C]">/ 00:48</span>
            <div className="flex-1" />
            <button className="grid h-[26px] w-[26px] place-items-center rounded-md active:bg-[#1E1E23]" aria-label="ซูม"><ZoomIn className="h-[17px] w-[17px]" /></button>
            <button className="grid h-[26px] w-[26px] place-items-center rounded-md active:bg-[#1E1E23]" aria-label="ตั้งค่า"><Settings2 className="h-[17px] w-[17px]" /></button>
          </div>

          {/* center playhead */}
          <div className="pointer-events-none absolute bottom-0 left-1/2 top-[30px] z-20 w-0.5 bg-white">
            <div className="absolute -left-[5px] -top-px h-2 w-3 rounded-sm bg-white" />
          </div>

          {/* scrolling tracks */}
          <div className="absolute inset-x-0 bottom-0 top-[30px] overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {/* ruler */}
            <div className="flex h-3.5 items-center" style={{ paddingLeft: "calc(50% - 86px)" }}>
              {["00:00", "00:06", "00:12", "00:18", "00:24", "00:30", "00:36"].map(t => (
                <span key={t} className="w-[74px] shrink-0 font-mono text-[9px] text-[#62626C]">{t}</span>
              ))}
            </div>
            {/* b-roll track */}
            <div className="my-1.5 flex" style={{ paddingLeft: "calc(50% - 86px)", paddingRight: "50%" }}>
              {CLIPS.map((c, i) => (
                <button
                  key={i}
                  onClick={() => setClipMode(true)}
                  className={cn(
                    "relative mr-0.5 h-[46px] shrink-0 overflow-hidden rounded-md border-2 border-transparent",
                    c.sel && "border-violet-500 shadow-[0_0_0_1px_#8b5cf6]"
                  )}
                  style={{ width: c.w, background: c.grad }}
                >
                  {c.sel && <span className="absolute left-1 top-1/2 z-[3] h-4 w-[3px] -translate-y-1/2 rounded-sm bg-white" />}
                  {c.sel && <span className="absolute right-1 top-1/2 z-[3] h-4 w-[3px] -translate-y-1/2 rounded-sm bg-white" />}
                  <span className="absolute bottom-[3px] left-[5px] font-mono text-[8.5px] text-white/90">{c.dur}</span>
                </button>
              ))}
            </div>
            {/* caption track */}
            <div className="my-1.5 flex" style={{ paddingLeft: "calc(50% - 86px)", paddingRight: "50%" }}>
              {CAP_PILLS.map((c, i) => (
                <div key={i} className="mr-[3px] flex h-[22px] shrink-0 items-center overflow-hidden whitespace-nowrap rounded-md border border-violet-500/50 bg-violet-500/15 px-2 text-[10px] font-semibold text-[#B9A2FF]" style={{ width: c.w }}>
                  {c.t}
                </div>
              ))}
            </div>
            {/* audio track */}
            <div className="my-1.5 flex items-center" style={{ paddingLeft: "calc(50% - 86px)", paddingRight: "50%" }}>
              <div className="mr-[3px] flex h-6 shrink-0 items-center gap-1.5 overflow-hidden rounded-md border border-emerald-400/35 bg-emerald-400/10 px-2" style={{ width: 344 }}>
                <Mic className="h-3 w-3 shrink-0 text-emerald-400" />
                <span className="shrink-0 text-[9.5px] font-semibold text-emerald-400">เสียงพากย์ · Gemini</span>
                <div className="h-3.5 min-w-0 flex-1"><Waveform /></div>
              </div>
              <button className="flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-dashed border-[#34343C] px-2.5 text-[10px] font-semibold text-[#9A9AA3]">
                <Plus className="h-3 w-3" /> เพิ่มเพลง
              </button>
            </div>
          </div>
        </div>

        {/* ── bottom toolbar (main / clip) ── */}
        {!clipMode ? (
          <div className="flex h-[74px] shrink-0 items-center gap-0.5 overflow-x-auto border-t border-[#2A2A31] bg-[#161619] px-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {MAIN_TOOLS.map((t) => {
              const Icon = t.icon;
              const active = !!t.sheet && sheet === t.sheet;
              return (
                <button
                  key={t.label}
                  onClick={() => (t.clip ? enterClip() : t.sheet && setSheet(t.sheet))}
                  className={cn("flex h-[60px] w-[62px] shrink-0 flex-col items-center justify-center gap-1.5 rounded-xl active:bg-[#1E1E23]", active && "bg-[#1E1E23]")}
                >
                  <Icon className={cn("h-6 w-6", active ? "text-[#B9A2FF]" : "text-[#F2F2F5]")} />
                  <span className={cn("text-[10px] font-semibold", active ? "text-[#B9A2FF]" : "text-[#9A9AA3]")}>{t.label}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex h-[74px] shrink-0 items-center gap-0.5 overflow-x-auto border-t border-[#2A2A31] bg-[#161619] px-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {CLIP_TOOLS.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.label}
                  onClick={() => (t.leave ? leaveClip() : t.sheet ? setSheet(t.sheet) : undefined)}
                  className="flex h-[60px] w-[62px] shrink-0 flex-col items-center justify-center gap-1.5 rounded-xl active:bg-[#1E1E23]"
                >
                  <Icon className="h-6 w-6 text-[#F2F2F5]" />
                  <span className="text-[10px] font-semibold text-[#9A9AA3]">{t.label}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* ── scrim + bottom sheet ── */}
        <div
          onClick={closeSheet}
          className={cn("absolute inset-0 z-40 bg-black/50 transition-opacity", sheet ? "opacity-100" : "pointer-events-none opacity-0")}
        />
        <div
          className={cn(
            "absolute inset-x-0 bottom-0 z-50 flex max-h-[62%] flex-col rounded-t-[18px] border-t border-[#34343C] bg-[#161619] shadow-[0_-16px_40px_-16px_rgba(0,0,0,0.6)] transition-transform duration-[260ms] [transition-timing-function:cubic-bezier(.22,1,.36,1)]",
            sheet ? "translate-y-0" : "translate-y-full"
          )}
        >
          <div className="mx-auto mb-1 mt-2.5 h-1 w-9 rounded-full bg-[#34343C]" />
          <div className="flex items-center justify-between border-b border-[#2A2A31] px-4 pb-3 pt-1.5">
            <h3 className="m-0 text-[14.5px] font-bold" style={{ fontFamily: '"Bai Jamjuree",sans-serif' }}>{sheet ? SHEET_TITLE[sheet] : ""}</h3>
            <button onClick={closeSheet} className="h-[30px] rounded-[9px] border border-violet-500/50 bg-violet-500/15 px-3.5 text-[12px] font-bold text-[#B9A2FF]">เสร็จ</button>
          </div>
          <div className="overflow-y-auto px-4 pb-6 pt-3.5">
            {sheet === "caption" && (
              <>
                <button className="flex h-[46px] w-full items-center justify-center gap-2.5 rounded-[13px] bg-gradient-to-b from-[#9168ff] to-[#7a4ff0] text-[14px] font-extrabold text-white shadow-[0_8px_20px_-6px_rgba(139,92,246,0.55)]">
                  <Check className="h-[18px] w-[18px]" /> สร้างซับจากเสียงอัตโนมัติ
                </button>
                <div className="mt-[18px]">
                  <FieldLabel>สไตล์ซับ</FieldLabel>
                  <div className="flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {["ไวรัลคำเด่น", "ประโยคยาว", "คำเดี่ยวเด้ง", "ขอบหนา"].map(p => (
                      <button key={p} onClick={() => setPreset(p)} className="w-24 shrink-0 text-center">
                        <div className={cn("mb-1.5 grid h-[62px] place-items-center rounded-[11px] border bg-[#0d0b14] font-extrabold", preset === p ? "border-violet-500/50 shadow-[0_0_0_1px_rgba(139,92,246,0.5)]" : "border-[#2A2A31]")} style={{ fontFamily: '"Bai Jamjuree",sans-serif' }}>
                          <span className="text-[13px] text-white">{p === "ไวรัลคำเด่น" ? <>ไวรัล <span className="text-[#B9A2FF]">คำ</span></> : p}</span>
                        </div>
                        <div className={cn("text-[11px] font-semibold", preset === p ? "text-[#B9A2FF]" : "text-[#9A9AA3]")}>{p}</div>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="mt-5">
                  <FieldLabel>ภาษา</FieldLabel>
                  <div className="flex gap-2">
                    {["ไทย", "อังกฤษ", "อัตโนมัติ"].map(l => <Chip key={l} active={lang === l} onClick={() => setLang(l)}>{l}</Chip>)}
                  </div>
                </div>
              </>
            )}

            {sheet === "style" && (
              <div className="flex flex-col gap-5">
                <div>
                  <FieldLabel>ฟอนต์</FieldLabel>
                  <div className="flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {["Bai Jamjuree", "Kanit", "Prompt", "Sarabun", "Mitr"].map(f => <Chip key={f} active={font === f} onClick={() => setFont(f)}>{f}</Chip>)}
                  </div>
                </div>
                <div>
                  <FieldLabel>ขนาด</FieldLabel>
                  <div className="flex items-center gap-3.5"><Slider value={58} /><span className="w-[38px] text-right font-mono text-[12px] text-[#9A9AA3]">68</span></div>
                </div>
                <div>
                  <FieldLabel>สีตัวอักษร</FieldLabel>
                  <div className="flex gap-3">{["#ffffff", "#ffe24a", "#8B5CF6", "#ff5a5a", "#34D399", "#111111"].map(c => <Swatch key={c} color={c} active={textColor === c} onClick={() => setTextColor(c)} />)}</div>
                </div>
                <div>
                  <FieldLabel>สีไฮไลต์คำสำคัญ</FieldLabel>
                  <div className="flex gap-3">{["#ffe24a", "#8B5CF6", "#ff5a5a", "#34D399", "#ff8a3d"].map(c => <Swatch key={c} color={c} active={hiColor === c} onClick={() => setHiColor(c)} />)}</div>
                </div>
                <div>
                  <FieldLabel>ตำแหน่ง</FieldLabel>
                  <div className="grid w-fit grid-cols-3 gap-2">
                    {Array.from({ length: 9 }, (_, i) => (
                      <button key={i} onClick={() => setPos(i)} className={cn("relative w-[46px] rounded-lg border bg-[#0E0E11]", pos === i ? "border-violet-500/50 bg-violet-500/15" : "border-[#2A2A31]")} style={{ aspectRatio: "9 / 13" }}>
                        {pos === i && <span className="absolute bottom-[16%] left-1/2 h-[3px] w-[54%] -translate-x-1/2 rounded-sm bg-violet-500" />}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-2.5">
                  <button onClick={() => setKaraoke(k => !k)} className="flex items-center justify-between rounded-xl border border-[#2A2A31] bg-[#1E1E23] p-3 text-left">
                    <div><div className="text-[13px] font-semibold">เด้งทีละคำ (Karaoke)</div><div className="mt-px text-[10.5px] text-[#62626C]">ไฮไลต์คำตามจังหวะเสียง</div></div>
                    <Toggle on={karaoke} />
                  </button>
                  <button onClick={() => setShadow(s => !s)} className="flex items-center justify-between rounded-xl border border-[#2A2A31] bg-[#1E1E23] p-3 text-left">
                    <div><div className="text-[13px] font-semibold">เงาตัวอักษร</div><div className="mt-px text-[10.5px] text-[#62626C]">อ่านง่ายบนพื้นสว่าง</div></div>
                    <Toggle on={shadow} />
                  </button>
                </div>
              </div>
            )}

            {sheet === "split" && (
              <>
                <FieldLabel>จำนวนคำต่อช่วง</FieldLabel>
                <div className="flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {["ประโยค", "1 คำ", "≤2 คำ", "≤3 คำ", "≤4 คำ", "กำหนดเอง"].map(m => <Chip key={m} active={split === m} onClick={() => setSplit(m)}>{m}</Chip>)}
                </div>
                <p className="mt-4 text-center text-[13px] leading-[1.7] text-[#9A9AA3]">ระบบจะแบ่งซับใหม่ทันที โดย<b className="text-[#F2F2F5]" style={{ fontFamily: '"Bai Jamjuree",sans-serif' }}>คงเวลาเดิม</b>ของเสียงพากย์ไว้ — ตัวอักษรไม่ถูกแก้</p>
              </>
            )}

            {sheet === "voice" && (
              <>
                <FieldLabel>ผู้ให้บริการ</FieldLabel>
                <div className="mb-5 flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {["Gemini TTS", "ElevenLabs", "โคลนเสียงฉัน"].map(p => <Chip key={p} active={provider === p} onClick={() => setProvider(p)}>{p}</Chip>)}
                </div>
                <FieldLabel>เสียง</FieldLabel>
                <div className="flex flex-col gap-2.5">
                  {[
                    { n: "พลอย — หญิง สดใส", s: "ไทย · เป็นกันเอง" },
                    { n: "ก้อง — ชาย ทุ้มหนักแน่น", s: "ไทย · เล่าเรื่อง" },
                    { n: "มะลิ — หญิง นุ่มนวล", s: "ไทย · ASMR" },
                  ].map(v => (
                    <button key={v.n} onClick={() => setVoice(v.n)} className={cn("flex items-center gap-3 rounded-xl border bg-[#1E1E23] p-2.5 text-left", voice === v.n ? "border-violet-500/50" : "border-[#2A2A31]")}>
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-gradient-to-b from-[#6a4e9b] to-[#281c3a]"><Play className="h-4 w-4 fill-white text-white" /></span>
                      <div><div className="text-[13px] font-semibold">{v.n}</div><div className="font-mono text-[10.5px] text-[#62626C]">{v.s}</div></div>
                      <span className={cn("ml-auto h-[30px] rounded-[9px] border px-3.5 text-[11.5px] font-bold leading-[30px]", voice === v.n ? "border-violet-500/50 bg-violet-500/15 text-[#B9A2FF]" : "border-[#2A2A31] text-[#9A9AA3]")}>{voice === v.n ? "เลือกแล้ว" : "เลือก"}</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {sheet === "music" && (
              <>
                <FieldLabel>แนวเพลง</FieldLabel>
                <div className="mb-5 flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {["ฮิตติ้ง", "ชิล", "ดราม่า", "สร้างแรงบันดาลใจ"].map(g => <Chip key={g} active={genre === g} onClick={() => setGenre(g)}>{g}</Chip>)}
                </div>
                <div className="flex flex-col gap-2.5">
                  {[{ n: "Rise Up", s: "0:48 · 124 BPM" }, { n: "Money Move", s: "0:52 · 110 BPM" }, { n: "Focus Flow", s: "1:02 · 92 BPM" }].map(m => (
                    <button key={m.n} onClick={() => setTrack(m.n)} className={cn("flex items-center gap-3 rounded-xl border bg-[#1E1E23] p-2.5 text-left", track === m.n ? "border-violet-500/50" : "border-[#2A2A31]")}>
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-gradient-to-b from-[#6a4e9b] to-[#281c3a]"><Play className="h-4 w-4 fill-white text-white" /></span>
                      <div><div className="text-[13px] font-semibold">{m.n}</div><div className="font-mono text-[10.5px] text-[#62626C]">{m.s}</div></div>
                      <span className={cn("ml-auto h-[30px] rounded-[9px] border px-3.5 text-[11.5px] font-bold leading-[30px]", track === m.n ? "border-violet-500/50 bg-violet-500/15 text-[#B9A2FF]" : "border-[#2A2A31] text-[#9A9AA3]")}>{track === m.n ? "ใช้แล้ว" : "เพิ่ม"}</span>
                    </button>
                  ))}
                </div>
                <div className="mt-3.5">
                  <FieldLabel>ระดับเสียงเพลง</FieldLabel>
                  <div className="flex items-center gap-3.5"><Slider value={35} /><span className="w-[38px] text-right font-mono text-[12px] text-[#9A9AA3]">35%</span></div>
                </div>
              </>
            )}

            {sheet === "avatar" && (
              <>
                <FieldLabel>โหมด</FieldLabel>
                <div className="mb-5 flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {["เต็มคลิป", "เปิด–ปิดท้าย", "ไม่ใช้"].map(m => <Chip key={m} active={avatarMode === m} onClick={() => setAvatarMode(m)}>{m}</Chip>)}
                </div>
                <FieldLabel>เลือก Avatar (HeyGen)</FieldLabel>
                <div className="flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {[{ n: "พรีเซนเตอร์ A", g: "linear-gradient(160deg,#3a3550,#221d30)" }, { n: "พรีเซนเตอร์ B", g: "linear-gradient(160deg,#4a3540,#2d1d25)" }, { n: "อัปโหลดเอง", g: "linear-gradient(160deg,#35404a,#1d2530)", up: true }].map((a, i) => (
                    <button key={a.n} onClick={() => setAvatarMode(avatarMode)} className="w-24 shrink-0 text-center">
                      <div className={cn("mb-1.5 grid h-[62px] place-items-center rounded-[11px] border", i === 0 ? "border-violet-500/50 shadow-[0_0_0_1px_rgba(139,92,246,0.5)]" : "border-[#2A2A31]")} style={{ background: a.g }}>
                        {a.up ? <Plus className="h-5 w-5 text-[#888]" /> : <User className="h-6 w-6 text-[#bbb]" />}
                      </div>
                      <div className={cn("text-[11px] font-semibold", i === 0 ? "text-[#B9A2FF]" : "text-[#9A9AA3]")}>{a.n}</div>
                    </button>
                  ))}
                </div>
              </>
            )}

            {sheet === "broll" && (
              <>
                <FieldLabel>แหล่งภาพ</FieldLabel>
                <div className="mb-5 flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {["AI สร้างภาพ", "Pexels", "Pixabay", "อัปโหลด"].map(s => <Chip key={s} active={brollSrc === s} onClick={() => setBrollSrc(s)}>{s}</Chip>)}
                </div>
                <FieldLabel>ผลลัพธ์สำหรับ “จ่ายให้ตัวเองก่อน”</FieldLabel>
                <div className="grid grid-cols-3 gap-2">
                  {["linear-gradient(150deg,#a0623e,#3a261c)", "linear-gradient(150deg,#5b4ea0,#2b2540)", "linear-gradient(150deg,#3e7aa0,#1c2e3a)", "linear-gradient(150deg,#7a9b4e,#2e3a1c)", "linear-gradient(150deg,#9b4e8a,#3a1c33)", "linear-gradient(150deg,#4e9b8a,#1c3a33)"].map((g, i) => (
                    <div key={i} className={cn("rounded-[10px] border-2", i === 0 ? "border-violet-500" : "border-transparent")} style={{ aspectRatio: "9 / 13", background: g }} />
                  ))}
                </div>
              </>
            )}

            {sheet === "ratio" && (
              <>
                <div className="flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {["9:16 · TikTok/Reels", "1:1", "4:5", "16:9"].map(r => <Chip key={r} active={ratio === r} onClick={() => setRatio(r)}>{r}</Chip>)}
                </div>
                <p className="mt-4 text-center text-[13px] leading-[1.7] text-[#9A9AA3]">สตูดิโอปรับแต่งสำหรับ <b className="text-[#F2F2F5]" style={{ fontFamily: '"Bai Jamjuree",sans-serif' }}>9:16 แนวตั้ง</b> — เหมาะกับ Shorts, Reels และ TikTok</p>
              </>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
