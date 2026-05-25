"use client";

import { Plus, Lock, ChevronDown, Music, Upload, X, Loader2, User } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { GEMINI_VOICES } from "@/lib/gemini-voices";
import type { Caption, StepState, SubPreset, SubTextEffect } from "./types";
import { PRESETS_DATA, EFFECTS_DATA, FONTS_LIST } from "./constants";
import { renderSubEl } from "./subtitle-renderer";
import { EffectPreviewCard, EFFECT_KEYFRAMES } from "./EffectPreviewCard";
import { SliderRow } from "./SliderRow";
import { DirectAvatarUpload } from "./DirectAvatarUpload";

export interface RightPanelProps {
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

export function RightSettingsPanel(p: RightPanelProps) {
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

        {/* Hidden voice/bgm/avatar section — moved to OrderPanel.
            Block kept (behind `false`) to preserve legacy code in version control;
            do not delete in this refactor — will remove in Phase 3. */}
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
                      <DirectAvatarUpload onUrl={p.setAvatarDirectUrl} onPlanError={(msg) => p.onPlanError?.(msg)} />
                      {p.avatarDirectUrl.trim() && (
                        <video src={p.avatarDirectUrl.trim()} controls className="w-full rounded-lg" style={{ maxHeight: 180, background: "#000" }} />
                      )}
                    </div>
                  )}

                  {p.avatarInputMode === "generate" && <div>
                    <div className="text-[10px] text-slate-600 mb-2 font-bold uppercase tracking-wider">Avatar Position</div>
                    <div className="flex gap-3">
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
                        {[25,50,75].map(p2 => <div key={`v${p2}`} className="absolute top-0 bottom-0 pointer-events-none" style={{ left: `${p2}%`, width: 1, background: p2===50?"rgba(255,255,255,0.15)":"rgba(255,255,255,0.04)" }} />)}
                        {[25,50,75].map(p2 => <div key={`h${p2}`} className="absolute left-0 right-0 pointer-events-none" style={{ top: `${p2}%`, height: 1, background: p2===50?"rgba(255,255,255,0.15)":"rgba(255,255,255,0.04)" }} />)}
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
                        <div className="absolute w-2 h-2 rounded-full border-2 border-cyan-400 bg-cyan-500/50 pointer-events-none"
                          style={{ left: `${50 + (p.avatarOffsetX / 200) * 50}%`, bottom: `${2 - (p.avatarOffsetY / 200) * 50}%`, transform: "translate(-50%, 50%)" }} />
                        <div className="absolute top-1 left-1 bg-black/75 text-[7px] text-white/70 px-1 py-0.5 rounded font-mono pointer-events-none leading-snug">
                          X:{p.avatarOffsetX}<br />Y:{p.avatarOffsetY}
                        </div>
                      </div>
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
