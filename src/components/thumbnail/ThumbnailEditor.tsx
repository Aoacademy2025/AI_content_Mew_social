"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  X, Loader2, Type, Palette, MoveVertical, Bold, Save, Wand2, Sparkles, Download,
} from "lucide-react";
import { toast } from "sonner";

/* ── Font options ── */
const FONT_OPTIONS = [
  { id: "Sarabun", label: "Sarabun", css: "'Sarabun', sans-serif" },
  { id: "Kanit", label: "Kanit", css: "'Kanit', sans-serif" },
  { id: "Prompt", label: "Prompt", css: "'Prompt', sans-serif" },
  { id: "Mitr", label: "Mitr", css: "'Mitr', sans-serif" },
  { id: "Noto Sans Thai", label: "Noto Sans", css: "'Noto Sans Thai', sans-serif" },
  { id: "Arial", label: "Arial", css: "Arial, sans-serif" },
  { id: "Impact", label: "Impact", css: "Impact, sans-serif" },
] as const;

/* ── Style presets ── */
interface StylePreset {
  id: string;
  label: string;
  previewBg: string;
  line1: Partial<TextLayer>;
  line2: Partial<TextLayer>;
}

const STYLE_PRESETS: StylePreset[] = [
  {
    id: "tiktok", label: "TikTok", previewBg: "#111",
    line1: { color: "#FFFFFF", strokeColor: "#000000", strokeWidth: 4, fontWeight: 800, fontFamily: "'Sarabun', sans-serif", fontSize: 68 },
    line2: { color: "#FFE000", strokeColor: "#000000", strokeWidth: 3, fontWeight: 800, fontFamily: "'Sarabun', sans-serif", fontSize: 52 },
  },
  {
    id: "bold", label: "Bold Red", previewBg: "#1a0000",
    line1: { color: "#FF3B3B", strokeColor: "#000000", strokeWidth: 5, fontWeight: 900, fontFamily: "'Kanit', sans-serif", fontSize: 72 },
    line2: { color: "#FFFFFF", strokeColor: "#000000", strokeWidth: 3, fontWeight: 900, fontFamily: "'Kanit', sans-serif", fontSize: 52 },
  },
  {
    id: "neon", label: "Neon", previewBg: "#00050f",
    line1: { color: "#00E5FF", strokeColor: "#001a33", strokeWidth: 3, fontWeight: 700, fontFamily: "'Prompt', sans-serif", fontSize: 64 },
    line2: { color: "#FFFFFF", strokeColor: "#001a33", strokeWidth: 2, fontWeight: 600, fontFamily: "'Prompt', sans-serif", fontSize: 48 },
  },
  {
    id: "fire", label: "Fire", previewBg: "#100500",
    line1: { color: "#FF6B00", strokeColor: "#000000", strokeWidth: 5, fontWeight: 900, fontFamily: "'Kanit', sans-serif", fontSize: 72 },
    line2: { color: "#FFE000", strokeColor: "#000000", strokeWidth: 3, fontWeight: 900, fontFamily: "'Kanit', sans-serif", fontSize: 54 },
  },
  {
    id: "cinema", label: "Cinema", previewBg: "#1a1a2e",
    line1: { color: "#FFFFFF", strokeColor: "#000000", strokeWidth: 2, fontWeight: 500, fontFamily: "'Mitr', sans-serif", fontSize: 58 },
    line2: { color: "#CCCCCC", strokeColor: "#000000", strokeWidth: 2, fontWeight: 400, fontFamily: "'Mitr', sans-serif", fontSize: 44 },
  },
  {
    id: "highlight", label: "Highlight", previewBg: "#111",
    line1: { color: "#000000", strokeColor: "#FFE000", strokeWidth: 6, fontWeight: 800, fontFamily: "'Sarabun', sans-serif", fontSize: 66 },
    line2: { color: "#FFFFFF", strokeColor: "#000000", strokeWidth: 3, fontWeight: 800, fontFamily: "'Sarabun', sans-serif", fontSize: 50 },
  },
  {
    id: "pink", label: "Pink Glow", previewBg: "#0a0010",
    line1: { color: "#FF2D9C", strokeColor: "#1a0020", strokeWidth: 3, fontWeight: 700, fontFamily: "'Prompt', sans-serif", fontSize: 64 },
    line2: { color: "#FFFFFF", strokeColor: "#1a0020", strokeWidth: 2, fontWeight: 600, fontFamily: "'Prompt', sans-serif", fontSize: 48 },
  },
  {
    id: "blue", label: "Blue", previewBg: "#0a1929",
    line1: { color: "#FFFFFF", strokeColor: "#2979FF", strokeWidth: 6, fontWeight: 800, fontFamily: "'Sarabun', sans-serif", fontSize: 66 },
    line2: { color: "#2979FF", strokeColor: "#000000", strokeWidth: 3, fontWeight: 800, fontFamily: "'Sarabun', sans-serif", fontSize: 50 },
  },
];

/* ── Types ── */
interface TextLayer {
  text: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  yPercent: number;
  fontFamily: string;
}

interface ThumbnailEditorProps {
  videoId: string;
  videoUrl: string;        // final video (with subtitles) — NOT used for frame capture
  bgVideoUrl?: string;     // Remotion bg video (no subtitles) — used for frame capture
  script?: string | null;
  onSave: (thumbnailUrl: string) => void;
  onClose: () => void;
}

const COLOR_PRESETS = [
  "#FFFFFF", "#FFE000", "#FF3B3B", "#00E5FF", "#FF6B00",
  "#FF2D9C", "#2979FF", "#00FF88", "#FFD700", "#000000",
];

const DEFAULT_LAYER: TextLayer = {
  text: "",
  fontSize: 64,
  fontWeight: 800,
  color: "#FFFFFF",
  strokeColor: "#000000",
  strokeWidth: 4,
  yPercent: 70,
  fontFamily: "'Sarabun', sans-serif",
};

/* ── Google Fonts URL ── */
const FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Sarabun:wght@400;500;700;800&family=Kanit:wght@700;900&family=Prompt:wght@600;700&family=Mitr:wght@400;500;600&family=Noto+Sans+Thai:wght@400;600;700;800&display=swap";

export default function ThumbnailEditor({
  videoId, videoUrl, bgVideoUrl, script, onSave, onClose,
}: ThumbnailEditorProps) {
  // Use bgVideoUrl (no subtitles) for frame capture if available, fallback to videoUrl
  const frameSource = bgVideoUrl || videoUrl;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [layers, setLayers] = useState<TextLayer[]>([
    { ...DEFAULT_LAYER, text: "", yPercent: 65 },
    { ...DEFAULT_LAYER, text: "", fontSize: 52, color: "#FFE000", yPercent: 78 },
  ]);
  const [activeLayer, setActiveLayer] = useState(0);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [seekTime, setSeekTime] = useState(3);
  const [configLoaded, setConfigLoaded] = useState(false);

  // Load saved thumbnail config from DB
  useEffect(() => {
    if (configLoaded) return;
    fetch("/api/videos/thumbnail", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId, mode: "load" }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.config) {
          if (Array.isArray(data.config.textLayers) && data.config.textLayers.length > 0) {
            setLayers(data.config.textLayers.map((l: Partial<TextLayer>) => ({ ...DEFAULT_LAYER, ...l })));
          }
          if (typeof data.config.seekTime === "number") {
            setSeekTime(data.config.seekTime);
          }
        }
      })
      .catch(() => {})
      .finally(() => setConfigLoaded(true));
  }, [videoId, configLoaded]);

  // Load Google Fonts
  useEffect(() => {
    if (!document.querySelector(`link[href*="Sarabun"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = FONTS_URL;
      document.head.appendChild(link);
    }
  }, []);

  // Load video once
  useEffect(() => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = frameSource;

    video.onseeked = () => {
      const c = canvasRef.current;
      if (c) {
        c.width = video.videoWidth || 1080;
        c.height = video.videoHeight || 1920;
      }
      setFrameLoaded(true);
    };

    video.onloadeddata = () => {
      videoRef.current = video;
      video.currentTime = Math.min(seekTime, Math.max(0, video.duration - 0.1));
    };

    video.onerror = () => {
      console.error("[ThumbnailEditor] video load error:", videoUrl);
      toast.error("ไม่สามารถโหลด video ได้");
    };

    return () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [frameSource]); // eslint-disable-line react-hooks/exhaustive-deps

  // Seek when seekTime changes
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !video.duration) return;
    setFrameLoaded(false);
    video.currentTime = Math.min(seekTime, Math.max(0, video.duration - 0.1));
  }, [seekTime]);

  // Draw canvas
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || !frameLoaded) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    ctx.drawImage(video, 0, 0, w, h);

    // Gradient overlay
    const grad = ctx.createLinearGradient(0, h * 0.45, 0, h);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, "rgba(0,0,0,0.7)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, h * 0.45, w, h * 0.55);

    // Text layers
    for (const layer of layers) {
      if (!layer.text.trim()) continue;

      const font = layer.fontFamily || "'Sarabun', sans-serif";
      ctx.font = `${layer.fontWeight} ${layer.fontSize}px ${font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const x = w / 2;
      const y = (layer.yPercent / 100) * h;

      if (layer.strokeWidth > 0) {
        ctx.strokeStyle = layer.strokeColor;
        ctx.lineWidth = layer.strokeWidth * 2;
        ctx.lineJoin = "round";
        ctx.strokeText(layer.text, x, y);
      }

      ctx.fillStyle = layer.color;
      ctx.fillText(layer.text, x, y);
    }
  }, [layers, frameLoaded]);

  useEffect(() => { drawCanvas(); }, [drawCanvas]);

  function updateLayer(index: number, patch: Partial<TextLayer>) {
    setLayers(prev => prev.map((l, i) => i === index ? { ...l, ...patch } : l));
  }

  function addLayer() {
    if (layers.length >= 4) return toast.error("สูงสุด 4 บรรทัด");
    setLayers(prev => [...prev, { ...DEFAULT_LAYER, yPercent: 85 }]);
    setActiveLayer(layers.length);
  }

  function removeLayer(index: number) {
    if (layers.length <= 1) return;
    setLayers(prev => prev.filter((_, i) => i !== index));
    setActiveLayer(Math.max(0, activeLayer - 1));
  }

  // Apply style preset
  function applyPreset(preset: StylePreset) {
    setActivePreset(preset.id);
    setLayers(prev => prev.map((l, i) => {
      const style = i === 0 ? preset.line1 : preset.line2;
      return { ...l, ...style };
    }));
  }

  // AI suggest
  async function handleAiSuggest() {
    if (!script) return toast.error("ไม่มี script สำหรับสร้างข้อความ");
    setAiLoading(true);
    try {
      const res = await fetch("/api/videos/thumbnail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId, videoUrl, mode: "suggest" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // Apply suggested text
      if (data.line) updateLayer(0, { text: data.line });
      if (data.line2) {
        if (layers.length >= 2) updateLayer(1, { text: data.line2 });
        else setLayers(prev => [...prev, { ...DEFAULT_LAYER, text: data.line2, fontSize: 52, color: "#FFE000", yPercent: 78 }]);
      }

      // Apply suggested colors
      if (data.line1Color) updateLayer(0, { color: data.line1Color });
      if (data.line2Color && layers.length >= 2) updateLayer(1, { color: data.line2Color });

      // Apply suggested style preset
      if (data.style) {
        const preset = STYLE_PRESETS.find(p => p.id === data.style);
        if (preset) {
          setActivePreset(preset.id);
          // Apply preset styles but keep the AI text
          setLayers(prev => prev.map((l, i) => {
            const style = i === 0 ? preset.line1 : preset.line2;
            return { ...l, ...style };
          }));
        }
      }

      toast.success("AI สร้างข้อความปังแล้ว!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "AI suggest ล้มเหลว");
    } finally {
      setAiLoading(false);
    }
  }

  // Download PNG directly to browser
  function handleDownload() {
    const canvas = canvasRef.current;
    if (!canvas) return toast.error("Canvas not ready");
    drawCanvas();
    const link = document.createElement("a");
    link.download = `thumbnail-${Date.now()}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  }

  // Save — export canvas as JPEG blob and upload to server
  async function handleSave() {
    const canvas = canvasRef.current;
    if (!canvas) return toast.error("Canvas not ready");

    setSaving(true);
    try {
      // Re-draw at full resolution to ensure latest state
      drawCanvas();

      // Export canvas to blob
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          b => (b ? resolve(b) : reject(new Error("Canvas export failed"))),
          "image/jpeg",
          0.92,
        );
      });

      // Upload blob + config
      const formData = new FormData();
      formData.append("image", blob, "thumbnail.jpg");
      formData.append("videoId", videoId);
      formData.append("thumbnailConfig", JSON.stringify({ seekTime, textLayers: layers.filter(l => l.text.trim()) }));

      const res = await fetch("/api/videos/thumbnail/upload", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onSave(data.thumbnailUrl);
      toast.success("Thumbnail บันทึกแล้ว");
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  const current = layers[activeLayer];

  return (
    <div className="fixed inset-0 z-50 flex bg-black/90 backdrop-blur-sm" onClick={onClose}>
      <div className="flex w-full h-full" onClick={e => e.stopPropagation()}>

        {/* Left: Canvas Preview */}
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="relative" style={{ height: "90vh", aspectRatio: "9/16" }}>
            <canvas
              ref={canvasRef}
              className="h-full w-full rounded-2xl object-contain"
              style={{ background: "#000" }}
            />
            {!frameLoaded && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-cyan-400/50" />
              </div>
            )}
          </div>
        </div>

        {/* Right: Controls */}
        <div
          className="w-100 shrink-0 overflow-y-auto p-5 flex flex-col gap-4"
          style={{ background: "hsl(221 39% 8%)", borderLeft: "1px solid hsl(220 30% 16%)" }}
        >
          {/* Header */}
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-white">Thumbnail Editor</h2>
            <button onClick={onClose} className="text-white/40 hover:text-white/80 transition-colors">
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Frame seek */}
          <div>
            <label className="text-[10px] font-bold uppercase tracking-widest text-white/30 mb-1 block">
              Frame Position
            </label>
            <div className="flex items-center gap-2">
              <input
                type="range" min={0} max={30} step={0.5} value={seekTime}
                onChange={e => setSeekTime(Number(e.target.value))}
                className="flex-1 accent-cyan-500"
              />
              <span className="text-xs text-white/40 w-10 text-right">{seekTime.toFixed(1)}s</span>
            </div>
          </div>

          {/* AI Suggest */}
          {script && (
            <button
              onClick={handleAiSuggest}
              disabled={aiLoading}
              className="group flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold transition-all disabled:opacity-50 hover:scale-[1.02]"
              style={{
                background: "linear-gradient(135deg, hsl(271 91% 55%), hsl(190 100% 45%))",
                color: "#fff",
                boxShadow: "0 0 20px hsl(271 91% 55% / 0.3)",
              }}
            >
              {aiLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              AI suggest
            </button>
          )}

          {/* ── Style Presets ── */}
          <div>
            <label className="text-[10px] font-bold uppercase tracking-widest text-white/30 mb-2 block">
              Style Presets
            </label>
            <div className="grid grid-cols-4 gap-1.5">
              {STYLE_PRESETS.map(preset => (
                <button
                  key={preset.id}
                  onClick={() => applyPreset(preset)}
                  className={`flex flex-col items-center gap-1 rounded-xl px-2 py-2 text-[10px] font-medium transition-all hover:scale-105 ${
                    activePreset === preset.id ? "ring-2 ring-cyan-400" : ""
                  }`}
                  style={{
                    background: preset.previewBg,
                    border: "1px solid hsl(220 30% 22%)",
                  }}
                >
                  <span
                    className="text-xs font-black leading-none"
                    style={{ color: (preset.line1.color as string) ?? "#fff" }}
                  >
                    Aa
                  </span>
                  <span className="text-white/50">{preset.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* ── Layer tabs ── */}
          <div>
            <label className="text-[10px] font-bold uppercase tracking-widest text-white/30 mb-2 block">
              Text Layers
            </label>
            <div className="flex gap-1 flex-wrap">
              {layers.map((l, i) => (
                <button
                  key={i}
                  onClick={() => setActiveLayer(i)}
                  className={`relative rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                    activeLayer === i ? "text-cyan-400" : "text-white/40 hover:text-white/70"
                  }`}
                  style={{
                    background: activeLayer === i ? "hsl(190 100% 50% / 0.12)" : "hsl(220 30% 14%)",
                    border: activeLayer === i ? "1px solid hsl(190 100% 50% / 0.3)" : "1px solid hsl(220 30% 20%)",
                  }}
                >
                  {l.text.slice(0, 8) || `Line ${i + 1}`}
                  {layers.length > 1 && (
                    <span
                      onClick={e => { e.stopPropagation(); removeLayer(i); }}
                      className="ml-1.5 text-white/20 hover:text-red-400 transition-colors"
                    >
                      ×
                    </span>
                  )}
                </button>
              ))}
              {layers.length < 4 && (
                <button
                  onClick={addLayer}
                  className="rounded-lg px-3 py-1.5 text-xs text-white/30 hover:text-white/60 transition-colors"
                  style={{ background: "hsl(220 30% 14%)", border: "1px dashed hsl(220 30% 25%)" }}
                >
                  + เพิ่ม
                </button>
              )}
            </div>
          </div>

          {/* ── Active layer controls ── */}
          {current && (
            <div className="space-y-3">
              {/* Text input */}
              <div>
                <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-white/30 mb-1">
                  <Type className="h-3 w-3" /> ข้อความ
                </label>
                <input
                  type="text"
                  value={current.text}
                  onChange={e => updateLayer(activeLayer, { text: e.target.value })}
                  placeholder="พิมพ์ข้อความ..."
                  className="w-full rounded-xl px-3 py-2.5 text-sm text-white placeholder-white/20 outline-none focus:ring-1 focus:ring-cyan-500/50"
                  style={{ background: "hsl(220 30% 12%)", border: "1px solid hsl(220 30% 20%)" }}
                />
              </div>

              {/* Font family */}
              <div>
                <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-white/30 mb-1">
                  <Type className="h-3 w-3" /> ฟอนต์
                </label>
                <div className="flex gap-1 flex-wrap">
                  {FONT_OPTIONS.map(f => (
                    <button
                      key={f.id}
                      onClick={() => updateLayer(activeLayer, { fontFamily: f.css })}
                      className={`rounded-lg px-2.5 py-1.5 text-xs transition-all ${
                        current.fontFamily === f.css
                          ? "text-cyan-400 ring-1 ring-cyan-400/50"
                          : "text-white/40 hover:text-white/70"
                      }`}
                      style={{
                        background: current.fontFamily === f.css ? "hsl(190 100% 50% / 0.1)" : "hsl(220 30% 14%)",
                        border: "1px solid hsl(220 30% 20%)",
                        fontFamily: f.css,
                      }}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Font size + weight row */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-white/30 mb-1">
                    <Type className="h-3 w-3" /> ขนาด: {current.fontSize}
                  </label>
                  <input
                    type="range" min={24} max={120} value={current.fontSize}
                    onChange={e => updateLayer(activeLayer, { fontSize: Number(e.target.value) })}
                    className="w-full accent-cyan-500"
                  />
                </div>
                <div>
                  <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-white/30 mb-1">
                    <Bold className="h-3 w-3" /> หนา: {current.fontWeight}
                  </label>
                  <input
                    type="range" min={300} max={900} step={100} value={current.fontWeight}
                    onChange={e => updateLayer(activeLayer, { fontWeight: Number(e.target.value) })}
                    className="w-full accent-cyan-500"
                  />
                </div>
              </div>

              {/* Position Y */}
              <div>
                <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-white/30 mb-1">
                  <MoveVertical className="h-3 w-3" /> ตำแหน่ง Y: {current.yPercent}%
                </label>
                <input
                  type="range" min={5} max={95} value={current.yPercent}
                  onChange={e => updateLayer(activeLayer, { yPercent: Number(e.target.value) })}
                  className="w-full accent-cyan-500"
                />
              </div>

              {/* Text color */}
              <div>
                <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-white/30 mb-1">
                  <Palette className="h-3 w-3" /> สีตัวอักษร
                </label>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {COLOR_PRESETS.map(c => (
                    <button
                      key={c}
                      onClick={() => updateLayer(activeLayer, { color: c })}
                      className={`h-6 w-6 rounded-full border-2 transition-all ${
                        current.color === c ? "border-cyan-400 scale-110" : "border-white/10"
                      }`}
                      style={{ background: c }}
                    />
                  ))}
                  <input
                    type="color"
                    value={current.color}
                    onChange={e => updateLayer(activeLayer, { color: e.target.value })}
                    className="h-6 w-6 rounded-full cursor-pointer border-none bg-transparent"
                  />
                </div>
              </div>

              {/* Stroke */}
              <div>
                <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-white/30 mb-1">
                  <Palette className="h-3 w-3" /> ขอบตัวอักษร
                </label>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1">
                    {["#000000", "#FFFFFF", "#FF0000", "#2979FF", "#FFE000"].map(c => (
                      <button
                        key={c}
                        onClick={() => updateLayer(activeLayer, { strokeColor: c })}
                        className={`h-5 w-5 rounded-full border-2 transition-all ${
                          current.strokeColor === c ? "border-cyan-400 scale-110" : "border-white/10"
                        }`}
                        style={{ background: c }}
                      />
                    ))}
                  </div>
                  <input
                    type="range" min={0} max={10} value={current.strokeWidth}
                    onChange={e => updateLayer(activeLayer, { strokeWidth: Number(e.target.value) })}
                    className="flex-1 accent-cyan-500"
                  />
                  <span className="text-xs text-white/40 w-5 text-right">{current.strokeWidth}</span>
                </div>
              </div>
            </div>
          )}

          {/* Save + Download */}
          <div className="mt-auto flex gap-2">
            <button
              onClick={handleDownload}
              disabled={!frameLoaded}
              className="flex items-center justify-center gap-2 rounded-xl px-3 py-3 text-sm font-bold transition-all disabled:opacity-50 hover:scale-[1.02]"
              style={{ background: "hsl(220 30% 16%)", color: "#fff", border: "1px solid hsl(220 30% 25%)" }}
              title="Download PNG"
            >
              <Download className="h-4 w-4" />
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !frameLoaded}
              className="flex-1 flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold transition-all disabled:opacity-50 hover:scale-[1.02]"
              style={{ background: "hsl(190 100% 50%)", color: "#000" }}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              บันทึก Thumbnail
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
