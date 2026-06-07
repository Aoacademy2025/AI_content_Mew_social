"use client";

import React from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Music, Upload, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { GEMINI_VOICES } from "@/lib/gemini-voices";
import type { StepState } from "./types";
import { DirectAvatarUpload } from "./DirectAvatarUpload";

export interface OrderPanelProps {
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
  onReloadAvatar?: () => void; avatarStatus?: "idle" | "loading" | "ok" | "error" | "unverified";
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

export function OrderPanel(p: OrderPanelProps) {
  const posCanvasRef = React.useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = React.useState(false);

  // Note: page.tsx uses range -200..200 for avatarOffsetX/Y.
  // OrderPanel uses -2..2 internally for drag precision, but converts to
  // the page's scale (×100) before writing to state.
  function updatePosFromPointer(clientX: number, clientY: number) {
    const el = posCanvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width - 0.5) * 2;
    const ny = -((clientY - rect.top) / rect.height - 0.5) * 2;
    p.setAvatarOffsetX(Math.max(-200, Math.min(200, Math.round(nx * 100))));
    p.setAvatarOffsetY(Math.max(-200, Math.min(200, Math.round(ny * 100))));
  }

  return (
    <div className="flex-shrink-0 border-r border-[#1e1e28] flex flex-col h-full bg-[#111115]" style={{ width: p.open ? 260 : 32 }}>
      {/* Header */}
      <div className="h-11 flex items-center justify-between px-3 border-b border-[#1e1e28] flex-shrink-0">
        {p.open && <span className="text-[12px] font-bold text-slate-300">Pipeline</span>}
        <button onClick={p.onToggle} className="ml-auto w-6 h-6 flex items-center justify-center text-slate-600 hover:text-slate-300 transition-colors rounded">
          {p.open ? <ChevronLeft className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
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
                      <div className="flex gap-1.5">
                        <input value={p.avatarId} onChange={e => p.setAvatarId(e.target.value)} placeholder="ID: josh_lite_2023..."
                          className="flex-1 min-w-0 bg-[#1a1a22] border border-[#2a2a36] rounded-lg px-3 py-2 text-[11px] font-mono text-slate-300 outline-none" />
                        <button
                          onClick={() => p.onReloadAvatar?.()}
                          disabled={p.avatarId.trim().length < 10 || p.avatarStatus === "loading"}
                          title="เช็คว่า Avatar ID นี้ใช้ได้ไหม"
                          className="px-3 rounded-lg text-[11px] font-bold whitespace-nowrap transition-colors bg-violet-600 text-white hover:bg-violet-500 disabled:bg-[#2a2a36] disabled:text-slate-600 disabled:cursor-not-allowed">
                          {p.avatarStatus === "loading" ? "..." : "เช็ค ID"}
                        </button>
                      </div>
                      {p.avatarStatus === "error" && p.avatarId.trim().length >= 10 && (
                        <div className="flex items-center gap-2 rounded-lg px-2.5 py-2 bg-red-500/10 border border-red-500/30">
                          <span className="text-red-400 text-sm">✕</span>
                          <p className="text-[11px] font-semibold text-red-300">เช็คไม่สำเร็จ (key/เน็ต)</p>
                        </div>
                      )}
                      {p.avatarStatus === "unverified" && p.avatarId.trim().length >= 10 && (
                        <div className="flex items-center gap-2 rounded-lg px-2.5 py-2 bg-amber-500/10 border border-amber-500/30">
                          <span className="text-amber-400 text-sm">!</span>
                          <p className="text-[11px] font-semibold text-amber-300">ยืนยันไม่ได้ — แต่ลอง render ได้</p>
                        </div>
                      )}
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
                          <div className="absolute top-1.3 left-1.5 bg-black/75 text-[8px] text-white/80 px-1.5 py-1 rounded font-mono pointer-events-none leading-snug">
                            X: {p.avatarOffsetX}<br />Y: {p.avatarOffsetY}<br />SCALE: {p.avatarScale.toFixed(2)}
                          </div>
                          {p.avatarPreviewUrl && (
                            <div className="absolute pointer-events-none overflow-hidden" style={{ width:`${p.avatarScale*64}%`, aspectRatio:"15/16", left:`${51.5+(p.avatarOffsetX/200)*50}%`, bottom:`${(0.09-(p.avatarOffsetY/200))*50}%`, transform:"translateX(-50%)", outline:"1px solid rgba(99,179,237,0.4)" }}>
                              {/* Show the ORIGINAL avatar image in full (contain) — no
                                  cropping. cover used to chop the head off; contain fits
                                  the whole portrait inside the position box. */}
                              <img src={p.avatarPreviewUrl} draggable={false} className="w-full h-full" style={{ objectFit:"contain", objectPosition:"center top" }} />
                            </div>
                          )}
                          {p.avatarGreenUrl && (
                            <video src={p.avatarGreenUrl} className="absolute inset-0 w-full h-full object-cover pointer-events-none" style={{ mixBlendMode:"screen", opacity:0.85 }} muted loop autoPlay playsInline />
                          )}
                          <div className="absolute w-2.5 h-2.5 rounded-full border-2 border-cyan-400 bg-cyan-500/50 pointer-events-none" style={{ left:`${50+(p.avatarOffsetX/200)*50}%`, bottom:`${(-0.05-(p.avatarOffsetY/200))*50}%`, transform:"translate(-50%, 50%)" }} />
                        </div>
                        {/* Sliders */}
                        <div className="space-y-2">
                          {([
                            { label:"Offset X", value:p.avatarOffsetX, onChange:p.setAvatarOffsetX, min:-200, max:200, step:1 },
                            { label:"Offset Y", value:p.avatarOffsetY, onChange:p.setAvatarOffsetY, min:-200, max:200, step:1 },
                            { label:"Scale",    value:p.avatarScale,   onChange:p.setAvatarScale,   min:0.1, max:5.0, step:0.01 },
                          ] as const).map(({label,value,onChange,min,max,step})=>(
                            <div key={label} className="space-y-1">
                              <div className="flex justify-between">
                                <span className="text-[9px] font-bold uppercase tracking-widest text-slate-600">{label}</span>
                                <span className="text-[9px] font-mono text-cyan-400">{typeof value === 'number' && Number.isInteger(value) ? value : value.toFixed(2)}</span>
                              </div>
                              <input type="range" min={min} max={max} step={step} value={value} onChange={e=>onChange(Number(e.target.value))} className="w-full accent-cyan-400 h-1" />
                            </div>
                          ))}
                          <button onClick={()=>{p.setAvatarOffsetX(0);p.setAvatarOffsetY(0.13*200);p.setAvatarScale(2.02);}} className="text-[9px] text-slate-600 hover:text-slate-400 w-full text-center">↺ Reset</button>
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
