"use client";

import React from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Loader2, Music, Pause, Play, Upload, X, Film, Check, Sparkles, Shuffle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { GEMINI_VOICES } from "@/lib/gemini-voices";
import type { StepState, StockSource, KieImageModel, StockVideo, AutoMixImageProvider } from "./types";
import { KIE_IMAGE_MODEL_OPTIONS, AUTO_MIX_PROVIDER_OPTIONS } from "./types";
import { DirectAvatarUpload } from "./DirectAvatarUpload";
import { VoicePreviewButton } from "./VoicePreviewButton";

type UserMusicTrack = { id: string; title: string; filename: string; sizeBytes?: number | null };

// B-roll source classification — ground truth is assetMeta.provider (set by fetch-stock for
// every photo/AI asset; video clips carry `provider`). kie-ai = real AI generation; any other
// provider serving a still image = stock photo (Ken Burns); no image = real video clip.
// NOTE: every Ken Burns photo also has an imageUrl, so the old `isImage ? "AI" : "VID"` badge
// mislabeled ALL stock photos as "AI" — this restores the true AI/photo/video distinction.
const BROLL_SOURCE_LABELS: Record<string, string> = {
  pexels: "Pexels", pixabay: "Pixabay", unsplash: "Unsplash",
  wikimedia: "Wikimedia", flickr: "Flickr", nasa: "NASA", met: "The Met", "kie-ai": "kie.ai",
};
function classifyBroll(sv: StockVideo, hasImage: boolean): { kind: "ai" | "photo" | "video"; source: string } {
  const prov = sv.assetMeta?.provider;
  const kind: "ai" | "photo" | "video" = prov === "kie-ai" ? "ai" : hasImage ? "photo" : "video";
  return { kind, source: BROLL_SOURCE_LABELS[prov ?? sv.provider ?? ""] ?? "" };
}
const BROLL_BADGE: Record<"ai" | "photo" | "video", { label: string; cls: string }> = {
  ai:    { label: "AI",    cls: "bg-fuchsia-500/85" },
  photo: { label: "PHOTO", cls: "bg-emerald-500/85" },
  video: { label: "VID",   cls: "bg-sky-500/85" },
};

export interface OrderPanelProps {
  open: boolean; onToggle: () => void;
  ttsProvider: "elevenlabs" | "gemini"; geminiVoiceName: string; voiceId: string;
  setTtsProvider: (v: "elevenlabs" | "gemini") => void;
  setGeminiVoiceName: (v: string) => void; setVoiceId: (v: string) => void;
  bgmEnabled: boolean; bgmFile: string; bgmVolume: number;
  setBgmEnabled: (v: boolean) => void; setBgmFile: (v: string) => void; setBgmVolume: (v: number) => void;
  bgmUploading: boolean; setBgmUploading: (v: boolean) => void;
  systemTracks: { id: string; title: string; filename: string }[];
  userTracks: UserMusicTrack[];
  setUserTracks: (tracks: UserMusicTrack[]) => void;
  useAvatar: boolean; avatarId: string; avatarTiming: "full" | "bookend" | "bookend-both";
  avatarBookendSecs: number; avatarTailSecs: number;
  avatarScale: number; avatarOffsetX: number; avatarOffsetY: number;
  avatarPreviewUrl: string; avatarName: string;
  onReloadAvatar?: () => void; avatarStatus?: "idle" | "loading" | "ok" | "error" | "unverified";
  avatarGreenUrl: string; running: boolean; steps: StepState;
  avatarInputMode: "generate" | "direct"; avatarDirectUrl: string;
  directCompositeMode: "chromakey" | "full" | "cutaway"; setDirectCompositeMode: (m: "chromakey" | "full") => void;
  setAvatarInputMode: (v: "generate" | "direct") => void; setAvatarDirectUrl: (v: string) => void;
  chromaSimilarity: number; setChromaSimilarity: (v: number) => void;
  chromaBlend: number; setChromaBlend: (v: number) => void;
  setUseAvatar: (v: boolean) => void; setAvatarId: (v: string) => void;
  setAvatarTiming: (v: "full" | "bookend" | "bookend-both") => void;
  setAvatarBookendSecs: (v: number) => void; setAvatarTailSecs: (v: number) => void;
  setAvatarScale: (v: number) => void; setAvatarOffsetX: (v: number) => void; setAvatarOffsetY: (v: number) => void;
  onSaveAvatarLayout: () => Promise<void>; avatarLayoutSaving: boolean;
  onComposite: () => void; compositing: boolean;
  runAvatarPipeline: () => void; pipeRenderedVideoUrl?: string;
  onPlanError?: (msg: string) => void;
  stockSource: StockSource;
  setStockSource: (v: StockSource) => void;
  kieImageEnabled?: boolean; // ADMIN เท่านั้น — เปิดปุ่ม AI Image-to-Video (kie.ai)
  autoMixEnabled?: boolean; // ADMIN เท่านั้น — เปิดปุ่ม Auto Mix (video + image fallback)
  kieModel?: KieImageModel; setKieModel?: (v: KieImageModel) => void;
  autoMixProviders?: AutoMixImageProvider[]; setAutoMixProviders?: (v: AutoMixImageProvider[]) => void;
  stockVideos?: StockVideo[]; // ใช้แสดง preview ภาพที่ generate ระหว่าง/หลัง B-roll step (AI Image)
  stockCacheBust?: number; // bump ทุกครั้งที่ fetch เสร็จ → กัน browser cache ภาพชื่อไฟล์เดิม
  targetClipCount: number; // 0 = Auto (1 คลิป/ซับ), >0 = จำนวนคลิปใน 1 วิดีโอ
  setTargetClipCount: (v: number) => void;
}

// Section header แบบพรีเมียม — accent bar ม่วงเรืองแสงด้านหน้า + ปุ่ม/ตัวเลือกเสริมด้านขวา
function SectionLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-2.5">
      <span aria-hidden className="h-3 w-[3px] rounded-full bg-gradient-to-b from-violet-400 to-violet-600 shadow-[0_0_8px_rgba(139,92,246,0.55)]" />
      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{children}</span>
      {right && <span className="ml-auto">{right}</span>}
    </div>
  );
}

export function OrderPanel(p: OrderPanelProps) {
  const posCanvasRef = React.useRef<HTMLDivElement>(null);
  const musicPreviewRef = React.useRef<HTMLAudioElement | null>(null);
  const [isDragging, setIsDragging] = React.useState(false);
  const [previewingMusicUrl, setPreviewingMusicUrl] = React.useState("");

  const stopMusicPreview = React.useCallback(() => {
    musicPreviewRef.current?.pause();
    musicPreviewRef.current = null;
    setPreviewingMusicUrl("");
  }, []);

  React.useEffect(() => () => {
    stopMusicPreview();
  }, [stopMusicPreview]);

  React.useEffect(() => {
    if (!p.open) stopMusicPreview();
  }, [p.open, stopMusicPreview]);

  React.useEffect(() => {
    if (musicPreviewRef.current) {
      musicPreviewRef.current.volume = Math.max(0, Math.min(1, p.bgmVolume));
    }
  }, [p.bgmVolume]);

  const [autoMixProvidersOpen, setAutoMixProvidersOpen] = React.useState(false);
  const autoMixProvidersRef = React.useRef<HTMLDivElement>(null);
  const [geminiVoiceOpen, setGeminiVoiceOpen] = React.useState(false);
  const geminiVoiceRef = React.useRef<HTMLDivElement>(null);
  const [voiceGenderFilter, setVoiceGenderFilter] = React.useState<"all" | "Female" | "Male">("all");

  React.useEffect(() => {
    if (!autoMixProvidersOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (autoMixProvidersRef.current && !autoMixProvidersRef.current.contains(e.target as Node)) {
        setAutoMixProvidersOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [autoMixProvidersOpen]);

  React.useEffect(() => {
    if (!geminiVoiceOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (geminiVoiceRef.current && !geminiVoiceRef.current.contains(e.target as Node)) {
        setGeminiVoiceOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [geminiVoiceOpen]);

  const selectedAutoMixProviders = p.autoMixProviders ?? AUTO_MIX_PROVIDER_OPTIONS.map(o => o.value);
  function toggleAutoMixProvider(value: AutoMixImageProvider) {
    const next = selectedAutoMixProviders.includes(value)
      ? selectedAutoMixProviders.filter(v => v !== value)
      : [...selectedAutoMixProviders, value];
    p.setAutoMixProviders?.(next);
  }

  // page.tsx เก็บ avatarOffsetX/Y เป็น px ช่วง -200..200 (preview map ด้วย /200, แกน y บวก = ลง)
  // nx/ny อยู่ในช่วง -1..1 → ×200 ให้เต็มช่วง และห้ามกลับเครื่องหมาย y — ไม่งั้นลากสวนทางกับ preview
  function updatePosFromPointer(clientX: number, clientY: number) {
    const el = posCanvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width - 0.5) * 2;
    const ny = ((clientY - rect.top) / rect.height - 0.5) * 2;
    p.setAvatarOffsetX(Math.max(-200, Math.min(200, Math.round(nx * 200))));
    p.setAvatarOffsetY(Math.max(-200, Math.min(200, Math.round(ny * 200))));
  }

  async function deleteUserTrack(track: UserMusicTrack) {
    try {
      const res = await fetch(`/api/music/user/${encodeURIComponent(track.id)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "ลบเพลงไม่สำเร็จ");
        return;
      }
      if (p.bgmFile === `/api/music/${track.filename}`) p.setBgmFile("");
      if (previewingMusicUrl === `/api/music/${track.filename}`) stopMusicPreview();
      p.setUserTracks(p.userTracks.filter((t) => t.id !== track.id));
      toast.success("ลบเพลงแล้ว");
    } catch {
      toast.error("ลบเพลงไม่สำเร็จ");
    }
  }

  async function toggleMusicPreview(url: string) {
    if (previewingMusicUrl === url) {
      stopMusicPreview();
      return;
    }

    stopMusicPreview();
    const audio = new Audio(url);
    audio.volume = Math.max(0, Math.min(1, p.bgmVolume));
    audio.preload = "auto";
    musicPreviewRef.current = audio;
    setPreviewingMusicUrl(url);

    audio.onended = () => {
      if (musicPreviewRef.current === audio) stopMusicPreview();
    };
    audio.onerror = () => {
      if (musicPreviewRef.current !== audio) return;
      stopMusicPreview();
      toast.error("เล่นเพลงตัวอย่างไม่สำเร็จ");
    };

    try {
      await audio.play();
    } catch {
      if (musicPreviewRef.current === audio) stopMusicPreview();
      toast.error("เบราว์เซอร์ไม่อนุญาตให้เล่นเสียง ลองกดอีกครั้ง");
    }
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
            <SectionLabel>Stock Source</SectionLabel>
            <div className="space-y-2">
              {/* Free */}
              <button onClick={() => p.setStockSource("both")}
                className={cn("relative w-full rounded-xl border px-3 py-2.5 text-left transition-all overflow-hidden",
                  p.stockSource !== "kie-image" && p.stockSource !== "auto-mix" ? "border-violet-400/50" : "border-[#26262f] hover:border-violet-500/30")}
                style={p.stockSource !== "kie-image" && p.stockSource !== "auto-mix"
                  ? { background: "linear-gradient(135deg, rgba(139,92,246,0.20), rgba(99,102,241,0.07) 55%, rgba(139,92,246,0.04))", boxShadow: "0 0 18px rgba(139,92,246,0.18), inset 0 1px 0 rgba(255,255,255,0.06)" }
                  : { background: "#15151b" }}>
                <div className="flex items-center gap-2.5">
                  <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border",
                    p.stockSource !== "kie-image" && p.stockSource !== "auto-mix" ? "bg-violet-500/25 border-violet-400/40" : "bg-[#1e1e26] border-[#2a2a36]")}>
                    <Film className={cn("w-3.5 h-3.5", p.stockSource !== "kie-image" && p.stockSource !== "auto-mix" ? "text-violet-300" : "text-slate-500")} />
                  </div>
                  <div className="min-w-0">
                    <div className={cn("text-[12px] font-bold leading-tight", p.stockSource !== "kie-image" && p.stockSource !== "auto-mix" ? "text-violet-200" : "text-slate-400")}>Free</div>
                    <div className="text-[9px] text-slate-500 mt-0.5">Pexels + Pixabay</div>
                  </div>
                  {p.stockSource !== "kie-image" && p.stockSource !== "auto-mix" && (
                    <span className="ml-auto w-4.5 h-4.5 rounded-full bg-violet-500 flex items-center justify-center shrink-0 shadow-[0_0_8px_rgba(139,92,246,0.6)]">
                      <Check className="w-3 h-3 text-white" strokeWidth={3} />
                    </span>
                  )}
                </div>
              </button>

              {/* AI Image-to-Video — kie.ai, gold-cyan luxe */}
              <button
                disabled={!p.kieImageEnabled}
                onClick={() => p.kieImageEnabled && p.setStockSource("kie-image")}
                title={p.kieImageEnabled ? "AI สร้างภาพแล้วแปลงเป็นวิดีโอ (kie.ai) — admin beta" : "เร็วๆ นี้"}
                className={cn("relative w-full rounded-xl text-left transition-all overflow-hidden px-3 py-2.5 border",
                  p.stockSource === "kie-image" ? "border-cyan-400/60"
                  : p.kieImageEnabled ? "border-cyan-500/25 hover:border-cyan-400/50"
                  : "border-cyan-500/15 cursor-not-allowed")}
                style={p.stockSource === "kie-image"
                  ? { background: "linear-gradient(135deg, rgba(34,211,238,0.18), rgba(13,148,136,0.08) 55%, rgba(34,211,238,0.04))", boxShadow: "0 0 18px rgba(34,211,238,0.18), inset 0 1px 0 rgba(255,255,255,0.07)" }
                  : { background: "linear-gradient(135deg, rgba(34,211,238,0.05), #15151b 60%)" }}>
                {/* cyan sheen line on top */}
                <div aria-hidden className="absolute inset-x-0 top-0 h-px"
                  style={{ background: "linear-gradient(90deg, transparent, rgba(103,232,249,0.45), transparent)" }} />
                <div className={cn("flex items-center gap-2.5", !p.kieImageEnabled && "opacity-75")}>
                  <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border",
                    p.stockSource === "kie-image" ? "border-cyan-400/50" : "border-cyan-500/25")}
                    style={{ background: "linear-gradient(135deg, rgba(34,211,238,0.3), rgba(8,51,68,0.25))" }}>
                    <Sparkles className="w-3.5 h-3.5 text-cyan-300" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[12px] font-bold leading-tight"
                      style={{ background: "linear-gradient(90deg, #67e8f9, #06b6d4, #67e8f9)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                      AI Image
                    </div>
                    <div className="text-[9px] text-cyan-200/40 mt-0.5">kie.ai</div>
                  </div>
                  {p.stockSource === "kie-image" ? (
                    <span className="ml-auto w-4.5 h-4.5 rounded-full flex items-center justify-center shrink-0 shadow-[0_0_8px_rgba(34,211,238,0.6)]"
                      style={{ background: "linear-gradient(135deg, #22d3ee, #0e7490)" }}>
                      <Check className="w-3 h-3 text-white" strokeWidth={3} />
                    </span>
                  ) : (
                    <span className="ml-auto text-[8px] font-bold uppercase tracking-wider text-cyan-300 rounded-full px-2 py-0.5 shrink-0"
                      style={{ background: "rgba(34,211,238,0.10)", border: "1px solid rgba(34,211,238,0.35)", boxShadow: "0 0 10px rgba(34,211,238,0.12)" }}>
                      {p.kieImageEnabled ? "Admin Beta" : "เร็วๆ นี้"}
                    </span>
                  )}
                </div>
              </button>

              {/* Auto Mix — วิดีโอ Pexels/Pixabay เป็นหลัก, fallback เป็นภาพ (Unsplash/AI) ถ้าหา clip ไม่เจอ */}
              <button
                disabled={!p.autoMixEnabled}
                onClick={() => p.autoMixEnabled && p.setStockSource("auto-mix")}
                title={p.autoMixEnabled ? "วิดีโอเป็นหลัก + fallback เป็นภาพ Ken Burns ถ้าหา clip ไม่เจอ — admin beta" : "เร็วๆ นี้"}
                className={cn("relative w-full rounded-xl text-left transition-all overflow-hidden px-3 py-2.5 border",
                  p.stockSource === "auto-mix" ? "border-emerald-400/60"
                  : p.autoMixEnabled ? "border-emerald-500/25 hover:border-emerald-400/50"
                  : "border-emerald-500/15 cursor-not-allowed")}
                style={p.stockSource === "auto-mix"
                  ? { background: "linear-gradient(135deg, rgba(16,185,129,0.18), rgba(5,150,105,0.08) 55%, rgba(16,185,129,0.04))", boxShadow: "0 0 18px rgba(16,185,129,0.18), inset 0 1px 0 rgba(255,255,255,0.07)" }
                  : { background: "linear-gradient(135deg, rgba(16,185,129,0.05), #15151b 60%)" }}>
                <div aria-hidden className="absolute inset-x-0 top-0 h-px"
                  style={{ background: "linear-gradient(90deg, transparent, rgba(110,231,183,0.45), transparent)" }} />
                <div className={cn("flex items-center gap-2.5", !p.autoMixEnabled && "opacity-75")}>
                  <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border",
                    p.stockSource === "auto-mix" ? "border-emerald-400/50" : "border-emerald-500/25")}
                    style={{ background: "linear-gradient(135deg, rgba(16,185,129,0.3), rgba(6,78,59,0.25))" }}>
                    <Shuffle className="w-3.5 h-3.5 text-emerald-300" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[12px] font-bold leading-tight"
                      style={{ background: "linear-gradient(90deg, #6ee7b7, #10b981, #6ee7b7)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                      Auto Mix
                    </div>
                    <div className="text-[9px] text-emerald-200/40 mt-0.5">วิดีโอ + ภาพ fallback</div>
                  </div>
                  {p.stockSource === "auto-mix" ? (
                    <span className="ml-auto w-4.5 h-4.5 rounded-full flex items-center justify-center shrink-0 shadow-[0_0_8px_rgba(16,185,129,0.6)]"
                      style={{ background: "linear-gradient(135deg, #10b981, #047857)" }}>
                      <Check className="w-3 h-3 text-white" strokeWidth={3} />
                    </span>
                  ) : (
                    <span className="ml-auto text-[8px] font-bold uppercase tracking-wider text-emerald-300 rounded-full px-2 py-0.5 shrink-0"
                      style={{ background: "rgba(16,185,129,0.10)", border: "1px solid rgba(16,185,129,0.35)", boxShadow: "0 0 10px rgba(16,185,129,0.12)" }}>
                      {p.autoMixEnabled ? "Admin Beta" : "เร็วๆ นี้"}
                    </span>
                  )}
                </div>
              </button>

              {/* เลือกโมเดล text-to-image ของ kie.ai — แสดงเมื่อเลือก AI Image (ขนาดภาพ fix 9:16) — ใช้ร่วมกับ Auto Mix สำหรับ fallback ด้วย */}
              {(p.stockSource === "kie-image" && p.kieImageEnabled) || (p.stockSource === "auto-mix" && p.autoMixEnabled) ? (
                <div className="px-1">
                  <label className="text-[9px] font-bold text-cyan-300/60 uppercase tracking-wider mb-1 block">
                    Image Model (9:16)
                  </label>
                  <select
                    value={p.kieModel ?? "nano-banana-pro"}
                    onChange={(e) => p.setKieModel?.(e.target.value as KieImageModel)}
                    className="w-full rounded-lg px-2.5 py-2 text-[11px] font-semibold text-cyan-100 outline-none focus:ring-1 focus:ring-cyan-400/40"
                    style={{ background: "hsl(222 47% 7%)", border: "1px solid rgba(34,211,238,0.25)" }}
                  >
                    {KIE_IMAGE_MODEL_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              ) : null}

              {/* เลือก provider ภาพ fallback ของ Auto Mix — multi-select checklist, เปิดเฉพาะตอนเลือก Auto Mix */}
              {p.stockSource === "auto-mix" && p.autoMixEnabled && (
                <div className="px-1 relative" ref={autoMixProvidersRef}>
                  <label className="text-[9px] font-bold text-emerald-300/60 uppercase tracking-wider mb-1 block">
                    B-roll Sources ({selectedAutoMixProviders.length}/{AUTO_MIX_PROVIDER_OPTIONS.length})
                  </label>
                  <button
                    type="button"
                    onClick={() => setAutoMixProvidersOpen(v => !v)}
                    className="w-full rounded-lg px-2.5 py-2 text-[11px] font-semibold text-emerald-100 outline-none focus:ring-1 focus:ring-emerald-400/40 flex items-center justify-between"
                    style={{ background: "hsl(160 40% 7%)", border: "1px solid rgba(16,185,129,0.25)" }}
                  >
                    <span className="truncate text-left">
                      {selectedAutoMixProviders.length === AUTO_MIX_PROVIDER_OPTIONS.length
                        ? "ทุกแหล่ง (ค่าเริ่มต้น)"
                        : selectedAutoMixProviders.length === 0
                        ? "ไม่เลือกเลย — ไม่มี fallback"
                        : AUTO_MIX_PROVIDER_OPTIONS.filter(o => selectedAutoMixProviders.includes(o.value)).map(o => o.label).join(", ")}
                    </span>
                    <ChevronDown className={cn("w-3 h-3 shrink-0 ml-1 transition-transform", autoMixProvidersOpen && "rotate-180")} />
                  </button>

                  {autoMixProvidersOpen && (
                    <div className="absolute z-20 mt-1 w-full rounded-lg p-1.5 shadow-lg"
                      style={{ background: "hsl(160 40% 6%)", border: "1px solid rgba(16,185,129,0.3)" }}>
                      {AUTO_MIX_PROVIDER_OPTIONS.map((opt) => {
                        const checked = selectedAutoMixProviders.includes(opt.value);
                        return (
                          <label key={opt.value}
                            className="flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] text-slate-200 hover:bg-emerald-500/10 cursor-pointer">
                            <input type="checkbox" checked={checked} onChange={() => toggleAutoMixProvider(opt.value)}
                              className="w-3 h-3 rounded accent-emerald-500" />
                            <span className="flex-1">{opt.label}</span>
                            {opt.needsKey && (
                              <span className="text-[8px] text-slate-500 uppercase tracking-wider">key</span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {/* hint บอกว่าจะได้ video หรือภาพล้วน ตามที่เลือก "วิดีโอจริง" ไว้ไหม */}
                  <p className="text-[8px] text-emerald-200/40 mt-1 leading-relaxed">
                    {selectedAutoMixProviders.includes("video")
                      ? "หาวิดีโอจริงก่อน · ที่หาไม่เจอ fallback เป็นภาพจากแหล่งที่เลือก"
                      : "🖼 ข้ามวิดีโอ — สร้างภาพล้วนทุก keyword จากแหล่งที่เลือก"}
                  </p>
                </div>
              )}

              {/* Preview คลิป/ภาพที่ได้จาก API — โชว์ระหว่าง/หลัง step B-roll
                  รวมทั้ง video clips (Pexels/Pixabay) และภาพ AI generate (kie.ai/Auto Mix fallback) */}
              {!!p.stockVideos?.some(sv => sv.imageLocalUrl || sv.imageUrl || sv.localUrl || sv.videoUrl) && (
                <div className="px-1">
                  <label className="text-[9px] font-bold text-cyan-300/60 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                    {p.steps.fetchStock === "running" && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                    B-roll ที่ได้ ({p.stockVideos!.filter(sv => sv.imageLocalUrl || sv.imageUrl || sv.localUrl || sv.videoUrl).length})
                  </label>
                  <div className="grid grid-cols-3 gap-1.5">
                    {p.stockVideos!.map((sv, i) => {
                      // append cache-bust เฉพาะ local file (ชื่อซ้ำข้ามรอบ) — external URL ไม่ต้อง
                      const bust = (u?: string) => u
                        ? (u.startsWith("/api/") && p.stockCacheBust ? `${u}${u.includes("?") ? "&" : "?"}v=${p.stockCacheBust}` : u)
                        : undefined;
                      const imgSrc = bust(sv.imageLocalUrl) || sv.imageUrl;
                      const vidSrc = bust(sv.localUrl) || sv.videoUrl;
                      if (!imgSrc && !vidSrc) return null;
                      // isImage decides img-vs-video element only; the BADGE uses assetMeta
                      // (via classifyBroll) so stock photos aren't lumped in with AI.
                      const isImage = !!imgSrc;
                      const { kind, source } = classifyBroll(sv, isImage);
                      const badge = BROLL_BADGE[kind];
                      return (
                        <div key={i} className="relative aspect-9/16 rounded-md overflow-hidden border border-cyan-500/20 bg-[#0a0a0f] group/clip">
                          {isImage ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={imgSrc} alt={sv.keyword || `clip ${i + 1}`} className="w-full h-full object-cover" loading="lazy" />
                          ) : (
                            <video src={vidSrc} className="w-full h-full object-cover" muted playsInline preload="metadata"
                              onMouseEnter={e => { e.currentTarget.play().catch(() => {}); }}
                              onMouseLeave={e => { e.currentTarget.pause(); e.currentTarget.currentTime = 0; }} />
                          )}
                          {/* type badge — AI (kie.ai) / PHOTO (stock still + Ken Burns) / VID (real video) */}
                          <span className={cn("absolute top-0.5 right-0.5 text-[7px] font-bold px-1 py-px rounded uppercase tracking-wide text-white", badge.cls)}>
                            {badge.label}
                          </span>
                          <div className="absolute bottom-0 left-0 right-0 px-1 py-0.5 text-[8px] text-cyan-100 bg-black/60 truncate">
                            {source && <span className="text-amber-200/90 font-semibold">{source}</span>}{source && " · "}{sv.keyword}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-[8px] text-slate-600 mt-1 leading-relaxed">
                    <span className="text-sky-300 font-bold">VID</span> = วิดีโอจริง (hover เล่น) · <span className="text-emerald-300 font-bold">PHOTO</span> = รูปสต็อก (Ken Burns) · <span className="text-fuchsia-300 font-bold">AI</span> = ภาพ AI generate (kie.ai) · <span className="text-amber-200/90 font-semibold">ชื่อแหล่ง</span>แสดงใต้ภาพ
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* B-roll clip count — กี่คลิปย่อยใน 1 วิดีโอ */}
          <div>
            <SectionLabel>B-roll Clips</SectionLabel>
            <div className="flex gap-1.5">
              <button onClick={() => p.setTargetClipCount(0)}
                className={cn("flex-1 py-2 rounded-xl border text-[11px] font-bold transition-all",
                  p.targetClipCount === 0 ? "border-violet-400/50 text-violet-200" : "bg-[#15151b] border-[#26262f] text-slate-500 hover:text-slate-300")}
                style={p.targetClipCount === 0
                  ? { background: "linear-gradient(135deg, rgba(139,92,246,0.20), rgba(99,102,241,0.06))", boxShadow: "0 0 14px rgba(139,92,246,0.15)" }
                  : undefined}>
                Auto
              </button>
              {/* custom stepper − n + (แทน native spinner) */}
              <div className={cn("flex items-center rounded-xl border overflow-hidden transition-all",
                p.targetClipCount > 0 ? "border-violet-400/50" : "border-[#26262f] bg-[#15151b]")}
                style={p.targetClipCount > 0
                  ? { background: "linear-gradient(135deg, rgba(139,92,246,0.20), rgba(99,102,241,0.06))", boxShadow: "0 0 14px rgba(139,92,246,0.15)" }
                  : undefined}>
                <button
                  onClick={() => p.setTargetClipCount(Math.max(0, (p.targetClipCount || 1) - 1))}
                  className="w-7 self-stretch flex items-center justify-center text-slate-500 hover:text-violet-300 hover:bg-white/5 transition-colors text-[13px] font-bold">−</button>
                <input
                  type="text" inputMode="numeric" placeholder="—"
                  value={p.targetClipCount || ""}
                  onChange={e => {
                    const n = parseInt(e.target.value, 10);
                    p.setTargetClipCount(isNaN(n) ? 0 : Math.max(1, Math.min(60, n)));
                  }}
                  className={cn("w-9 bg-transparent text-center text-[12px] font-bold outline-none py-2",
                    p.targetClipCount > 0 ? "text-violet-200" : "text-slate-500 placeholder:text-slate-700")} />
                <button
                  onClick={() => p.setTargetClipCount(Math.min(60, (p.targetClipCount || 0) + 1))}
                  className="w-7 self-stretch flex items-center justify-center text-slate-500 hover:text-violet-300 hover:bg-white/5 transition-colors text-[13px] font-bold">+</button>
              </div>
            </div>
            <p className="text-[9px] text-slate-700 mt-1.5 leading-relaxed">
              Auto = เปลี่ยนคลิปตามซับ (1 คลิป/ซับ) · กำหนดเอง = จำนวนคลิปย่อยใน 1 วิดีโอ แบ่งเวลาเท่าๆ กัน
            </p>
          </div>

          {/* TTS — ซ่อนเมื่อ Direct URL */}
          {p.avatarInputMode !== "direct" ? (
          <div>
            <SectionLabel>Voice</SectionLabel>
            <div className="flex gap-1.5">
              {(["gemini","elevenlabs"] as const).map(pv => (
                <button key={pv} onClick={() => p.setTtsProvider(pv)}
                  className={cn("flex-1 py-2 rounded-xl border text-[11px] font-bold transition-all",
                    p.ttsProvider === pv ? "border-violet-400/50 text-violet-200" : "bg-[#15151b] border-[#26262f] text-slate-500 hover:text-slate-300 hover:border-violet-500/30")}
                  style={p.ttsProvider === pv
                    ? { background: "linear-gradient(135deg, rgba(139,92,246,0.20), rgba(99,102,241,0.06))", boxShadow: "0 0 14px rgba(139,92,246,0.15), inset 0 1px 0 rgba(255,255,255,0.06)" }
                    : undefined}>
                  {pv === "gemini" ? "Gemini" : "ElevenLabs"}
                </button>
              ))}
            </div>
            {p.ttsProvider === "gemini" && (
              <div className="mt-2 space-y-1.5 relative" ref={geminiVoiceRef}>
                <div className="text-[10px] text-slate-600">Gemini Voice</div>
                {(() => {
                  const sel = GEMINI_VOICES.find(x => x.id === p.geminiVoiceName) ?? GEMINI_VOICES[0];
                  const genderChip = (g: string) => g === "Female"
                    ? { label: "หญิง", cls: "bg-pink-500/15 text-pink-300 border-pink-500/30" }
                    : { label: "ชาย", cls: "bg-sky-500/15 text-sky-300 border-sky-500/30" };
                  return (
                    <>
                      {/* ปุ่มเปิด dropdown — แสดงเสียงที่เลือกพร้อม gender chip + style */}
                      <button type="button" onClick={() => setGeminiVoiceOpen(v => !v)}
                        className="w-full rounded-xl px-3 py-2.5 flex items-center gap-2 text-left outline-none transition-colors focus:border-violet-500/40"
                        style={{ background: "#15151b", border: "1px solid #26262f" }}>
                        <span className="text-[12px] font-bold text-slate-100 truncate">{sel.label}</span>
                        <span className={cn("text-[8px] font-bold uppercase tracking-wide rounded px-1.5 py-px border shrink-0", genderChip(sel.gender).cls)}>
                          {genderChip(sel.gender).label}
                        </span>
                        <span className="text-[9px] text-slate-500 truncate">{sel.style}</span>
                        <ChevronDown className={cn("w-3 h-3 text-slate-500 ml-auto shrink-0 transition-transform", geminiVoiceOpen && "rotate-180")} />
                      </button>

                      {geminiVoiceOpen && (
                        <div className="absolute z-30 left-0 right-0 mt-1 rounded-xl shadow-xl overflow-hidden"
                          style={{ background: "hsl(252 30% 8%)", border: "1px solid rgba(139,92,246,0.3)", boxShadow: "0 8px 28px rgba(0,0,0,0.5)" }}>
                          {/* Tab กรองเพศ — segmented control: track เดียว, active = pill มี glow */}
                          <div className="m-1.5 flex gap-0.5 rounded-lg p-0.5 border-b-0"
                            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(139,92,246,0.12)" }}>
                            {([
                              { key: "all" as const,    label: "รวม",  count: GEMINI_VOICES.length,                                  grad: "linear-gradient(135deg,rgba(139,92,246,0.9),rgba(99,102,241,0.75))", glow: "rgba(139,92,246,0.45)", dot: "" },
                              { key: "Female" as const, label: "หญิง", count: GEMINI_VOICES.filter(x => x.gender === "Female").length, grad: "linear-gradient(135deg,rgba(236,72,153,0.9),rgba(219,39,119,0.75))",  glow: "rgba(236,72,153,0.45)", dot: "bg-pink-400" },
                              { key: "Male" as const,   label: "ชาย",  count: GEMINI_VOICES.filter(x => x.gender === "Male").length,   grad: "linear-gradient(135deg,rgba(56,189,248,0.9),rgba(14,165,233,0.75))", glow: "rgba(56,189,248,0.45)", dot: "bg-sky-400" },
                            ]).map(t => {
                              const on = voiceGenderFilter === t.key;
                              return (
                                <button key={t.key} type="button" onClick={() => setVoiceGenderFilter(t.key)}
                                  className={cn("flex-1 py-1.5 rounded-md text-[10px] font-bold transition-all flex items-center justify-center gap-1",
                                    on ? "text-white" : "text-slate-500 hover:text-slate-300")}
                                  style={on ? { background: t.grad, boxShadow: `0 2px 10px ${t.glow}, inset 0 1px 0 rgba(255,255,255,0.15)` } : undefined}>
                                  {t.dot && <span className={cn("w-1.5 h-1.5 rounded-full", on ? "bg-white/80" : t.dot)} />}
                                  <span>{t.label}</span>
                                  <span className={cn("text-[8px] tabular-nums px-1 rounded-full", on ? "bg-white/20 text-white" : "bg-white/5 text-slate-500")}>{t.count}</span>
                                </button>
                              );
                            })}
                          </div>
                          <div className="p-1 max-h-56 overflow-y-auto scrollbar-none">
                          {GEMINI_VOICES.filter(v => voiceGenderFilter === "all" || v.gender === voiceGenderFilter).map(v => {
                            const active = v.id === p.geminiVoiceName;
                            const chip = genderChip(v.gender);
                            return (
                              <button key={v.id} type="button"
                                onClick={() => { p.setGeminiVoiceName(v.id); setGeminiVoiceOpen(false); }}
                                className={cn("w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-colors",
                                  active ? "bg-violet-500/20" : "hover:bg-violet-500/10")}>
                                <span className={cn("text-[12px] font-bold truncate", active ? "text-violet-100" : "text-slate-200")}>{v.label}</span>
                                <span className={cn("text-[8px] font-bold uppercase tracking-wide rounded px-1.5 py-px border shrink-0", chip.cls)}>{chip.label}</span>
                                <span className="text-[9px] text-slate-500 truncate ml-auto">{v.style}</span>
                                {active && <Check className="w-3 h-3 text-violet-300 shrink-0" strokeWidth={3} />}
                              </button>
                            );
                          })}
                          </div>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
            {p.ttsProvider === "elevenlabs" && (
              <div className="mt-2">
                <div className="text-[10px] text-slate-600 mb-1">Voice ID</div>
                <input value={p.voiceId} onChange={e => p.setVoiceId(e.target.value)} placeholder="ElevenLabs Voice ID"
                  className="w-full bg-[#15151b] border border-[#26262f] rounded-xl px-3 py-2.5 text-[11px] font-semibold text-slate-300 placeholder:text-slate-700 outline-none focus:border-violet-500/40 transition-colors" />
              </div>
            )}
            <VoicePreviewButton
              provider={p.ttsProvider}
              geminiVoiceName={p.geminiVoiceName}
              voiceId={p.voiceId}
              onPlanError={p.onPlanError}
            />
          </div>
          ) : (
          <div className="rounded-lg px-3 py-2.5 bg-[#1a1a22] border border-[#2a2a36]">
            <div className="text-[10px] text-slate-600 font-bold uppercase tracking-wider mb-0.5">Voice</div>
            <div className="text-[10px] text-slate-700">ข้าม — เสียงอยู่ใน Direct URL วิดีโอ</div>
          </div>
          )}

          {/* BGM */}
          <div>
            <div className="mb-2">
              <div className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">Background Music</div>
            </div>
            <div className="space-y-3">
              <button type="button" onClick={() => p.setBgmFile("")}
                className={cn("w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11px] transition-all border",
                  !p.bgmFile
                    ? "bg-violet-500/15 border-violet-500/40 text-violet-300"
                    : "bg-[#1a1a22] border-[#2a2a36] text-slate-500 hover:border-[#3a3a4a]")}>
                <span className="shrink-0">🚫</span>
                <span className="truncate">ไม่ใส่เพลง</span>
                {!p.bgmFile && <span className="ml-auto text-violet-400">✓</span>}
              </button>
              {p.bgmFile && (
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-600 w-14 shrink-0">Volume</span>
                  <input type="range" min={0} max={1} step={0.01} value={p.bgmVolume} onChange={e => p.setBgmVolume(Number(e.target.value))} className="flex-1 accent-violet-400 h-1" />
                  <span className="text-[10px] font-mono text-violet-400 w-8 text-right">{Math.round(p.bgmVolume * 100)}%</span>
                </div>
              )}
              {p.systemTracks.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[9px] font-bold uppercase tracking-widest text-slate-700">System Tracks</div>
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {p.systemTracks.map(t => {
                      const selectedUrl = `/music/${t.filename}`;
                      const previewUrl = `/api/music/${t.filename}`;
                      const selected = p.bgmFile === selectedUrl;
                      const previewing = previewingMusicUrl === previewUrl;
                      return (
                        <div key={t.id}
                          className={cn("w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11px] transition-all border",
                            selected ? "bg-violet-500/15 border-violet-500/40 text-violet-300" : "bg-[#1a1a22] border-[#2a2a36] text-slate-500 hover:border-[#3a3a4a]")}>
                          <button type="button" title="เลือกเพลง" onClick={() => p.setBgmFile(selected ? "" : selectedUrl)}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left">
                            <Music className="h-3 w-3 shrink-0" />
                            <span className="truncate">{t.title}</span>
                          </button>
                          {selected && <span className="text-violet-400">✓</span>}
                          <button
                            type="button"
                            onClick={() => { void toggleMusicPreview(previewUrl); }}
                            className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-600 transition-colors hover:bg-violet-500/10 hover:text-violet-300",
                              previewing && "bg-emerald-500/10 text-emerald-300 hover:text-emerald-200")}
                            title={previewing ? "หยุดตัวอย่างเพลง" : "ฟังตัวอย่างเพลง"}
                          >
                            {previewing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {p.userTracks.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[9px] font-bold uppercase tracking-widest text-slate-700">My Uploads</div>
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {p.userTracks.map(t => {
                      const url = `/api/music/${t.filename}`;
                      const previewing = previewingMusicUrl === url;
                      return (
                        <div key={t.id}
                          className={cn("w-full flex items-center gap-1 rounded-lg px-2 py-1.5 text-left text-[11px] transition-all border",
                            p.bgmFile === url ? "bg-violet-500/15 border-violet-500/40 text-violet-300" : "bg-[#1a1a22] border-[#2a2a36] text-slate-500 hover:border-[#3a3a4a]")}>
                          <button type="button" title="เลือกเพลง" onClick={() => p.setBgmFile(p.bgmFile === url ? "" : url)}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left">
                            <Music className="h-3 w-3 shrink-0" />
                            <span className="truncate">{t.title}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => { void toggleMusicPreview(url); }}
                            className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-600 transition-colors hover:bg-violet-500/10 hover:text-violet-300",
                              previewing && "bg-emerald-500/10 text-emerald-300 hover:text-emerald-200")}
                            title={previewing ? "หยุดตัวอย่างเพลง" : "ฟังตัวอย่างเพลง"}
                          >
                            {previewing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => { void deleteUserTrack(t); }}
                            className="rounded p-0.5 text-slate-600 hover:bg-red-500/10 hover:text-red-300"
                            title="ลบเพลง">
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      );
                    })}
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
                        else if (data.url) {
                          if (data.track) p.setUserTracks([data.track, ...p.userTracks]);
                          p.setBgmFile(data.url);
                          toast.success("อัปโหลดสำเร็จ");
                        }
                        else toast.error(data.error ?? "อัปโหลดไม่สำเร็จ");
                      } catch { toast.error("อัปโหลดไม่สำเร็จ"); }
                      finally { p.setBgmUploading(false); e.target.value = ""; }
                    }} />
                  {p.bgmUploading
                    ? <><Loader2 className="h-3.5 w-3.5 animate-spin text-violet-400" /><span className="text-[10px] text-slate-600">กำลังอัปโหลด...</span></>
                    : <><Upload className="h-3.5 w-3.5 text-slate-600" /><span className="text-[10px] text-slate-600">เลือกไฟล์เสียง</span></>}
                </label>
                {p.bgmFile
                  && !p.systemTracks.some(t => `/music/${t.filename}` === p.bgmFile)
                  && !p.userTracks.some(t => `/api/music/${t.filename}` === p.bgmFile)
                  && (
                  <div className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 bg-violet-500/10 border border-violet-500/25">
                    <Music className="h-3 w-3 text-violet-400/60 shrink-0" />
                    <span className="text-[10px] text-violet-300 truncate flex-1">{p.bgmFile.split("/").pop()}</span>
                    <button onClick={() => p.setBgmFile("")} className="text-slate-600 hover:text-slate-400"><X className="h-3 w-3" /></button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Avatar */}
          <div>
            <SectionLabel right={
              <button onClick={() => p.setUseAvatar(!p.useAvatar)}
                className={cn("w-9 h-5 rounded-full transition-colors flex-shrink-0 relative", p.useAvatar ? "bg-violet-600 shadow-[0_0_10px_rgba(139,92,246,0.5)]" : "bg-[#2a2a36]")}>
                <div className={cn("absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all", p.useAvatar ? "left-5" : "left-0.5")} />
              </button>
            }>Avatar (HeyGen)</SectionLabel>
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
                          {/* เลเยอร์ avatar = สูตรเดียวกับ ffmpeg composite: width = scale×เฟรม, center เลื่อน (px/200)×ครึ่งเฟรม */}
                          {p.avatarGreenUrl ? (
                            /* Green = full-frame avatar (gen framing 1.0); the saved scale/offset is
                               calibrated for it, so this preview matches the final render (WYSIWYG). */
                            <div className="absolute pointer-events-none overflow-hidden" style={{ width:`${p.avatarScale*100}%`, aspectRatio:"9/16", left:`${50+(p.avatarOffsetX/200)*50}%`, top:`${50+(p.avatarOffsetY/200)*50}%`, transform:"translate(-50%, -50%)", outline:"1px solid rgba(99,179,237,0.4)" }}>
                              <video src={p.avatarGreenUrl} className="w-full h-full object-cover" style={{ mixBlendMode:"screen", opacity:0.85 }} muted loop autoPlay playsInline />
                            </div>
                          ) : p.avatarPreviewUrl ? (
                            /* Before the first render only HeyGen's headshot thumbnail exists. Its framing
                               differs from the full-frame green video, so applying the green-calibrated scale
                               (e.g. 2.06×) would massively over-zoom the already-tight headshot (reported "zoom"
                               bug). Show it at neutral size — the amber note explains position is set after Render. */
                            <div className="absolute inset-0 pointer-events-none overflow-hidden">
                              <img src={p.avatarPreviewUrl} draggable={false} className="w-full h-full" style={{ objectFit:"cover", objectPosition:"center top", opacity: 0.5 }} />
                            </div>
                          ) : null}
                          <div className="absolute w-2.5 h-2.5 rounded-full border-2 border-cyan-400 bg-cyan-500/50 pointer-events-none" style={{ left:`${50+(p.avatarOffsetX/200)*50}%`, top:`${50+(p.avatarOffsetY/200)*50}%`, transform:"translate(-50%, -50%)" }} />
                          {p.avatarPreviewUrl && !p.avatarGreenUrl && (
                            <div className="absolute bottom-1 left-1 right-1 bg-black/80 text-[7px] text-amber-300/90 px-1.5 py-0.5 rounded text-center pointer-events-none leading-snug">
                              รูปตัวอย่าง · ตำแหน่งจริงปรับได้หลัง Render รอบแรก
                            </div>
                          )}
                        </div>
                        {/* Sliders */}
                        <div className="space-y-2">
                          {([
                            { label:"Offset X", value:p.avatarOffsetX, onChange:p.setAvatarOffsetX, min:-200, max:200, step:1 },
                            { label:"Offset Y", value:p.avatarOffsetY, onChange:p.setAvatarOffsetY, min:-200, max:200, step:1 },
                            { label:"Scale",    value:p.avatarScale,   onChange:p.setAvatarScale,   min:0.1, max:2.5, step:0.01 },
                          ] as const).map(({label,value,onChange,min,max,step})=>(
                            <div key={label} className="space-y-1">
                              <div className="flex justify-between">
                                <span className="text-[9px] font-bold uppercase tracking-widest text-slate-600">{label}</span>
                                <span className="text-[9px] font-mono text-cyan-400">{typeof value === 'number' && Number.isInteger(value) ? value : value.toFixed(2)}</span>
                              </div>
                              <input type="range" min={min} max={max} step={step} value={value} onChange={e=>onChange(Number(e.target.value))} className="w-full accent-cyan-400 h-1" />
                            </div>
                          ))}
                          <div className="flex gap-2">
                            <button onClick={()=>{p.setAvatarOffsetX(0);p.setAvatarOffsetY(0);p.setAvatarScale(1);}} className="text-[9px] text-slate-600 hover:text-slate-400 flex-1 text-center">↺ Reset</button>
                            <button onClick={()=>{ void p.onSaveAvatarLayout(); }} disabled={p.avatarLayoutSaving} className="text-[9px] text-cyan-400 hover:text-cyan-300 disabled:opacity-50 flex-1 text-center">{p.avatarLayoutSaving ? "กำลังบันทึก…" : "💾 Save ตำแหน่ง"}</button>
                            {p.avatarGreenUrl && (
                              <button onClick={() => p.onComposite()} disabled={p.compositing}
                                className="text-[9px] text-cyan-400 hover:text-cyan-300 disabled:opacity-50 flex-1 text-center">
                                {p.compositing ? "กำลังประกอบ…" : "↻ ปรับตำแหน่ง → ประกอบใหม่"}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                    {p.avatarGreenUrl && <div className="text-[10px] text-emerald-400 truncate">✓ {p.avatarGreenUrl.split("/").pop()}</div>}
                  </>
                ) : (
                  <div className="space-y-2">
                    <div className="flex gap-1.5">
                      {([["chromakey","Green Screen (ตัดเขียว)"],["full","วิดีโอเต็มจอ (ใส่ซับ)"]] as const).map(([m, label]) => (
                        <button key={m} onClick={() => p.setDirectCompositeMode(m)}
                          className={`flex-1 py-1.5 rounded-lg border text-[10px] font-bold transition-all ${p.directCompositeMode === m ? "bg-violet-500/15 border-violet-500/45 text-violet-300" : "bg-[#1a1a22] border-[#2a2a36] text-slate-500"}`}>
                          {label}
                        </button>
                      ))}
                    </div>
                    <div className="text-[10px] text-slate-500 bg-violet-500/5 border border-violet-500/15 rounded-lg px-2.5 py-2 leading-relaxed">{p.directCompositeMode === "full" ? "วิดีโอเต็มจอ — ใช้พื้นหลังในคลิป + ใส่ซับ อัตโนมัติหลัง Render" : "วิดีโอ green screen — ตัดเขียววางบน b-roll อัตโนมัติหลัง Render"}</div>
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
