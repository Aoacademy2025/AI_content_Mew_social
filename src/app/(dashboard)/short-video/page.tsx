"use client";

import React, { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Mic, Captions, Film, Settings2, Video, Download,
  CheckCircle2, Loader2, Wand2, Play, RefreshCw, FileText, RotateCcw, User, Layers, ChevronDown, Square,
} from "lucide-react";
import { GEMINI_VOICES } from "@/lib/gemini-voices";
import { ApiKeyModal, detectMissingKeyType, type RequiredKeyType } from "@/components/ui/api-key-modal";

type StepStatus = "idle" | "running" | "done" | "error" | "skip";

interface StepState {
  keywords: StepStatus;
  fetchStock: StepStatus;
  tts: StepStatus;
  transcribe: StepStatus;
  config: StepStatus;
  render: StepStatus;
  avatar: StepStatus;
  composite: StepStatus;
}

interface Caption { text: string; startMs: number; endMs: number; tag?: "hook" | "body" | "cta"; }

interface StockVideo { keyword: string; localUrl?: string; videoUrl: string; duration: number; pexelsId: number; }


const DEFAULT_STEPS: StepState = {
  keywords: "idle", fetchStock: "idle", tts: "idle",
  transcribe: "idle", config: "idle", render: "idle", avatar: "idle", composite: "idle",
};

// Intermediate data stored between steps
interface PipelineData {
  scenes: string[];
  keywords: string[];
  keywordsPerScene: number;
  sceneClipCounts: number[];  // how many clips each scene needs
  sceneDurations: number[];   // estimated duration per scene (seconds)
  stockVideos: StockVideo[];
  voiceUrl: string;
  captions: Caption[];
  sceneCaptions: Caption[];
  words: { word: string; startMs: number; endMs: number }[];
  audioDurationMs: number;
  config: unknown;
  renderedVideoUrl: string;
  compositeUrl: string;
}

type SubPreset = "stroke" | "box" | "box-rounded" | "glow" | "outline-only" | "plain" | "shadow" | "karaoke";

/** Shared subtitle renderer — used by mini preview, CSS overlay, and modal */
function renderSubEl(
  text: string,
  color: string,
  accentColor: string,
  isAccent: boolean,
  preset: SubPreset,
  fontFamily: string,
  fontSizePx: number,
  fontWeight: number,
  scale = 1,  // containerWidth / 1080, use 1 for real px
): React.ReactNode {
  const c = isAccent ? accentColor : color;
  const fs = Math.round(fontSizePx * scale);
  const fw = fontWeight;
  const sw = Math.max(0.5, 2 * scale); // stroke width

  const base: React.CSSProperties = {
    fontFamily, fontSize: fs, fontWeight: fw, color: c,
    lineHeight: 1.3, wordBreak: "keep-all", letterSpacing: "0.01em",
    display: "inline-block", textAlign: "center",
  };

  if (preset === "plain") {
    return <span style={base}>{text}</span>;
  }
  if (preset === "shadow") {
    const d = Math.round(4 * scale), bl = Math.round(16 * scale);
    return <span style={{ ...base, textShadow: `0 ${d}px ${bl}px rgba(0,0,0,1), 0 2px 4px rgba(0,0,0,0.9)` }}>{text}</span>;
  }
  if (preset === "box") {
    const py = Math.round(6 * scale), px = Math.round(20 * scale), pb = Math.round(8 * scale);
    return <div style={{ background: "rgba(0,0,0,0.65)", padding: `${py}px ${px}px ${pb}px`, display: "inline-block" }}><span style={base}>{text}</span></div>;
  }
  if (preset === "box-rounded") {
    const py = Math.round(8 * scale), px = Math.round(24 * scale), pb = Math.round(10 * scale), br = Math.round(16 * scale);
    return <div style={{ background: "rgba(0,0,0,0.72)", padding: `${py}px ${px}px ${pb}px`, borderRadius: br, display: "inline-block" }}><span style={base}>{text}</span></div>;
  }
  if (preset === "glow") {
    const r = parseInt(c.slice(1,3)||"ff",16), g = parseInt(c.slice(3,5)||"ff",16), b = parseInt(c.slice(5,7)||"ff",16);
    const g1=Math.round(20*scale), g2=Math.round(40*scale), g3=Math.round(60*scale);
    return <span style={{ ...base, textShadow: `0 0 ${g1}px rgba(${r},${g},${b},0.9), 0 0 ${g2}px rgba(${r},${g},${b},0.6), 0 0 ${g3}px rgba(${r},${g},${b},0.4), 0 2px 4px rgba(0,0,0,0.8)` }}>{text}</span>;
  }
  if (preset === "outline-only") {
    return <span style={{ ...base, color: "#fff", WebkitTextStroke: `${sw * 1.5}px ${c}` } as React.CSSProperties}>{text}</span>;
  }
  if (preset === "karaoke") {
    // Bottom-bar style: text on semi-transparent bottom strip
    const py = Math.round(4 * scale), px = Math.round(12 * scale);
    return <div style={{ background: "rgba(0,0,0,0.75)", padding: `${py}px ${px}px`, display: "inline-block", borderTop: `${Math.max(1, Math.round(2*scale))}px solid ${c}` }}><span style={base}>{text}</span></div>;
  }
  // stroke (default)
  const s1=Math.round(3*scale), s2=Math.round(20*scale), s3=Math.round(32*scale);
  return <span style={{ ...base, textShadow: `0 ${s1}px 0 #000, 0 -1px 0 #000, 1px 0 0 #000, -1px 0 0 #000, 0 4px ${s2}px rgba(0,0,0,0.95), 0 8px ${s3}px rgba(0,0,0,0.8)`, WebkitTextStroke: `${sw}px #000` } as React.CSSProperties}>{text}</span>;
}

export default function ShortVideoPage() {
  const router = useRouter();
  const [plan, setPlan] = useState<"LOADING" | "PRO" | "FREE">("LOADING");

  useEffect(() => {
    fetch("/api/user/stats").then(r => r.json()).then(d => {
      const p = d.plan === "PRO" ? "PRO" : "FREE";
      setPlan(p);
      if (p !== "PRO") {
        toast.error("Avatar Cloning สำหรับผู้ใช้งานระดับ Pro เท่านั้น");
        router.replace("/dashboard");
      }
    }).catch(() => { router.replace("/dashboard"); });
  }, [router]);

  const [script, setScript] = useState("");

  function preprocessScript(raw: string): string {
    return raw
      .replace(/\r?\n/g, " ")
      .replace(/\([A-Za-z][^)]{0,80}\)/g, "")
      .replace(/\.{3,}/g, "\n")
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .join("\n")
      .trim();
  }

  const cleanScript = preprocessScript(script);
  const [voiceId, setVoiceId] = useState("");
  const [ttsProvider, setTtsProvider] = useState<"elevenlabs" | "gemini">("elevenlabs");
  const [geminiVoiceName, setGeminiVoiceName] = useState("Aoede");
  const [running, setRunning] = useState(false);
  const abortRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [steps, setSteps] = useState<StepState>({ ...DEFAULT_STEPS });
  const stepsRef = useRef<StepState>({ ...DEFAULT_STEPS });
  const [logs, setLogs] = useState<Partial<Record<keyof StepState, string>>>({});
  const [videoUrl, setVideoUrl] = useState("");
  const [preRenderUrl, setPreRenderUrl] = useState("");
  const [compositePreviewUrl, setCompositePreviewUrl] = useState("");
  const [avatarGreenUrl, setAvatarGreenUrl] = useState("");
  const [showGreenRef, setShowGreenRef] = useState(false);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [, setScenes] = useState<string[]>([]);
  const [ttsUrl, setTtsUrl] = useState("");
  const [voicePreviewLoading, setVoicePreviewLoading] = useState(false);
  const [scriptSaving, setScriptSaving] = useState(false);
  const [pipeStockVideos, setPipeStockVideos] = useState<StockVideo[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const [avatarId, setAvatarId] = useState("");
  const [avatarScale, setAvatarScale] = useState(2.02);
  const [avatarOffsetX, setAvatarOffsetX] = useState(0.0);
  const [avatarOffsetY, setAvatarOffsetY] = useState(0.13);
  const [useAvatar, setUseAvatar] = useState(true);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState("");
  const [avatarName, setAvatarName] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const posCanvasRef = useRef<HTMLDivElement>(null);
  const [avatarTiming, setAvatarTiming] = useState<"full" | "bookend">("full");
  const [avatarBookendSecs, setAvatarBookendSecs] = useState(5);
  const [avatarInputMode, setAvatarInputMode] = useState<"generate" | "direct">("generate");
  const [avatarDirectUrl, setAvatarDirectUrl] = useState("");
  // Direct URL workflow states
  const [directCompositeUrl, setDirectCompositeUrl] = useState(""); // final composite
  const [testRemoveUrl, setTestRemoveUrl] = useState("");
  const [testRemoveLoading, setTestRemoveLoading] = useState(false);
  // Scene captions — shown after transcribe for user review/edit before render
  const [editedSceneCaptions, setEditedSceneCaptions] = useState<Caption[]>([]);
  // Stock clip count override (0 = auto based on script length)
  const [targetClipCount, setTargetClipCount] = useState(0);
  // Auto clip count returned by the last fetch (so UI can show "Auto (12)")
  const [autoClipCount, setAutoClipCount] = useState(0);
  // Stock source selection
  const [stockSource, setStockSource] = useState<"pexels" | "pixabay" | "both">("both");
  // Clips excluded by user (pexelsId set)
  const [excludedClipIds, setExcludedClipIds] = useState<Set<number>>(new Set());

  // Subtitle style settings
  const [subFontFamily, setSubFontFamily] = useState("'Kanit', sans-serif");
  const [subFontSize, setSubFontSize] = useState(80);
  const [subPosition, setSubPosition] = useState(75);
  const [subColor, setSubColor] = useState("#FFFFFF");
  const [subAccentColor, setSubAccentColor] = useState("#FFE500");
  const [subStylePreset, setSubStylePreset] = useState<"stroke"|"box"|"box-rounded"|"glow"|"outline-only"|"plain"|"shadow"|"karaoke">("stroke");
  const [subFontWeight, setSubFontWeight] = useState(900);
  // Composite mode + chroma key tuning (per-avatar)
  const [compositeMode, setCompositeMode] = useState<"chromakey" | "rembg">("chromakey");
  const [chromaColor] = useState("#00FF00");
  const [chromaSimilarity, setChromaSimilarity] = useState(0.28);
  const [chromaBlend, setChromaBlend] = useState(0.04);
  const [rembgModel, setRembgModel] = useState<"u2net" | "isnet-general-use" | "silueta">("u2net");
  const [activeCaptionIdx, setActiveCaptionIdx] = useState(-1);
  const [stockCacheInfo, setStockCacheInfo] = useState<{ count: number; sizeMb: number } | null>(null);
  const [clearingCache, setClearingCache] = useState(false);

  // Missing API key modal
  const [missingKey, setMissingKey] = useState<{ type: RequiredKeyType; retryStep: keyof StepState | "runAll" | "runGenerate" | "runAvatarPipeline" } | null>(null);
  // LLM provider picker — shown when no key is set at all before runAll
  const [showLLMPicker, setShowLLMPicker] = useState(false);
  const [showClearCacheDialog, setShowClearCacheDialog] = useState(false);

  // Stored pipeline data for partial re-runs
  const pipe = useRef<Partial<PipelineData>>({});

  // Keep a stable ref to rerunFrom so the debounce closure always calls the latest version
  const rerunFromRef = useRef<(step: keyof StepState) => Promise<void>>(async () => {});
  const runningRef = useRef(false);

  useEffect(() => {
    // Load stock cache info
    fetch("/api/stocks").then(r => r.json()).then(d => {
      if (d.count !== undefined) setStockCacheInfo(d);
    }).catch(() => {});
    // Load saved Avatar ID and Voice ID for this user
    fetch("/api/user/video-settings").then(r => r.json()).then(d => {
      if (d.heygenAvatarId) setAvatarId(d.heygenAvatarId);
      if (d.elevenlabsVoiceId) setVoiceId(d.elevenlabsVoiceId);
      if (d.ttsProvider === "gemini" || d.ttsProvider === "elevenlabs") setTtsProvider(d.ttsProvider);
      if (d.geminiVoiceName) setGeminiVoiceName(d.geminiVoiceName);
    }).catch(() => {});
  }, []);

  // Auto-save Avatar ID when user changes it (debounced 800ms)
  const saveAvatarIdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function handleSetAvatarId(val: string) {
    setAvatarId(val);
    if (saveAvatarIdTimer.current) clearTimeout(saveAvatarIdTimer.current);
    saveAvatarIdTimer.current = setTimeout(() => {
      fetch("/api/user/video-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ heygenAvatarId: val }),
      }).catch(() => {});
    }, 800);
  }

  // Auto-save Voice ID when user changes it (debounced 800ms)
  const saveVoiceIdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function handleSetVoiceId(val: string) {
    setVoiceId(val);
    if (saveVoiceIdTimer.current) clearTimeout(saveVoiceIdTimer.current);
    saveVoiceIdTimer.current = setTimeout(() => {
      fetch("/api/user/video-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ elevenlabsVoiceId: val }),
      }).catch(() => {});
    }, 800);
  }

  // Immediately save ttsProvider when toggled
  function handleSetTtsProvider(val: "elevenlabs" | "gemini") {
    setTtsProvider(val);
    fetch("/api/user/video-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ttsProvider: val }),
    }).catch(() => {});
  }

  // Immediately save geminiVoiceName when changed
  function handleSetGeminiVoiceName(val: string) {
    setGeminiVoiceName(val);
    fetch("/api/user/video-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ geminiVoiceName: val }),
    }).catch(() => {});
  }

  async function clearStockCache() {
    setClearingCache(true);
    try {
      const res = await fetch("/api/stocks", { method: "DELETE" });
      const d = await res.json();
      toast.success(`ลบ stock cache สำเร็จ ${d.deleted} ไฟล์ (${d.sizeMb} MB)`);
      setStockCacheInfo({ count: 0, sizeMb: 0 });
    } catch {
      toast.error("ไม่สามารถลบ cache ได้ กรุณาลองใหม่อีกครั้ง");
    } finally {
      setClearingCache(false);
    }
  }


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

  // Track current subtitle for caption list highlight
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      const ms = video.currentTime * 1000;
      setActiveCaptionIdx(editedSceneCaptions.findIndex(c => ms >= c.startMs && ms <= c.endMs));
    };
    video.addEventListener("timeupdate", onTime);
    return () => video.removeEventListener("timeupdate", onTime);
  }, [editedSceneCaptions]);

  function updatePosFromPointer(clientX: number, clientY: number) {
    const el = posCanvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // X: -1 (left) to 1 (right)
    const nx = ((clientX - rect.left) / rect.width - 0.5) * 2;
    // Y: bottom-center reference — clicking canvas bottom = Y 0.28 (default)
    const mouseYRatio = (clientY - rect.top) / rect.height;
    const ny = 0.28 - (1 - mouseYRatio) * 2;
    setAvatarOffsetX(Math.round(Math.max(-1, Math.min(1, nx)) * 100) / 100);
    setAvatarOffsetY(Math.round(Math.max(-1, Math.min(1, ny)) * 100) / 100);
  }

  async function saveScript() {
    if (!script.trim()) return;
    setScriptSaving(true);
    try {
      const res = await fetch("/api/contents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: script, headline: script.split("\n")[0].slice(0, 80) }),
      });
      if (res.ok) {
        toast.success("บันทึก Script แล้ว");
      } else {
        const d = await res.json();
        toast.error(d.error ?? "บันทึกไม่สำเร็จ");
      }
    } catch {
      toast.error("บันทึกไม่สำเร็จ");
    } finally {
      setScriptSaving(false);
    }
  }

  /** Custom error that carries the parsed API response body */
  class ApiCallError extends Error {
    data: Record<string, unknown>;
    constructor(prefix: string, data: Record<string, unknown>) {
      // Include `detail` from server if present so friendlyError can show it
      const detail = data.detail ? ` — ${String(data.detail).slice(0, 200)}` : "";
      super(`${prefix}: ${data.error ?? "Unknown error"}${detail}`);
      this.data = data;
    }
  }

  /** Throw ApiCallError if response is not ok — preserves missingKey and other fields */
  function assertOk(prefix: string, res: Response, data: Record<string, unknown>) {
    if (!res.ok) throw new ApiCallError(prefix, data);
  }

  function setStep(key: keyof StepState, status: StepStatus, log?: string) {
    setSteps(s => {
      const next = { ...s, [key]: status };
      stepsRef.current = next;
      return next;
    });
    if (log) setLogs(l => ({ ...l, [key]: log }));
  }

  function markError(msg?: string) {
    setSteps(s => {
      const u = { ...s };
      for (const k of Object.keys(u) as (keyof StepState)[]) {
        if (u[k] === "running") {
          u[k] = "error";
          if (msg) setLogs(l => ({ ...l, [k]: msg }));
        }
      }
      return u;
    });
  }

  function friendlyError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === "AbortError") return "ยกเลิกโดยผู้ใช้";

    // Server returned HTML instead of JSON (crashed, 502, 504, cold start)
    if (raw.includes("Unexpected token '<'") || raw.includes("Unexpected token \"<\"") || raw.includes("<html"))
      return "Server ไม่ตอบสนอง (502/504) — กรุณารอสักครู่แล้วกดรันใหม่";

    if (raw.includes("ENOSPC") || raw.includes("no space left"))
      return "พื้นที่ดิสก์บน Server เต็ม — กรุณาติดต่อผู้ดูแลระบบ";
    if (raw.includes("Unauthorized") || raw.includes("401"))
      return "Session หมดอายุ — กรุณา Login ใหม่";
    if (raw.includes("403"))
      return "ไม่มีสิทธิ์เข้าถึง — กรุณาตรวจสอบ API Key ใน Settings";
    if (raw.includes("429"))
      return "API เกิน Rate Limit — กรุณารอสักครู่แล้วลองใหม่";
    if (raw.includes("Server Action") || raw.includes("newer deployment") || raw.includes("older deployment")) {
      setTimeout(() => { if (confirm("มีการอัพเดตระบบใหม่ — กด OK เพื่อ refresh หน้า")) window.location.reload(); }, 300);
      return "ระบบมีการอัพเดต — กรุณา Refresh หน้าแล้วรันใหม่";
    }
    if (raw.includes("timeout") || raw.includes("ETIMEDOUT") || raw.includes("504"))
      return "หมดเวลารอ (Timeout) — กรุณากดรันใหม่อีกครั้ง";
    if (raw.includes("ECONNREFUSED") || raw.includes("fetch failed") || raw.includes("NetworkError"))
      return "ไม่สามารถเชื่อมต่อ Server — กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ต";
    if (raw.toLowerCase().includes("keywords required") || raw.includes("ไม่สามารถดึง keywords")) {
      setShowClearCacheDialog(true);
      return "Keywords ขาดหาย — กรุณาล้างแคชแล้วรันใหม่";
    }
    if (raw.includes("pexels") || raw.includes("Pexels"))
      return "Pexels API มีปัญหา — กรุณาตรวจสอบ API Key ใน Settings แล้วลองใหม่";
    if (raw.includes("ffmpeg") || raw.includes("ffprobe"))
      return "Video processing ล้มเหลว — กรุณากดรันใหม่อีกครั้ง";
    if (raw.includes("Whisper") || raw.includes("transcribe"))
      return "Transcribe ล้มเหลว — กรุณากดรันใหม่อีกครั้ง";
    if (err instanceof ApiCallError && err.data.retryable)
      return String(err.data.error ?? "เกิดข้อผิดพลาด — กรุณากดรันใหม่อีกครั้ง");
    if (err instanceof ApiCallError && err.data.error)
      return String(err.data.error);
    const firstLine = raw.split("\n")[0].slice(0, 200);
    return (firstLine || "เกิดข้อผิดพลาด") + " — กรุณากดรันใหม่อีกครั้ง";
  }

  /** Returns true if the error is a missing-key error and opens the modal. */
  function handleMissingKey(
    err: unknown,
    fallbackRetry: keyof StepState | "runAll" | "runGenerate" | "runAvatarPipeline"
  ): boolean {
    // If server explicitly says retryable=false → not a key problem, just show toast
    if (err instanceof ApiCallError && err.data.retryable === false) return false;

    // Only open modal if server sent missingKey field (explicit) — don't guess from error string
    let keyType = null;
    if (err instanceof ApiCallError) {
      keyType = detectMissingKeyType(err.data);
    }
    if (!keyType) return false;

    // Find which step is currently "running" — that's the step that failed
    const runningStep = (Object.keys(stepsRef.current) as (keyof StepState)[])
      .find(k => stepsRef.current[k] === "running");
    const retryStep = runningStep ?? fallbackRetry;

    setMissingKey({ type: keyType, retryStep });
    return true;
  }

  // ── Individual step runners ──────────────────────────────────────

  function splitScenes(text: string): string[] {
    return text.split(/\n+/).map(s => s.trim()).filter(s => s.length > 0);
  }

  async function runKeywords(): Promise<string[]> {
    setStep("keywords", "running");
    const sc = splitScenes(cleanScript);
    setScenes(sc);
    pipe.current.scenes = sc;
    const kwRes = await fetch("/api/videos/extract-keywords", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenes: sc }),
      signal: abortControllerRef.current?.signal,
    });
    const kwData = await kwRes.json();
    assertOk("Keywords", kwRes, kwData);
    const kws: string[] = kwData.keywords ?? [];
    pipe.current.keywords = kws;
    pipe.current.keywordsPerScene = kwData.keywordsPerScene ?? 5;
    pipe.current.sceneClipCounts = kwData.sceneClipCounts ?? [];
    pipe.current.sceneDurations = kwData.sceneDurations ?? [];
    setKeywords(kws);
    const totalClips = (kwData.sceneClipCounts ?? []).reduce((a: number, b: number) => a + b, kws.length);
    setStep("keywords", "done", `${sc.length} ฉาก → ${kws.length} keywords (${totalClips} คลิปที่ต้องการ)`);
    return kws;
  }

  async function runFetchStock(kws: string[]): Promise<StockVideo[]> {
    const srcLabel = stockSource === "pexels" ? "Pexels" : stockSource === "pixabay" ? "Pixabay" : "Pexels+Pixabay";
    setStep("fetchStock", "running", `${kws.length} keywords → ${srcLabel}...`);

    // Use scene durations from extract-keywords (more accurate than char-count estimate)
    const sceneDurations: number[] = pipe.current.sceneDurations ?? [];
    const totalDurationSec = sceneDurations.length > 0
      ? sceneDurations.reduce((a, b) => a + b, 0)
      : Math.max(30, Math.ceil(
          (pipe.current.scenes ?? []).reduce((s, sc) => s + sc.replace(/\s/g, "").length, 0) / 3
        ));

    const stockRes = await fetch("/api/videos/fetch-stock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keywords: kws,
        download: true,
        totalDurationSec,
        stockSource,
        ...(targetClipCount > 0 ? { overrideClipCount: targetClipCount } : {}),
      }),
      signal: abortControllerRef.current?.signal,
    });
    const stockData = await stockRes.json();
    assertOk("Stock", stockRes, stockData);
    const stockVideos: StockVideo[] = (stockData.results ?? []).filter(
      (r: StockVideo) => r.localUrl || r.videoUrl
    );
    if (!stockVideos.length) throw new Error("ไม่พบ stock video ที่เหมาะสม");
    pipe.current.stockVideos = stockVideos;
    setPipeStockVideos(stockVideos);
    // Record how many clips the system auto-fetched (shown in UI)
    setAutoClipCount(stockVideos.length);
    // Reset to "all selected" — start fresh, user deselects what they don't want
    setExcludedClipIds(new Set());
    const pexelsCnt = stockVideos.filter(v => v.pexelsId < 9_000_000).length;
    const pixabayCnt = stockVideos.filter(v => v.pexelsId >= 9_000_000).length;
    const srcBreakdown = stockSource === "both" ? ` (P:${pexelsCnt} B:${pixabayCnt})` : "";
    setStep("fetchStock", "done", `ได้ ${stockVideos.length} คลิป สำหรับ ${Math.round(totalDurationSec)}s${srcBreakdown}`);
    // Refresh cache info so the clear button appears
    fetch("/api/stocks").then(r => r.json()).then(d => { if (d.count !== undefined) setStockCacheInfo(d); }).catch(() => {});
    return stockVideos;
  }

  async function runTts(): Promise<string> {
    if (ttsProvider === "gemini") {
      setStep("tts", "running", "Gemini TTS...");
      const ttsRes = await fetch("/api/videos/tts-gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: cleanScript, voiceName: geminiVoiceName }),
        signal: abortControllerRef.current?.signal,
      });
      const ttsData = await ttsRes.json();
      assertOk("TTS (Gemini)", ttsRes, ttsData);
      const voiceUrl = ttsData.voiceUrl as string;
      pipe.current.voiceUrl = voiceUrl;
      setTtsUrl(voiceUrl);
      setStep("tts", "done", voiceUrl);
      return voiceUrl;
    } else {
      setStep("tts", "running", "ElevenLabs...");
      const ttsRes = await fetch("/api/videos/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: cleanScript, voiceId, languageCode: "th" }),
        signal: abortControllerRef.current?.signal,
      });
      const ttsData = await ttsRes.json();
      assertOk("TTS", ttsRes, ttsData);
      const voiceUrl = ttsData.voiceUrl as string;
      pipe.current.voiceUrl = voiceUrl;
      setTtsUrl(voiceUrl);
      setStep("tts", "done", voiceUrl);
      return voiceUrl;
    }
  }

  async function runTranscribe(voiceUrl: string): Promise<{ captions: Caption[]; sceneCaptions: Caption[]; audioDurationMs: number; words: { word: string; startMs: number; endMs: number }[] }> {
    setStep("transcribe", "running", "Whisper transcribing...");
    const fullAudioUrl = voiceUrl.startsWith("http://") || voiceUrl.startsWith("https://")
      ? voiceUrl
      : `${window.location.origin}${voiceUrl}`;
    const txRes = await fetch("/api/videos/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioUrl: fullAudioUrl, scriptPrompt: cleanScript.slice(0, 800), script: cleanScript }),
      signal: abortControllerRef.current?.signal,
    });
    const txData = await txRes.json();
    assertOk("Transcribe", txRes, txData);

    const whisperWords: { word: string; startMs: number; endMs: number }[] = txData.words ?? [];
    const captions: Caption[] = txData.captions ?? [];
    const durationFromServerRaw = Number(txData.audioDurationMs);
    const durationFromServer = Number.isFinite(durationFromServerRaw) ? durationFromServerRaw : 0;

    const audioDurationMs = durationFromServer > 0
      ? durationFromServer
      : whisperWords.length
      ? whisperWords[whisperWords.length - 1].endMs
      : captions.length
        ? Math.max(...captions.map(c => c.endMs))
        : (txData.segments?.at(-1)?.endMs ?? 60000);

    // ── Use captions from server (already GPT-split + Whisper-timestamped) ──
    // Server handles: GPT phrase split → char-weighted timestamp mapping via Whisper segments
    // Client only adds hook/body/cta tags from split-phrases (text matching, no re-timestamping)
    setStep("transcribe", "running", "Tagging phrases...");
    let sceneCaptions: Caption[] = [];

    // Get tags from split-phrases
    const splitTagByIndex: ("hook" | "body" | "cta")[] = [];
    const tagMap = new Map<string, "hook" | "body" | "cta">();
    try {
      const splitRes = await fetch("/api/videos/split-phrases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: cleanScript, audioDurationMs }),
        signal: abortControllerRef.current?.signal,
      });
      if (splitRes.ok) {
        const splitData = await splitRes.json();
        const spPhrases: string[] = splitData.phrases ?? [];
        const spTags: ("hook" | "body" | "cta")[] = splitData.tags ?? [];
        splitTagByIndex.push(...spTags);
        spPhrases.forEach((p: string, i: number) => tagMap.set(p.trim(), spTags[i] ?? "body"));
      }
    } catch { /* non-critical */ }

    // Apply tags to server captions by text match, fallback to position
    if (captions.length > 0) {
      sceneCaptions = captions.map((cap, i) => {
        const t = cap.text.trim();
        let tag = tagMap.get(t);
        if (!tag) {
          // fuzzy: find any split-phrase that starts with or contains this caption text
          for (const [phrase, pt] of tagMap) {
            if (phrase.startsWith(t) || t.startsWith(phrase)) { tag = pt; break; }
          }
        }
        if (!tag && i < splitTagByIndex.length) tag = splitTagByIndex[i];
        if (!tag) tag = i === 0 ? "hook" : "body";
        return { ...cap, tag };
      });
    }

    // Fallback for non-Thai word-level grouping
    if (!sceneCaptions.length && whisperWords.length > 0) {
      const groups: Caption[] = [];
      let bucket: typeof whisperWords = [];
      let chars = 0;
      const flush = () => {
        if (!bucket.length) return;
        groups.push({ text: bucket.map(w => w.word).join(""), startMs: bucket[0].startMs, endMs: bucket[bucket.length - 1].endMs });
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

    pipe.current.captions = captions;
    pipe.current.sceneCaptions = sceneCaptions;
    pipe.current.audioDurationMs = audioDurationMs;
    pipe.current.words = whisperWords;
    setStep("transcribe", "done", `${sceneCaptions.length} ซับ · ${(audioDurationMs / 1000).toFixed(1)}s`);
    return { captions, sceneCaptions, audioDurationMs, words: whisperWords };
  }

  async function runConfig(stockVideos: StockVideo[], voiceUrl: string, audioDurationMs: number, sceneCaptions: Caption[], noSubtitles = false) {
    setStep("config", "running");
    const cfgRes = await fetch("/api/videos/generate-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortControllerRef.current?.signal,
      body: JSON.stringify({
        sceneCaptions: noSubtitles ? [] : sceneCaptions,
        stockVideos,
        voiceFile: voiceUrl,
        audioDurationMs,
        fontFamily: subFontFamily,
        subtitlePosition: subPosition,
        subtitleSize: subFontSize,
        subtitleColor: subColor,
        subtitleAccentColor: subAccentColor,
        subtitleStylePreset: subStylePreset,
        subtitleFontWeight: subFontWeight,
        scenes: pipe.current.scenes ?? [],
        keywordsPerScene: pipe.current.keywordsPerScene ?? 5,
        sceneClipCounts: pipe.current.sceneClipCounts ?? [],
        sceneDurations: pipe.current.sceneDurations ?? [],
      }),
    });
    const cfgData = await cfgRes.json();
    assertOk("Config", cfgRes, cfgData);
    const config = cfgData.config;
    pipe.current.config = config;
    setStep("config", "done", `${(config.durationInFrames / 30).toFixed(0)}s · ${config.bgVideos?.length} clips`);
    return config;
  }

  async function runRender(config: unknown): Promise<string> {
    setStep("render", "running", "Remotion rendering...");
    const renderRes = await fetch("/api/videos/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shortVideoConfig: config }),
      signal: abortControllerRef.current?.signal,
    });
    const renderData = await renderRes.json();
    assertOk("Render", renderRes, renderData);
    const url = renderData.videoUrl as string;
    pipe.current.renderedVideoUrl = url;
    setPreRenderUrl(url);
    if (!useAvatar) setVideoUrl(url);
    setStep("render", "done", url);
    return url;
  }

  async function saveToGallery(videoUrl: string) {
    try {
      const res = await fetch("/api/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoUrl,
          audioUrl: pipe.current.voiceUrl ?? null,
          script: script.trim() || null,
          avatarModel: "none",
          voiceModel: voiceId || "gemini",
          sceneCount: pipe.current.scenes?.length ?? 1,
          renderConfig: pipe.current.config ?? null,
          status: "COMPLETED",
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        console.error("[saveToGallery] failed:", res.status, err);
        toast.error(`บันทึก Gallery ไม่สำเร็จ: ${res.status}`);
      }
    } catch (e) {
      console.error("[saveToGallery] error:", e);
      toast.error("บันทึก Gallery ไม่สำเร็จ");
    }
  }

  // ── Step 7: Avatar — only HeyGen gen + poll, show preview ──

  async function runAvatar(audioUrl: string): Promise<string> {
    // Direct URL mode — skip HeyGen entirely
    if (avatarInputMode === "direct") {
      if (!avatarDirectUrl.trim()) throw new Error("กรอก Avatar Video URL ก่อน");
      setStep("avatar", "running", "Using direct URL...");
      setAvatarGreenUrl(avatarDirectUrl.trim());
      setStep("avatar", "done", avatarDirectUrl.trim());
      return avatarDirectUrl.trim();
    }

    setStep("avatar", "running", "HeyGen generating (remove_background)...");
    setAvatarGreenUrl("");

    // If intro-only mode: trim audio to first N seconds before sending to HeyGen
    let avatarAudioUrl = audioUrl;
    if (avatarTiming === "bookend" && avatarBookendSecs > 0) {
      setStep("avatar", "running", `Trimming audio to ${avatarBookendSecs}s...`);
      const trimRes = await fetch("/api/videos/trim-audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioUrl, durationSecs: avatarBookendSecs }),
      });
      const trimData = await trimRes.json();
      assertOk("Trim audio", trimRes, trimData);
      avatarAudioUrl = trimData.audioUrl;
      setStep("avatar", "running", `HeyGen generating ${avatarBookendSecs}s avatar...`);
    }

    const genRes = await fetch("/api/heygen/generate-with-bg", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortControllerRef.current?.signal,
      body: JSON.stringify({
        audioUrl: avatarAudioUrl,
        avatarId,
        greenScreen: true,
        scale: avatarScale,
        offsetX: avatarOffsetX,
        offsetY: avatarOffsetY,
      }),
    });
    const genData = await genRes.json();
    assertOk("Avatar", genRes, genData);
    const heygenVideoId = genData.videoId as string;
    setStep("avatar", "running", `HeyGen video: ${heygenVideoId} — polling...`);

    let avatarVideoUrl = "";
    const MAX_POLLS = 360;
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, 5000));
      if (abortRef.current) throw new Error("__ABORTED__");
      // Wait for tab to be visible before fetching (prevents ERR_NETWORK_IO_SUSPENDED)
      if (document.visibilityState === "hidden") {
        await new Promise<void>(resolve => {
          const handler = () => { if (document.visibilityState === "visible") { document.removeEventListener("visibilitychange", handler); resolve(); } };
          document.addEventListener("visibilitychange", handler);
        });
      }
      let pollData: { status?: string; videoUrl?: string | null; errorMsg?: string | null } = {};
      try {
        const pollRes = await fetch("/api/videos/poll-avatar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoId: heygenVideoId }),
          signal: abortControllerRef.current?.signal,
        });
        pollData = await pollRes.json();
      } catch {
        // Network error (suspend/offline) — skip this tick, retry next cycle
        const elapsed = Math.round((i + 1) * 5 / 60);
        setStep("avatar", "running", `HeyGen: polling... (${i + 1}) ~${elapsed}min ⏸ retrying`);
        continue;
      }
      if (pollData.status === "completed" && pollData.videoUrl) {
        avatarVideoUrl = pollData.videoUrl;
        break;
      }
      if (pollData.status === "failed") {
        throw new Error(`Avatar failed: ${pollData.errorMsg ?? "unknown"}`);
      }
      const elapsed = Math.round((i + 1) * 5 / 60);
      setStep("avatar", "running", `HeyGen: ${pollData.status}... (${i + 1}) ~${elapsed}min`);
    }
    if (!avatarVideoUrl) throw new Error("Avatar: timeout after 30 minutes");

    setAvatarGreenUrl(avatarVideoUrl);
    setStep("avatar", "done", "Avatar พร้อม");
    return avatarVideoUrl;
  }

  // ── Step 8: Composite — AI remove bg + overlay onto Remotion video ──

  async function runComposite(bgVideoUrl: string, avatarUrl: string): Promise<string> {
    const isDirect = avatarInputMode === "direct";
    const modeLabel = isDirect ? "วางทับวิดีโอ (Direct URL)..." : compositeMode === "rembg" ? "AI rembg ลบ background..." : "Chromakey ลบ green screen + composite...";
    setStep("composite", "running", modeLabel);
    const compRes = await fetch("/api/heygen/composite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortControllerRef.current?.signal,
      body: isDirect
        ? JSON.stringify({
            avatarVideoUrl: avatarUrl,
            bgVideoUrl,
            mode: "chromakey",
            noScale: true,
            chromaColor: chromaColor.replace("#", "0x"),
            chromaSimilarity,
            chromaBlend,
          })
        : JSON.stringify({
            avatarVideoUrl: avatarUrl,
            bgVideoUrl,
            mode: compositeMode,
            avatarTiming,
            avatarBookendSecs,
            avatarScale,
            avatarOffsetX,
            avatarOffsetY,
            chromaColor: chromaColor.replace("#", "0x"),
            chromaSimilarity,
            chromaBlend,
            rembgModel,
          }),
    });
    const compData = await compRes.json();
    assertOk("Composite", compRes, compData);

    const finalUrl = compData.videoUrl as string;
    const usedMode = (compData.usedMode as string) ?? "unknown";
    if (compData.aiError) {
      toast.error(`AI failed → ใช้ chromakey fallback: ${compData.aiError}`);
    }
    // Store composite URL so subtitle step always burns onto the avatar-composited video
    pipe.current.compositeUrl = finalUrl;
    setCompositePreviewUrl(finalUrl);
    setStep("composite", "done", `${usedMode} — ${finalUrl}`);

    // Save to Gallery
    try {
      await fetch("/api/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoUrl: finalUrl,
          avatarVideoUrl: avatarUrl,
          audioUrl: pipe.current.voiceUrl ?? null,
          script: script.trim() || null,
          avatarModel: avatarId || "direct",
          voiceModel: voiceId || "unknown",
          sceneCount: pipe.current.scenes?.length ?? 1,
          renderConfig: pipe.current.config ?? null,
          status: "COMPLETED",
        }),
      });
      toast.success("บันทึกลง Gallery แล้ว");
    } catch {
      // non-critical
    }

    return finalUrl;
  }

  // ── Input validation before any pipeline run ────────────────────
  // Returns true if valid, false + shows toast if something is missing.
  function validateInputs(phase: "prepare" | "generate" | "avatar"): boolean {
    const errors: string[] = [];

    if (phase === "prepare" || phase === "generate") {
      if (!script.trim())
        errors.push("กรอก Script ก่อนเริ่ม");

      const isDirectMode = avatarInputMode === "direct";
      if (!isDirectMode) {
        // TTS required
        if (ttsProvider === "elevenlabs" && !voiceId.trim())
          errors.push("เลือก ElevenLabs Voice ID ใน TTS Settings");
      } else {
        // Direct URL mode — need avatar URL (audio source)
        if (!avatarDirectUrl.trim())
          errors.push("กรอก Avatar Video URL (Direct URL mode)");
      }
    }

    if (phase === "generate") {
      if (!pipe.current.voiceUrl)
        errors.push("ยังไม่มีไฟล์เสียง — กด Run All ก่อน");
      if (!editedSceneCaptions.length)
        errors.push("ยังไม่มีซับไตเติ้ล — กด Run All ก่อน");
      if (!getActiveStocks().length)
        errors.push("ยังไม่มี stock video — กด Run All ก่อน");
    }

    if (phase === "avatar") {
      if (!pipe.current.voiceUrl && avatarInputMode !== "direct")
        errors.push("ยังไม่มีไฟล์เสียง — กด Run All ก่อน");
      if (avatarInputMode === "generate" && !avatarId.trim())
        errors.push("กรอก HeyGen Avatar ID ใน Avatar Settings");
      if (avatarInputMode === "direct" && !avatarDirectUrl.trim())
        errors.push("กรอก Avatar Video URL");
      if (!pipe.current.renderedVideoUrl)
        errors.push("ยังไม่มีวิดีโอ — กด Render ก่อน");
    }

    if (errors.length > 0) {
      errors.forEach((e, i) => {
        setTimeout(() => toast.error(e), i * 150);
      });
      return false;
    }
    return true;
  }

  // ── Full pipeline ────────────────────────────────────────────────

  // Pipeline Phase 1: Content → Render (stops before HeyGen)
  async function runAll() {
    if (!validateInputs("prepare")) return;
    const isDirectMode = avatarInputMode === "direct" && avatarDirectUrl.trim();

    // Check if any LLM key exists — if not, show picker before starting
    try {
      const keysRes = await fetch("/api/user/api-keys");
      if (keysRes.ok) {
        const keys = await keysRes.json();
        if (!keys.geminiKey && !keys.openaiKey) {
          setShowLLMPicker(true);
          return;
        }
      }
    } catch { /* ignore — let pipeline fail naturally if keys really missing */ }

    setRunning(true);
    abortRef.current = false;
    abortControllerRef.current = new AbortController();
    stepsRef.current = { ...DEFAULT_STEPS };
    setSteps({ ...DEFAULT_STEPS });
    setLogs({});
    setVideoUrl("");
    setPreRenderUrl("");
    setCompositePreviewUrl("");
    setAvatarGreenUrl("");
    setTtsUrl("");
    setPipeStockVideos([]);
    pipe.current = {};

    const videoOnly = !useAvatar;

    try {
      if (videoOnly) {
        setStep("avatar", "skip", "ข้าม (Video Only)");
        setStep("composite", "skip", "ข้าม (Video Only)");
      }

      // 1. Keywords (scene-based — used for padding/fallback later)
      await runKeywords();
      if (abortRef.current) throw new Error("__ABORTED__");

      // 2. TTS
      let voiceUrl: string;
      if (isDirectMode) {
        setStep("tts", "skip", "ข้าม (Direct URL mode)");
        const directUrl = avatarDirectUrl.trim();
        pipe.current.voiceUrl = directUrl;
        voiceUrl = directUrl;
        setAvatarGreenUrl(directUrl);
        pipe.current.compositeUrl = directUrl;
      } else {
        voiceUrl = await runTts();
      }

      // 3. Transcribe
      if (abortRef.current) throw new Error("__ABORTED__");
      const { sceneCaptions } = await runTranscribe(voiceUrl);
      setEditedSceneCaptions(sceneCaptions);

      // 4. Stock — per-subtitle fetch (after transcribe so we have captions)
      // scene-based pre-fetch removed: per-subtitle fetch below replaces it entirely
      toast.success("Transcribe เสร็จ — กำลังหา stock ตรงซับ...");

      // ── Per-subtitle stock matching (blocking — must finish before pipeline ends) ──
      if (sceneCaptions.length > 0) {
        const prevKws      = pipe.current.keywords ?? [];
        const prevStocks   = pipe.current.stockVideos ?? [];
        const N            = sceneCaptions.length;
        const subTexts     = sceneCaptions.map(c => c.text);
        const audioDurSec  = (pipe.current.audioDurationMs ?? 60000) / 1000;

        // ── Step A: Fetch per-subtitle keywords (retry up to 2x if count < N) ──
        let perSubKws: string[] = [];
        setStep("keywords", "running", `mapping ${N} ซับ → keyword...`);
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const kwRes = await fetch("/api/videos/extract-keywords", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ scenes: subTexts, perSubtitle: true }),
            });
            if (!kwRes.ok) continue;
            const kwData = await kwRes.json();
            const got: string[] = kwData.keywords ?? [];
            if (got.length >= N) { perSubKws = got; break; }
            if (got.length > perSubKws.length) perSubKws = got;
          } catch { continue; }
        }

        // ── Step B: Pad keywords to N using scene keywords as filler ──
        if (perSubKws.length < N) {
          const sceneKwPool = prevKws.length > 0 ? prevKws : ["people", "nature", "city", "office", "technology"];
          const padded = [...perSubKws];
          while (padded.length < N) padded.push(sceneKwPool[padded.length % sceneKwPool.length]);
          if (perSubKws.length > 0 && perSubKws.length < N)
            toast(`Keywords ไม่ครบ (${perSubKws.length}/${N}) — เติม scene keyword แทน`);
          perSubKws = padded;
        }

        if (perSubKws.length === 0) {
          // Total keyword failure → keep original stocks
          setStep("keywords", "done", `${prevKws.length} keywords (เดิม)`);
          setStep("fetchStock", "done", `${prevStocks.length} คลิป (เดิม)`);
        } else {
          pipe.current.keywords = perSubKws;
          pipe.current.sceneClipCounts = perSubKws.map(() => 1);
          setKeywords(perSubKws);
          setStep("keywords", "done", `${perSubKws.length} keywords (1/ซับ)`);

          // ── Step C: Fetch stocks with LLM ranking — send full perSubKws+subTexts in 1 call ──
          // fetch-stock will do: search 15 candidates per keyword → LLM pick best index → dedup
          setStep("fetchStock", "running", `ดึง + rank stock ${perSubKws.length} คลิปตรงซับ...`);

          // clips keyed by position index (perSubKws[i] → clip) since LLM ranking already picked best
          const clipAtIdx = new Map<number, StockVideo>();
          // Track keywords that got no clip for retry
          let missingIdxs = perSubKws.map((_, i) => i);

          for (let attempt = 0; attempt < 3 && missingIdxs.length > 0; attempt++) {
            try {
              const kwsToFetch  = missingIdxs.map(i => perSubKws[i]);
              const textsToFetch = missingIdxs.map(i => subTexts[i] ?? perSubKws[i]);
              const stockRes = await fetch("/api/videos/fetch-stock", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  keywords: kwsToFetch,
                  subtitleTexts: textsToFetch,
                  download: true,
                  totalDurationSec: audioDurSec,
                  stockSource,
                  overrideClipCount: kwsToFetch.length,
                }),
              });
              if (!stockRes.ok) break;
              const stockData = await stockRes.json();
              const fetched: StockVideo[] = (stockData.results ?? []).filter(
                (r: StockVideo) => r.localUrl || r.videoUrl
              );
              // Map fetched clips back to original perSubKws index by position
              for (let fi = 0; fi < fetched.length; fi++) {
                const origIdx = missingIdxs[fi];
                if (origIdx !== undefined) clipAtIdx.set(origIdx, fetched[fi]);
              }
              missingIdxs = missingIdxs.filter(i => !clipAtIdx.has(i));
              if (missingIdxs.length === 0) break;
              if (attempt < 2) setStep("fetchStock", "running", `retry ${attempt + 1}: ${missingIdxs.length} ซับยังขาด clip...`);
            } catch { break; }
          }

          // ── Step D: Build ordered clips — clipAtIdx[i] is already LLM-ranked best match ──
          // Backfill gaps with any available clip (front-to-back, no modulo repeat)
          const allFetched: StockVideo[] = [];
          const seenIds = new Set<number>();
          for (const clip of clipAtIdx.values()) {
            if (!seenIds.has(clip.pexelsId)) { allFetched.push(clip); seenIds.add(clip.pexelsId); }
          }

          const orderedClips: StockVideo[] = [];
          let backfillIdx = 0;
          for (let i = 0; i < N; i++) {
            const clip = clipAtIdx.get(i);
            if (clip) {
              orderedClips.push(clip);
            } else if (allFetched.length > 0) {
              orderedClips.push(allFetched[backfillIdx % allFetched.length]);
              backfillIdx++;
            }
          }

          // ── Step E: Fail-safe — per-subtitle fetch failed entirely, fall back to scene-based ──
          if (orderedClips.length === 0) {
            toast("ไม่พบ stock ตรงซับ — ใช้ scene keyword แทน");
            setStep("keywords", "done", `${prevKws.length} keywords (เดิม)`);
            try {
              await runFetchStock(prevKws.length > 0 ? prevKws : (pipe.current.keywords ?? []));
            } catch {
              setStep("fetchStock", "done", `ไม่พบ stock`);
            }
          } else {
            const missing = N - clipAtIdx.size;
            if (missing > 0) toast(`Backfill ${missing} คลิป — บางซับใช้คลิปซ้ำ`);
            pipe.current.stockVideos = orderedClips;
            setPipeStockVideos(orderedClips);
            setExcludedClipIds(new Set());
            setStep("fetchStock", "done", `ได้ ${orderedClips.length} คลิป (LLM ranked)`);
            toast.success(`Stock พร้อม ${orderedClips.length} คลิป — กด Generate Video ได้เลย`);
            fetch("/api/stocks").then(r => r.json()).then(d => { if (d.count !== undefined) setStockCacheInfo(d); }).catch(() => {});
          }
        }
      }
    } catch (err) {
      if ((err instanceof Error && err.message === "__ABORTED__") || (err instanceof Error && err.name === "AbortError")) {
        toast("หยุดการทำงานแล้ว");
        markError("ยกเลิกโดยผู้ใช้");
      } else if (!handleMissingKey(err, "runAll")) {
        const msg = friendlyError(err);
        toast.error(msg);
        markError(msg);
      }
    } finally {
      abortRef.current = false;
      abortControllerRef.current = null;
      setRunning(false);
    }
  }

  // Helper: apply user exclusions to stock videos before config
  function getActiveStocks() {
    return (pipe.current.stockVideos ?? []).filter(v => !excludedClipIds.has(v.pexelsId));
  }

  // Helper: toggle clip selection with max-limit enforcement
  function toggleClip(pexelsId: number) {
    setExcludedClipIds(prev => {
      const next = new Set(prev);
      if (next.has(pexelsId)) {
        // Re-include
        next.delete(pexelsId);
      } else {
        // Exclude — but if targetClipCount is set, enforce max selected
        const currentActive = pipeStockVideos.filter(v => !next.has(v.pexelsId)).length;
        if (targetClipCount > 0 && currentActive <= targetClipCount) {
          // Already at or below limit — can't exclude more (would go under)
          // Instead swap: exclude this one is fine since user is reducing
        }
        next.add(pexelsId);
      }
      // If targetClipCount is set and active count now exceeds limit,
      // auto-exclude the last one that was added
      const activeAfter = pipeStockVideos.filter(v => !next.has(v.pexelsId));
      if (targetClipCount > 0 && activeAfter.length > targetClipCount) {
        // Find the most recently selected (last in array not in excluded) and exclude it
        for (let i = pipeStockVideos.length - 1; i >= 0; i--) {
          const id = pipeStockVideos[i].pexelsId;
          if (!next.has(id) && id !== pexelsId) { next.add(id); break; }
        }
      }
      return next;
    });
  }

  // Pipeline Phase 1b: Render preview WITHOUT subtitles — user previews CSS overlay first
  async function runGenerate() {
    if (!validateInputs("generate")) return;
    const stocks = getActiveStocks();
    const voice = pipe.current.voiceUrl ?? "";
    const durMs = pipe.current.audioDurationMs ?? 0;

    setRunning(true);
    abortRef.current = false;
    abortControllerRef.current = new AbortController();
    setVideoUrl("");
    try {
      const config = await runConfig(stocks, voice, durMs, editedSceneCaptions, false);
      if (abortRef.current) throw new Error("__ABORTED__");
      const renderedUrl = await runRender(config);
      if (!useAvatar) {
        await saveToGallery(renderedUrl);
        toast.success("Render เสร็จ! บันทึกใน Gallery แล้ว");
      }
    } catch (err) {
      if ((err instanceof Error && err.message === "__ABORTED__") || (err instanceof Error && err.name === "AbortError")) {
        toast("หยุดการทำงานแล้ว");
        markError("ยกเลิกโดยผู้ใช้");
      } else if (!handleMissingKey(err, "runGenerate")) {
        const msg = friendlyError(err);
        toast.error(msg);
        markError(msg);
      }
    } finally {
      abortRef.current = false;
      abortControllerRef.current = null;
      setRunning(false);
    }
  }

  // Pipeline Phase 2: Avatar (HeyGen) → Composite
  async function runAvatarPipeline() {
    if (!validateInputs("avatar")) return;
    const voice = pipe.current.voiceUrl!;
    const rendered = pipe.current.renderedVideoUrl!;

    setRunning(true);
    abortRef.current = false;
    abortControllerRef.current = new AbortController();
    setVideoUrl("");
    try {
      const avUrl = await runAvatar(voice);
      if (abortRef.current) throw new Error("__ABORTED__");
      const composited = await runComposite(rendered, avUrl);
      setVideoUrl(composited);
      toast.success("เสร็จแล้ว!");
    } catch (err) {
      if ((err instanceof Error && err.message === "__ABORTED__") || (err instanceof Error && err.name === "AbortError")) {
        toast("หยุดการทำงานแล้ว");
        markError("ยกเลิกโดยผู้ใช้");
      } else if (!handleMissingKey(err, "runAvatarPipeline")) {
        const msg = friendlyError(err);
        toast.error(msg);
        markError(msg);
      }
    } finally {
      abortRef.current = false;
      abortControllerRef.current = null;
      setRunning(false);
    }
  }

  // ── Partial re-run from a specific step ──────────────────────────

  async function rerunFrom(step: keyof StepState) {
    if (running) return;
    setRunning(true);
    abortRef.current = false;
    abortControllerRef.current = new AbortController();
    setVideoUrl("");

    try {
      let kws = pipe.current.keywords ?? [];
      let stocks = getActiveStocks();
      let voice = pipe.current.voiceUrl ?? "";
      let scCaps = editedSceneCaptions.length > 0 ? editedSceneCaptions : (pipe.current.sceneCaptions ?? []);
      let durMs = pipe.current.audioDurationMs ?? 0;
      let cfg = pipe.current.config;
      let rendered = pipe.current.renderedVideoUrl ?? "";

      const isDirectMode = avatarInputMode === "direct" && avatarDirectUrl.trim();

      // Helper: per-subtitle stock fetch (same logic as runAll) — reused across re-run cases
      async function rerunPerSubtitleStock(caps: Caption[]) {
        if (caps.length === 0) return;
        const N2 = caps.length;
        const subTexts2 = caps.map(c => c.text);
        const audioDurSec2 = (pipe.current.audioDurationMs ?? 60000) / 1000;
        const sceneKwPool = (pipe.current.keywords ?? []);

        let perSubKws2: string[] = [];
        setStep("fetchStock", "running", `mapping ${N2} ซับ → keyword...`);
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const r = await fetch("/api/videos/extract-keywords", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ scenes: subTexts2, perSubtitle: true }),
            });
            if (!r.ok) continue;
            const d = await r.json();
            const got: string[] = d.keywords ?? [];
            if (got.length >= N2) { perSubKws2 = got; break; }
            if (got.length > perSubKws2.length) perSubKws2 = got;
          } catch { continue; }
        }
        if (perSubKws2.length < N2) {
          const pool = sceneKwPool.length > 0 ? sceneKwPool : ["people", "nature", "city", "office", "technology"];
          const padded = [...perSubKws2];
          while (padded.length < N2) padded.push(pool[padded.length % pool.length]);
          perSubKws2 = padded;
        }
        if (perSubKws2.length === 0) { setStep("fetchStock", "done", "ไม่สามารถ mapping keyword ได้"); return; }

        pipe.current.sceneClipCounts = perSubKws2.map(() => 1);
        setStep("fetchStock", "running", `ดึง + rank stock ${perSubKws2.length} คลิป...`);

        const clipAtIdx2 = new Map<number, StockVideo>();
        let missingIdxs2 = perSubKws2.map((_, i) => i);
        for (let attempt = 0; attempt < 3 && missingIdxs2.length > 0; attempt++) {
          try {
            const r = await fetch("/api/videos/fetch-stock", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                keywords: missingIdxs2.map(i => perSubKws2[i]),
                subtitleTexts: missingIdxs2.map(i => subTexts2[i] ?? perSubKws2[i]),
                download: true, totalDurationSec: audioDurSec2, stockSource,
                overrideClipCount: missingIdxs2.length,
              }),
            });
            if (!r.ok) break;
            const d = await r.json();
            const fetched: StockVideo[] = (d.results ?? []).filter((x: StockVideo) => x.localUrl || x.videoUrl);
            for (let fi = 0; fi < fetched.length; fi++) {
              const origIdx = missingIdxs2[fi];
              if (origIdx !== undefined) clipAtIdx2.set(origIdx, fetched[fi]);
            }
            missingIdxs2 = missingIdxs2.filter(i => !clipAtIdx2.has(i));
          } catch { break; }
        }

        const allFetched2 = [...new Map([...clipAtIdx2.values()].map(c => [c.pexelsId, c])).values()];
        const ordered2: StockVideo[] = [];
        let bfIdx = 0;
        for (let i = 0; i < N2; i++) {
          const c = clipAtIdx2.get(i);
          if (c) ordered2.push(c);
          else if (allFetched2.length > 0) { ordered2.push(allFetched2[bfIdx % allFetched2.length]); bfIdx++; }
        }

        if (ordered2.length > 0) {
          pipe.current.stockVideos = ordered2;
          setPipeStockVideos(ordered2);
          setExcludedClipIds(new Set());
          setStep("fetchStock", "done", `ได้ ${ordered2.length} คลิป (LLM ranked)`);
          fetch("/api/stocks").then(r => r.json()).then(d => { if (d.count !== undefined) setStockCacheInfo(d); }).catch(() => {});
        } else {
          setStep("fetchStock", "done", "ไม่พบ stock");
        }
      }

      // keywords/tts/transcribe re-runs stop after transcribe — user must review captions then hit Generate
      if (step === "keywords") {
        kws = await runKeywords();
        if (isDirectMode) {
          voice = avatarDirectUrl.trim();
          pipe.current.voiceUrl = voice;
          setStep("tts", "skip", "ข้าม (Direct URL mode)");
        } else {
          voice = await runTts();
        }
        if (abortRef.current) throw new Error("__ABORTED__");
        const { sceneCaptions: sc1 } = await runTranscribe(voice);
        setEditedSceneCaptions(sc1);
        await rerunPerSubtitleStock(sc1);
        toast.success("เสร็จ — ตรวจสอบซับแล้วกด Generate Video");
      } else if (step === "fetchStock") {
        // Re-fetch stock for current captions with LLM ranking
        const caps = editedSceneCaptions.length > 0 ? editedSceneCaptions : (pipe.current.sceneCaptions ?? []);
        if (caps.length > 0) {
          await rerunPerSubtitleStock(caps);
        } else {
          // No captions yet — fall back to scene-based stock
          if (!kws.length) kws = await runKeywords();
          stocks = await runFetchStock(kws);
        }
        stocks = getActiveStocks();
        cfg = await runConfig(stocks, voice, durMs, scCaps, false);
        const url1 = await runRender(cfg);
        if (!useAvatar) { await saveToGallery(url1); toast.success("เสร็จแล้ว!"); }
        else toast.success("Render เสร็จ — เช็คตำแหน่ง Avatar แล้วกด 'สร้าง Avatar'");
      } else if (step === "tts") {
        if (isDirectMode) {
          voice = avatarDirectUrl.trim();
          pipe.current.voiceUrl = voice;
          setStep("tts", "skip", "ข้าม (Direct URL mode)");
        } else {
          voice = await runTts();
        }
        if (abortRef.current) throw new Error("__ABORTED__");
        const { sceneCaptions: sc2 } = await runTranscribe(voice);
        setEditedSceneCaptions(sc2);
        await rerunPerSubtitleStock(sc2);
        toast.success("เสร็จ — ตรวจสอบซับแล้วกด Generate Video");
      } else if (step === "transcribe") {
        const { sceneCaptions: sc3 } = await runTranscribe(voice);
        setEditedSceneCaptions(sc3);
        await rerunPerSubtitleStock(sc3);
        toast.success("เสร็จ — ตรวจสอบซับแล้วกด Generate Video");
      } else if (step === "config") {
        cfg = await runConfig(stocks, voice, durMs, scCaps, false);
        const url2 = await runRender(cfg);
        if (!useAvatar) { await saveToGallery(url2); toast.success("เสร็จแล้ว!"); }
        else toast.success("Render เสร็จ — เช็คตำแหน่ง Avatar แล้วกด 'สร้าง Avatar'");
      } else if (step === "render") {
        const url3 = await runRender(cfg);
        if (!useAvatar) { await saveToGallery(url3); toast.success("เสร็จแล้ว!"); }
        else toast.success("Render เสร็จ — เช็คตำแหน่ง Avatar แล้วกด 'สร้าง Avatar'");
      } else if (step === "avatar") {
        const avUrl = await runAvatar(voice);
        const composited = await runComposite(rendered, avUrl);
        setVideoUrl(composited);
          toast.success("เสร็จแล้ว!");
      } else if (step === "composite") {
        if (!avatarGreenUrl) throw new Error("ยังไม่มี Avatar — ต้อง run avatar ก่อน");
        const composited = await runComposite(rendered, avatarGreenUrl);
        setVideoUrl(composited);
          toast.success("เสร็จแล้ว!");
      }
    } catch (err) {
      if ((err instanceof Error && err.message === "__ABORTED__") || (err instanceof Error && err.name === "AbortError")) {
        toast("หยุดการทำงานแล้ว");
        markError("ยกเลิกโดยผู้ใช้");
      } else if (!handleMissingKey(err, step)) {
        const msg = friendlyError(err);
        toast.error(msg);
        markError(msg);
      }
    } finally {
      abortRef.current = false;
      abortControllerRef.current = null;
      setRunning(false);
    }
  }

  // Sync mutable refs so debounced callbacks always use fresh values
  rerunFromRef.current = rerunFrom;
  runningRef.current = running;

  const isDirectMode = avatarInputMode === "direct" && !!avatarDirectUrl.trim();
  const isVideoOnly = !useAvatar;
  const STEP_ORDER: (keyof StepState)[] = ["keywords","tts","transcribe","fetchStock","config","render","avatar","composite"]
    .filter(k => {
      if (isVideoOnly && (k === "avatar" || k === "composite")) return false;
      if (!isVideoOnly && isDirectMode && k === "avatar") return false;
      return true;
    }) as (keyof StepState)[];
  const STEP_DISPLAY: Record<keyof StepState, string> = {
    keywords: "Extract Keywords (LLM)",
    fetchStock: "Pexels Asset Fetch",
    tts: "TTS Gen",
    transcribe: "Whisper Transcribe",
    config: "Build Render Config",
    render: "Remotion Render Engine",
    avatar: "HeyGen API Process",
    composite: "FFMPEG Composite",
  };

  if (plan !== "PRO") return null; // LOADING หรือ FREE — ไม่ render อะไรเลย ไม่มีแวบ

  return (
    <DashboardLayout noPadding>
      {missingKey && (
        <ApiKeyModal
          keyType={missingKey.type}
          onClose={() => {
            setMissingKey(null);
            abortRef.current = true;
            abortControllerRef.current?.abort();
            setRunning(false);
            markError("ยกเลิกโดยผู้ใช้");
          }}
          onSaved={() => {
            const step = missingKey.retryStep;
            setMissingKey(null);
            if (step === "runAll") runAll();
            else if (step === "runGenerate") runGenerate();
            else if (step === "runAvatarPipeline") runAvatarPipeline();
            else rerunFromRef.current(step as keyof StepState);
          }}
        />
      )}

      {showClearCacheDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)" }}
          onClick={e => { if (e.target === e.currentTarget) setShowClearCacheDialog(false); }}>
          <div className="w-full max-w-sm rounded-2xl overflow-hidden shadow-2xl"
            style={{ background: "hsl(221 39% 9%)", border: "1px solid hsl(220 30% 18%)" }}>
            <div className="px-5 py-4" style={{ borderBottom: "1px solid hsl(220 30% 14%)" }}>
              <h3 className="text-base font-semibold text-white">⚠️ พบปัญหา: ข้อมูลหายจาก Cache</h3>
            </div>
            <div className="px-5 py-4 space-y-3">
              <p className="text-sm" style={{ color: "hsl(220 15% 65%)" }}>
                ข้อมูล Keywords หายไปจาก cache ของเบราว์เซอร์ กรุณาลองทำตามขั้นตอนนี้:
              </p>
              <ol className="text-sm space-y-1 list-decimal list-inside" style={{ color: "hsl(220 15% 75%)" }}>
                <li>กดปุ่ม <strong className="text-white">ล้าง Cache</strong> ด้านล่าง</li>
                <li>กด <strong className="text-white">Run</strong> ใหม่ตั้งแต่ต้น</li>
              </ol>
            </div>
            <div className="px-5 py-4 flex gap-3" style={{ borderTop: "1px solid hsl(220 30% 14%)" }}>
              <button
                className="flex-1 rounded-lg py-2 text-sm font-medium"
                style={{ background: "hsl(220 30% 18%)", color: "hsl(220 15% 65%)" }}
                onClick={() => setShowClearCacheDialog(false)}>
                ปิด
              </button>
              <button
                className="flex-1 rounded-lg py-2 text-sm font-semibold text-white"
                style={{ background: "hsl(14 90% 55%)" }}
                onClick={async () => {
                  setShowClearCacheDialog(false);
                  try {
                    await fetch("/api/stocks", { method: "DELETE" });
                  } catch {}
                  pipe.current = {};
                  toast.success("ล้าง Cache แล้ว — กด Run ได้เลย");
                }}>
                ล้าง Cache แล้วรันใหม่
              </button>
            </div>
          </div>
        </div>
      )}

      {showLLMPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)" }}
          onClick={e => { if (e.target === e.currentTarget) setShowLLMPicker(false); }}>
          <div className="w-full max-w-sm rounded-2xl overflow-hidden shadow-2xl"
            style={{ background: "hsl(221 39% 9%)", border: "1px solid hsl(220 30% 18%)" }}>
            <div className="px-5 py-4" style={{ borderBottom: "1px solid hsl(220 30% 14%)" }}>
              <p className="text-sm font-bold text-white">เลือก AI Provider</p>
              <p className="text-[11px] text-white/40 mt-0.5">ต้องมี API Key อย่างน้อย 1 ตัวเพื่อใช้งาน pipeline</p>
            </div>
            <div className="p-5 space-y-3">
              <button
                onClick={() => { setShowLLMPicker(false); setMissingKey({ type: "gemini", retryStep: "runAll" }); }}
                className="w-full flex items-center gap-3 rounded-xl px-4 py-3 text-left transition-all hover:opacity-90"
                style={{ background: "hsl(190 100% 50% / 0.08)", border: "1px solid hsl(190 100% 50% / 0.25)" }}>
                <div className="flex h-8 w-8 items-center justify-center rounded-lg flex-shrink-0"
                  style={{ background: "hsl(190 100% 50% / 0.15)" }}>
                  <span className="text-base">✦</span>
                </div>
                <div>
                  <p className="text-sm font-bold text-white">Gemini</p>
                  <p className="text-[10px] text-white/40">Google AI · ฟรี · แนะนำ</p>
                </div>
              </button>
              <button
                onClick={() => { setShowLLMPicker(false); setMissingKey({ type: "openai", retryStep: "runAll" }); }}
                className="w-full flex items-center gap-3 rounded-xl px-4 py-3 text-left transition-all hover:opacity-90"
                style={{ background: "hsl(140 60% 50% / 0.06)", border: "1px solid hsl(140 60% 50% / 0.2)" }}>
                <div className="flex h-8 w-8 items-center justify-center rounded-lg flex-shrink-0"
                  style={{ background: "hsl(140 60% 50% / 0.12)" }}>
                  <span className="text-base">⊹</span>
                </div>
                <div>
                  <p className="text-sm font-bold text-white">OpenAI</p>
                  <p className="text-[10px] text-white/40">GPT-4o-mini · ต้องชำระเงิน</p>
                </div>
              </button>
              <button onClick={() => setShowLLMPicker(false)}
                className="w-full rounded-xl py-2 text-sm text-white/30 hover:text-white/60 transition-colors">
                ยกเลิก
              </button>
            </div>
          </div>
        </div>
      )}
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;700;800&family=Kanit:wght@700;900&family=Prompt:wght@600;700&family=Mitr:wght@400;600&family=Noto+Sans+Thai:wght@400;700;900&family=K2D:wght@400;700;800&family=Charm:wght@400;700&family=IBM+Plex+Sans+Thai:wght@400;600;700&family=Bai+Jamjuree:wght@600;700&family=Krub:wght@600;700&family=Pridi:wght@600;700&family=Chonburi&family=Itim&display=swap" />

      <div className="sv-dark flex h-full overflow-hidden sv-bg">
        <div className="flex-1 overflow-y-auto px-5 pt-4 pb-8 space-y-4">

          {/* ── Page header ── */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: "linear-gradient(135deg, hsl(190 100% 40% / 0.2), hsl(230 100% 55% / 0.15))", border: "1px solid hsl(190 100% 50% / 0.2)" }}>
                <Video className="h-4 w-4 text-cyan-400" />
              </div>
              <div>
                <h1 className="text-base font-bold text-white leading-none">Short Video</h1>
                <p className="text-[10px] text-white/30 mt-0.5">AI-powered pipeline · TTS + Stock + Avatar + Subtitles</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {running && (
                <div className="flex items-center gap-1.5 rounded-full px-3 py-1" style={{ background: "hsl(190 100% 50% / 0.08)", border: "1px solid hsl(190 100% 50% / 0.2)" }}>
                  <Loader2 className="h-3 w-3 animate-spin text-cyan-400" />
                  <span className="text-[10px] font-semibold text-cyan-400">Running...</span>
                </div>
              )}
              {preRenderUrl && !running && (
                <div className="flex items-center gap-1.5 rounded-full px-3 py-1" style={{ background: "hsl(142 72% 29% / 0.15)", border: "1px solid hsl(142 72% 29% / 0.3)" }}>
                  <CheckCircle2 className="h-3 w-3 text-green-400" />
                  <span className="text-[10px] font-semibold text-green-400">Ready</span>
                </div>
              )}
            </div>
          </div>

          {/* ── All inputs: 2-column layout ── */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-stretch">

            {/* LEFT column: Content + ElevenLabs */}
            <div className="flex flex-col gap-4">

              {/* 1 — Content */}
              <div className="rounded-2xl overflow-hidden" style={{ background: "var(--sv-card)", border: "1px solid var(--sv-border)" }}>
                <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: "1px solid var(--sv-border)" }}>
                  <h2 className="flex items-center gap-2 text-sm font-bold text-white">
                    <FileText className="h-4 w-4 text-cyan-400" />Script
                  </h2>
                </div>
                <div className="p-4 space-y-2">
                  <Textarea value={script} onChange={e => setScript(e.target.value)}
                    placeholder={"ป้อนบทภาษาไทยที่นี่..."}
                    rows={9}
                    className="resize-none text-sm text-white placeholder:text-white/20 border-0 focus-visible:ring-0"
                    style={{ background: "var(--sv-card2)", borderRadius: "0.75rem", border: "1px solid var(--sv-border)" }}
                  />
                </div>
              </div>

              {/* 1.5 — Stock Source */}
              <div className="rounded-2xl overflow-hidden" style={{ background: "var(--sv-card)", border: "1px solid var(--sv-border)" }}>
                <div className="flex items-center justify-between gap-2 px-5 py-3" style={{ borderBottom: "1px solid var(--sv-border)" }}>
                  <div className="flex items-center gap-2">
                    <Film className="h-4 w-4 text-cyan-400" />
                    <h2 className="text-sm font-bold text-white">Stock Source</h2>
                  </div>
                  <span className="text-[9px] font-semibold uppercase tracking-wider text-white/25">
                    {stockSource === "both" ? "Pexels + Pixabay" : stockSource === "pexels" ? "Pexels only" : "Pixabay only"}
                  </span>
                </div>
                <div className="p-3">
                  <div className="flex gap-1 p-1 rounded-xl" style={{ background: "var(--sv-input)" }}>
                    {(["pexels","pixabay","both"] as const).map((v) => (
                      <button
                        key={v}
                        onClick={() => setStockSource(v)}
                        disabled={running}
                        className="flex-1 py-1.5 rounded-lg text-[11px] font-bold transition-all disabled:opacity-40"
                        style={
                          stockSource === v
                            ? { background: "hsl(190 100% 50% / 0.15)", color: "hsl(190 100% 70%)", border: "1px solid hsl(190 100% 50% / 0.3)" }
                            : { color: "rgba(255,255,255,0.3)", border: "1px solid transparent" }
                        }
                      >
                        {v === "both" ? "Both" : v === "pexels" ? "Pexels" : "Pixabay"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* 2 — Voice Model */}
              <div className="rounded-2xl overflow-hidden relative" style={{ background: "var(--sv-card)", border: "1px solid var(--sv-border)" }}>
                <div className="flex items-center gap-2 px-5 py-3.5" style={{ borderBottom: "1px solid var(--sv-border)" }}>
                  <Mic className="h-4 w-4 text-cyan-400" />
                  <h2 className="text-sm font-bold text-white">Voice Model</h2>
                </div>
                <div className="p-4 space-y-3">
                  {/* Provider toggle */}
                  <div className="flex gap-1 p-1 rounded-xl" style={{ background: "var(--sv-input)" }}>
                    {(["elevenlabs", "gemini"] as const).map(p => (
                      <button key={p} onClick={() => handleSetTtsProvider(p)}
                        className="flex-1 py-1.5 rounded-lg text-[11px] font-bold transition-all"
                        style={ttsProvider === p
                          ? { background: "hsl(190 100% 50% / 0.15)", color: "hsl(190 100% 70%)", border: "1px solid hsl(190 100% 50% / 0.3)" }
                          : { color: "rgba(255,255,255,0.3)", border: "1px solid transparent" }}>
                        {p === "elevenlabs" ? "ElevenLabs" : "Google Gemini"}
                      </button>
                    ))}
                  </div>

                  {/* ElevenLabs: Voice ID input */}
                  {ttsProvider === "elevenlabs" && (
                    <>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-white/30">Voice ID</p>
                      <Input value={voiceId} onChange={e => handleSetVoiceId(e.target.value)} placeholder="e.g. 9lvkfodgodpjgdf"
                        className="text-sm text-white font-mono border-0 focus-visible:ring-0 h-10"
                        style={{ background: "var(--sv-input)", border: "1px solid var(--sv-border2)" }}
                      />
                      <div className="rounded-lg px-3 py-2.5 flex items-center gap-3" style={{ background: "hsl(190 100% 50% / 0.05)", border: "1px solid hsl(190 100% 50% / 0.15)" }}>
                        <Mic className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
                        <p className="text-[11px] text-white/40 font-mono flex-1">{voiceId || "— ยังไม่ได้ใส่ Voice ID"}</p>
                        <button
                          disabled={!voiceId.trim() || voicePreviewLoading}
                          onClick={async () => {
                            setVoicePreviewLoading(true);
                            try {
                              const res = await fetch("/api/videos/tts", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ text: "สวัสดีครับ นี่คือตัวอย่างเสียง", voiceId }),
                              });
                              const data = await res.json();
                              if (res.ok) {
                                const url = data.voiceUrl ?? data.url ?? data.audioUrl;
                                if (url) new Audio(url.startsWith("http") ? url : `${window.location.origin}${url}`).play();
                              } else {
                                const keyType = detectMissingKeyType(data);
                                if (keyType) { setMissingKey({ type: keyType, retryStep: "tts" }); }
                                else toast.error(data.error ?? "Preview voice ไม่สำเร็จ");
                              }
                            } catch { toast.error("Preview voice ไม่สำเร็จ"); }
                            finally { setVoicePreviewLoading(false); }
                          }}
                          className="flex items-center gap-1 text-[9px] font-bold text-cyan-400/70 hover:text-cyan-300 disabled:opacity-30 transition-colors shrink-0">
                          {voicePreviewLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                          Preview
                        </button>
                      </div>
                    </>
                  )}

                  {/* Gemini: voice dropdown */}
                  {ttsProvider === "gemini" && (
                    <>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-white/30">Gemini Voice</p>
                      <div className="relative">
                        <select
                          value={geminiVoiceName}
                          onChange={e => handleSetGeminiVoiceName(e.target.value)}
                          className="w-full h-10 px-3 pr-8 rounded-lg text-sm text-white font-medium appearance-none cursor-pointer"
                          style={{ background: "var(--sv-input)", border: "1px solid var(--sv-border2)", outline: "none" }}>
                          {GEMINI_VOICES.map(v => (
                            <option key={v.id} value={v.id} style={{ background: "#1a1a2e" }}>
                              {v.label} — {v.gender}, {v.style}
                            </option>
                          ))}
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-white/40" />
                      </div>
                      {/* Selected voice info + preview */}
                      {(() => {
                        const v = GEMINI_VOICES.find(x => x.id === geminiVoiceName);
                        return v ? (
                          <div className="rounded-lg px-3 py-2.5 flex items-center gap-3" style={{ background: "hsl(190 100% 50% / 0.05)", border: "1px solid hsl(190 100% 50% / 0.15)" }}>
                            <Mic className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-[11px] font-bold text-white/70">{v.label}</p>
                              <p className="text-[9px] text-white/30">{v.gender} · {v.style}</p>
                            </div>
                            <button
                              disabled={voicePreviewLoading}
                              onClick={async () => {
                                setVoicePreviewLoading(true);
                                try {
                                  const res = await fetch("/api/videos/tts-gemini", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ text: "สวัสดีครับ นี่คือตัวอย่างเสียง", voiceName: geminiVoiceName }),
                                  });
                                  const data = await res.json();
                                  if (res.ok) {
                                    const url = data.voiceUrl;
                                    if (url) new Audio(url.startsWith("http") ? url : `${window.location.origin}${url}`).play();
                                  } else {
                                    const keyType = detectMissingKeyType(data);
                                    if (keyType) { setMissingKey({ type: keyType, retryStep: "tts" }); }
                                    else toast.error(data.error ?? "Preview voice ไม่สำเร็จ");
                                  }
                                } catch { toast.error("Preview voice ไม่สำเร็จ"); }
                                finally { setVoicePreviewLoading(false); }
                              }}
                              className="flex items-center gap-1 text-[9px] font-bold text-cyan-400/70 hover:text-cyan-300 disabled:opacity-30 transition-colors shrink-0">
                              {voicePreviewLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                              Preview
                            </button>
                          </div>
                        ) : null;
                      })()}
                    </>
                  )}

                {/* Disabled overlay when Direct URL avatar mode is active */}
                {avatarInputMode === "direct" && avatarDirectUrl.trim() && (
                  <div className="absolute inset-0 rounded-2xl flex flex-col items-center justify-center gap-1.5 cursor-not-allowed"
                    style={{ background: "var(--sv-card)", border: "1px solid var(--sv-border2)" }}>
                    <Mic className="h-5 w-5 text-white/15" />
                    <p className="text-[11px] font-bold text-white/25">ปิด — Direct URL Mode</p>
                    <p className="text-[9px] text-white/15">ใช้เสียงจาก Avatar Video</p>
                  </div>
                )}
                </div>
              </div>

              {/* 3 — Subtitle Style */}
              <div className="rounded-2xl overflow-hidden" style={{ background: "var(--sv-card)", border: "1px solid var(--sv-border)" }}>
                {/* Header */}
                <div className="flex items-center gap-2 px-5 py-3.5" style={{ borderBottom: "1px solid var(--sv-border)" }}>
                  <Captions className="h-4 w-4 text-cyan-400" />
                  <h2 className="text-sm font-bold text-white">Subtitle Style</h2>
                </div>

                {/* Two-column body: controls left, preview right */}
                <div className="flex gap-0">

                  {/* Controls */}
                  <div className="flex-1 p-5 space-y-4 min-w-0">

                    {/* Style Preset */}
                    <div className="space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-widest text-white/40">สไตล์</p>
                      <div className="grid grid-cols-4 gap-1.5">
                        {([
                          { value: "stroke",       label: "Stroke",   desc: "ขอบดำ" },
                          { value: "plain",        label: "Plain",    desc: "ไม่มีขอบ" },
                          { value: "shadow",       label: "Shadow",   desc: "เงา" },
                          { value: "box",          label: "Box",      desc: "กล่องดำ" },
                          { value: "box-rounded",  label: "Pill",     desc: "กล่องมน" },
                          { value: "glow",         label: "Glow",     desc: "เรืองแสง" },
                          { value: "outline-only", label: "Outline",  desc: "เส้นขอบ" },
                          { value: "karaoke",      label: "Karaoke",  desc: "บรรทัดล่าง" },
                        ] as const).map(s => (
                          <button key={s.value} onClick={() => setSubStylePreset(s.value)}
                            className="flex flex-col items-center gap-1 rounded-xl py-2.5 px-1 transition-all"
                            style={subStylePreset === s.value
                              ? { background: "hsl(190 100% 50% / 0.12)", border: "1px solid hsl(190 100% 50% / 0.5)", color: "hsl(190 100% 65%)" }
                              : { background: "var(--sv-card2)", border: "1px solid var(--sv-border)", color: "color-mix(in srgb, var(--sv-text) 60%, transparent)" }
                            }>
                            <span className="text-[11px] font-bold">{s.label}</span>
                            <span className="text-[9px] opacity-50">{s.desc}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Font + Weight — same row */}
                    <div className="space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-widest text-white/40">Font</p>
                      <select value={subFontFamily} onChange={e => setSubFontFamily(e.target.value)}
                        className="w-full rounded-xl px-3 py-2.5 text-sm text-white outline-none cursor-pointer"
                        style={{ background: "var(--sv-card2)", border: "1px solid var(--sv-border)", fontFamily: subFontFamily }}>
                        {[
                          { label: "Kanit — หนา ชัด",           value: "'Kanit', sans-serif" },
                          { label: "Sarabun — อ่านง่าย",        value: "'Sarabun', sans-serif" },
                          { label: "Prompt — โมเดิร์น",         value: "'Prompt', sans-serif" },
                          { label: "Mitr — TikTok",              value: "'Mitr', sans-serif" },
                          { label: "Noto Sans Thai",             value: "'Noto Sans Thai', sans-serif" },
                          { label: "K2D — กลม น่ารัก",          value: "'K2D', sans-serif" },
                          { label: "Bai Jamjuree — คมชัด",      value: "'Bai Jamjuree', sans-serif" },
                          { label: "Krub — เรียบร้อย",           value: "'Krub', sans-serif" },
                          { label: "Pridi — สง่างาม",            value: "'Pridi', serif" },
                          { label: "Chonburi — ตัวหนา display",  value: "'Chonburi', sans-serif" },
                          { label: "Itim — น่ารัก ลายมือ",       value: "'Itim', cursive" },
                          { label: "IBM Plex Sans Thai",         value: "'IBM Plex Sans Thai', sans-serif" },
                        ].map(f => <option key={f.value} value={f.value} style={{ fontFamily: f.value }}>{f.label}</option>)}
                      </select>
                    </div>

                    {/* Font Weight */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-semibold uppercase tracking-widest text-white/40">น้ำหนัก</p>
                        <span className="text-xs font-mono text-cyan-400">{subFontWeight}</span>
                      </div>
                      <div className="flex gap-1">
                        {([300,400,500,600,700,800,900] as const).map(w => (
                          <button key={w} onClick={() => setSubFontWeight(w)}
                            className="flex-1 rounded-lg py-1.5 text-[11px] font-bold transition-all"
                            style={subFontWeight === w
                              ? { background: "hsl(190 100% 50% / 0.15)", color: "hsl(190 100% 65%)", border: "1px solid hsl(190 100% 50% / 0.45)" }
                              : { background: "var(--sv-card2)", color: "color-mix(in srgb, var(--sv-text) 55%, transparent)", border: "1px solid var(--sv-border)" }
                            }>{w}</button>
                        ))}
                      </div>
                    </div>

                    {/* Colors */}
                    {([
                      { label: "สีตัวอักษร", val: subColor, set: setSubColor },
                      { label: "สีไฮไลท์", val: subAccentColor, set: setSubAccentColor },
                    ] as const).map(({ label, val, set }) => (
                      <div key={label} className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-semibold uppercase tracking-widest text-white/40">{label}</p>
                          <span className="text-xs font-mono font-bold" style={{ color: val }}>{val}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          {["#FFFFFF","#FFE500","#FF4444","#00CFFF","#FF9500","#00FF87","#FF00FF","#000000"].map(c => (
                            <button key={c} onClick={() => set(c)}
                              className="rounded-lg transition-all shrink-0"
                              style={{
                                width: 26, height: 26,
                                background: c,
                                border: val === c ? "2px solid hsl(190 100% 60%)" : "2px solid transparent",
                                boxShadow: val === c ? "0 0 0 1px hsl(190 100% 60% / 0.5)" : "inset 0 0 0 1px rgba(255,255,255,0.1)",
                                outline: "none",
                              }} />
                          ))}
                          <label className="relative flex items-center cursor-pointer shrink-0">
                            <input type="color" value={val} onChange={e => set(e.target.value)}
                              className="absolute opacity-0 w-0 h-0" />
                            <span className="flex items-center justify-center rounded-lg text-xs font-bold text-white/50"
                              style={{ width: 26, height: 26, background: "var(--sv-input)", border: "1.5px dashed rgba(255,255,255,0.2)" }}>
                              +
                            </span>
                          </label>
                        </div>
                      </div>
                    ))}

                    {/* Size + Position */}
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-semibold uppercase tracking-widest text-white/40">ขนาด</p>
                          <span className="text-xs font-mono text-cyan-400">{subFontSize}px</span>
                        </div>
                        <Slider value={[subFontSize]} onValueChange={([v]) => setSubFontSize(v)} min={40} max={120} step={2} />
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-semibold uppercase tracking-widest text-white/40">ตำแหน่ง</p>
                          <span className="text-xs font-mono text-cyan-400">{subPosition}%</span>
                        </div>
                        <Slider value={[subPosition]} onValueChange={([v]) => setSubPosition(v)} min={10} max={92} step={1} />
                      </div>
                    </div>

                  </div>

                  {/* 9:16 preview panel — wider for legible subtitle */}
                  <div className="shrink-0 flex flex-col items-center justify-start gap-3 border-l p-4"
                    style={{ borderColor: "var(--sv-border)", width: 180 }}>
                    <p className="text-xs font-semibold uppercase tracking-widest text-white/30 self-start">Preview</p>

                    {/* Mock phone frame */}
                    <div className="relative rounded-2xl overflow-hidden cursor-pointer group/prev"
                      style={{ width: 152, aspectRatio: "9/16", background: "#000", border: "2px solid hsl(220 30% 20%)", boxShadow: "0 8px 32px rgba(0,0,0,0.5)" }}
                    >
                      {(preRenderUrl) ? (
                        <video src={preRenderUrl} className="absolute inset-0 w-full h-full object-cover" muted playsInline />
                      ) : (
                        <>
                          <div className="absolute inset-0" style={{ background: "linear-gradient(160deg, #0a1628 0%, #060d1a 40%, #020408 100%)" }} />
                          {/* Fake content blocks */}
                          <div className="absolute top-[15%] left-3 right-3 h-1.5 rounded-full opacity-10" style={{ background: "white" }} />
                          <div className="absolute top-[20%] left-5 right-8 h-1.5 rounded-full opacity-7" style={{ background: "white" }} />
                          <div className="absolute inset-x-0 bottom-0 h-1/3" style={{ background: "linear-gradient(to top, rgba(0,0,0,0.5), transparent)" }} />
                        </>
                      )}
                      {/* Subtitle preview — hook / body / cta at exact position */}
                      {(() => {
                        const previewW = 152;
                        const previewH = previewW * 16 / 9;
                        const scale = previewW / 1080;
                        const lineH = Math.round(subFontSize * scale * 1.4);
                        // Show 3 lines stacked at subPosition: hook, body, cta
                        const labels: { text: string; isAccent: boolean; tag: string }[] = [
                          { text: "Mew Social",       isAccent: false, tag: "hook" },
                          { text: "สร้างคอนเทนต์ง่ายๆ", isAccent: false, tag: "body" },
                          { text: "กดติดตาม",           isAccent: true,  tag: "cta"  },
                        ];
                        const totalH = lineH * labels.length;
                        const topPx = (subPosition / 100) * previewH - totalH / 2;
                        return labels.map((l, i) => (
                          <div key={l.tag} className="absolute left-0 right-0 flex justify-center px-1.5 pointer-events-none"
                            style={{ top: topPx + i * lineH, height: lineH, alignItems: "center", display: "flex" }}>
                            {renderSubEl(l.text, subColor, subAccentColor, l.isAccent, subStylePreset, subFontFamily, subFontSize, subFontWeight, scale)}
                          </div>
                        ));
                      })()}
                      {/* Position guide line */}
                      <div className="absolute left-2 right-2 pointer-events-none"
                        style={{ top: `${subPosition}%`, height: 1, background: "rgba(99,179,237,0.3)", borderRadius: 1 }} />
                      {/* Play overlay on hover */}
                      {(preRenderUrl) && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover/prev:opacity-100 transition-opacity">
                          <div className="flex h-9 w-9 items-center justify-center rounded-full"
                            style={{ background: "hsl(190 100% 50% / 0.25)", border: "1.5px solid hsl(190 100% 50% / 0.6)" }}>
                            <Play className="h-4 w-4 fill-white ml-0.5" />
                          </div>
                        </div>
                      )}
                    </div>                  
                    {/* Color dots legend */}
                    <div className="flex gap-3 items-center">
                      <div className="flex items-center gap-1.5">
                        <div className="w-2.5 h-2.5 rounded-full ring-1 ring-white/10" style={{ background: subColor }} />
                        <span className="text-[10px] text-white/35">หลัก</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className="w-2.5 h-2.5 rounded-full ring-1 ring-white/10" style={{ background: subAccentColor }} />
                        <span className="text-[10px] text-white/35">ไฮไลท์</span>
                      </div>
                    </div>
                  </div>

                </div>
              </div>
            </div>

            {/* RIGHT column: Avatar + Subtitle */}
            <div className="flex flex-col gap-4 h-full">

              {/* 4 — Avatar */}
              <div className="rounded-2xl overflow-hidden flex-1" style={{
                background: "var(--sv-card)",
                border: `1px solid ${useAvatar ? "var(--sv-border)" : "var(--sv-border)"}`,
              }}>
                {/* Header row — mode switcher */}
                <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: "1px solid var(--sv-border)" }}>
                  <h2 className="flex items-center gap-2 text-sm font-bold text-white">
                    <User className={cn("h-4 w-4", useAvatar ? "text-cyan-400" : "text-white/25")} />
                    <span className={useAvatar ? "text-white" : "text-white/40"}>Avatar</span>
                    {!useAvatar && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide"
                        style={{ background: "var(--sv-input)", color: "hsl(220 30% 40%)" }}>
                        off
                      </span>
                    )}
                  </h2>
                  {/* Mode switcher: Video Only ↔ Avatar Overlay */}
                  <div className="flex gap-1 rounded-lg p-0.5" style={{ background: "var(--sv-card2)", border: "1px solid var(--sv-border)" }}>
                    <button onClick={() => { setUseAvatar(false); setAvatarDirectUrl(""); setAvatarInputMode("generate"); }}
                      className="rounded-md px-3 py-1 text-[10px] font-bold transition-all"
                      style={!useAvatar
                        ? { background: "var(--sv-border2)", color: "hsl(0 0% 80%)" }
                        : { background: "transparent", color: "color-mix(in srgb, var(--sv-text) 45%, transparent)" }}>
                      Video Only
                    </button>
                    <button onClick={() => setUseAvatar(true)}
                      className="rounded-md px-3 py-1 text-[10px] font-bold transition-all"
                      style={useAvatar
                        ? { background: "hsl(190 100% 50% / 0.15)", color: "hsl(190 100% 65%)", border: "1px solid hsl(190 100% 50% / 0.3)" }
                        : { background: "transparent", color: "color-mix(in srgb, var(--sv-text) 45%, transparent)" }}>
                      + Avatar
                    </button>
                  </div>
                </div>
                <div className="p-4 space-y-3">

                {/* Video Only placeholder */}
                {!useAvatar && (
                  <div className="flex flex-col items-center justify-center gap-2 rounded-xl py-6"
                    style={{ background: "var(--sv-card2)", border: "1px dashed var(--sv-border)" }}>
                    <Film className="h-7 w-7 text-white/10" />
                    <p className="text-xs font-semibold text-white/25">Video Only Mode</p>
                    <p className="text-[10px] text-white/15">Pipeline จะ Render วิดีโอโดยไม่ใส่ Avatar</p>
                    <p className="text-[10px] text-white/15">Phase 3 จะถูกข้ามอัตโนมัติ</p>
                  </div>
                )}

                {/* Avatar content — only when enabled */}
                {useAvatar && (<div className="space-y-3">

                {/* Mode toggle: Generate vs Direct URL */}
                <div className="flex gap-1.5 rounded-lg p-1" style={{ background: "var(--sv-input)", border: "1px solid var(--sv-border2)" }}>
                  {(["generate", "direct"] as const).map(mode => (
                    <button key={mode} onClick={() => setAvatarInputMode(mode)}
                      className={cn("flex-1 rounded-md px-3 py-1.5 text-[11px] font-semibold transition-all")}
                      style={avatarInputMode === mode
                        ? { background: "hsl(190 100% 50% / 0.12)", color: "hsl(190 100% 65%)", border: "1px solid hsl(190 100% 50% / 0.3)" }
                        : { background: "transparent", color: "color-mix(in srgb, var(--sv-text) 50%, transparent)", border: "1px solid transparent" }
                      }>
                      {mode === "generate" ? "Generate (HeyGen)" : "Direct URL"}
                    </button>
                  ))}
                </div>

                {avatarInputMode === "generate" ? (
                  <div className="space-y-1.5">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-white/30">Heygen Avatar ID</p>
                    <Input value={avatarId} onChange={e => handleSetAvatarId(e.target.value)} placeholder="ID: josh_lite_2023..."
                      className="text-xs font-mono text-white border-0 focus-visible:ring-0"
                      style={{ background: "var(--sv-input)", border: "1px solid var(--sv-border2)" }} />
                    {(avatarPreviewUrl || avatarName) && (
                      <div className="flex items-center gap-2 rounded-lg px-2.5 py-2" style={{ background: "var(--sv-input)", border: "1px solid var(--sv-border2)" }}>
                        {avatarPreviewUrl && <img src={avatarPreviewUrl} className="h-8 w-8 rounded-md object-cover shrink-0" />}
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-white/80 truncate">{avatarName}</p>
                          <p className="text-[9px] font-bold text-green-400">● VERIFIED STABLE</p>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {/* Step 1: URL / Upload */}
                    <div className="space-y-1.5">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-white/30">Avatar Video URL or Upload</p>
                      <div className="relative flex items-center">
                        <Input value={avatarDirectUrl} onChange={e => { setAvatarDirectUrl(e.target.value); setDirectCompositeUrl(""); }}
                          placeholder="https://... หรือวาง URL วิดีโอ"
                          className="text-xs font-mono text-white border-0 focus-visible:ring-0 pr-7"
                          style={{ background: "var(--sv-input)", border: "1px solid var(--sv-border2)" }} />
                        {avatarDirectUrl && (
                          <button
                            type="button"
                            onClick={() => { setAvatarDirectUrl(""); setDirectCompositeUrl(""); }}
                            className="absolute right-2 flex items-center justify-center rounded-full h-4 w-4 transition-opacity hover:opacity-100 opacity-50"
                            title="ล้างข้อความ">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 text-white/60"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                          </button>
                        )}
                      </div>
                      <label className="flex items-center justify-center gap-2 rounded-lg py-2 cursor-pointer transition-colors"
                        style={{ background: "var(--sv-input)", border: "1px dashed var(--sv-border2)" }}>
                        <input type="file" accept="video/mp4,video/mov,video/webm,.mp4,.mov,.webm" className="hidden"
                          onChange={async (e) => {
                            const f = e.target.files?.[0];
                            if (!f) return;
                            const fd = new FormData();
                            fd.append("file", f);
                            const res = await fetch("/api/videos/upload-avatar", { method: "POST", body: fd });
                            const data = await res.json();
                            if (data.url) { setAvatarDirectUrl(data.url); setDirectCompositeUrl(""); setDirectCompositeUrl(""); }
                          }} />
                        <span className="text-[10px] text-white/35">อัปโหลดไฟล์วิดีโอ (mp4/mov)</span>
                      </label>
                    </div>

                    {/* Preview video */}
                    {avatarDirectUrl.trim() && (
                      <video src={avatarDirectUrl.trim()} controls className="w-full rounded-lg" style={{ maxHeight: 220, background: "#000" }} />
                    )}


                    {/* Composite + Download */}
                    {directCompositeUrl && (
                      <div className="space-y-2">
                        <video src={directCompositeUrl} controls className="w-full rounded-lg" style={{ maxHeight: 300, background: "#000" }} />
                        <a href={directCompositeUrl} download
                          className="flex w-full items-center justify-center gap-1.5 rounded-xl py-2.5 text-xs font-bold text-white"
                          style={{ background: "linear-gradient(135deg, hsl(142 72% 35%), hsl(160 80% 40%))" }}>
                          <Download className="h-3.5 w-3.5" /> Download MP4
                        </a>
                      </div>
                    )}
                  </div>
                )}

                {/* Avatar Timing — only relevant when generating via HeyGen */}
                {avatarInputMode === "generate" && <div className="space-y-2">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-white/30">Avatar Timing</p>
                  <div className="flex gap-2">
                    {(["full", "bookend"] as const).map(mode => (
                      <button key={mode} onClick={() => setAvatarTiming(mode)}
                        className={cn("flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all border-0 outline-none",
                          avatarTiming === mode ? "text-white" : "text-white/35 hover:text-white/60"
                        )}
                        style={avatarTiming === mode
                          ? { background: "hsl(190 100% 50% / 0.12)", border: "1px solid hsl(190 100% 50% / 0.3)" }
                          : { background: "var(--sv-input)", border: "1px solid var(--sv-border2)" }
                        }>
                        {mode === "full" ? "ตลอดคลิป" : "ต้นคลิปเท่านั้น"}
                      </button>
                    ))}
                  </div>
                  {avatarTiming === "bookend" && (
                    <div className="flex items-center gap-3 rounded-lg px-3 py-2.5"
                      style={{ background: "hsl(190 100% 50% / 0.05)", border: "1px solid hsl(190 100% 50% / 0.15)" }}>
                      <span className="text-xs text-white/40 shrink-0">แสดง Avatar</span>
                      <input
                        type="number" min={1} max={30} value={avatarBookendSecs}
                        onChange={e => setAvatarBookendSecs(Math.max(1, Math.min(30, Number(e.target.value))))}
                        className="w-14 rounded-md px-2 py-1 text-sm font-mono text-center text-cyan-400 border-0 outline-none focus:ring-1 focus:ring-cyan-500/40"
                        style={{ background: "var(--sv-card2)" }}
                      />
                      <span className="text-xs text-white/40">วินาทีแรก</span>
                    </div>
                  )}
                </div>}

                <div className="flex gap-4">
                  {/* Canvas (position editor) — generate mode only */}
                  {avatarInputMode === "generate" && <div ref={posCanvasRef} className="relative shrink-0 rounded-lg overflow-hidden cursor-crosshair select-none"
                    style={{ width: 260, aspectRatio: "720/1280", background: "#080e1c", border: "1px solid var(--sv-border2)" }}
                    onMouseDown={(e) => { setIsDragging(true); updatePosFromPointer(e.clientX, e.clientY); }}
                    onMouseMove={(e) => { if (isDragging) updatePosFromPointer(e.clientX, e.clientY); }}
                    onMouseUp={() => setIsDragging(false)} onMouseLeave={() => setIsDragging(false)}
                    onTouchStart={(e) => { setIsDragging(true); updatePosFromPointer(e.touches[0].clientX, e.touches[0].clientY); }}
                    onTouchMove={(e) => { if (isDragging) updatePosFromPointer(e.touches[0].clientX, e.touches[0].clientY); }}
                    onTouchEnd={() => setIsDragging(false)}
                  >
                    {/* Generate mode: grid + labels + avatar preview */}
                    <>
                      {preRenderUrl && <video src={preRenderUrl} className="absolute inset-0 w-full h-full object-cover pointer-events-none" muted loop autoPlay playsInline />}
                      {[25,50,75].map(p => <div key={`gv${p}`} className="absolute top-0 bottom-0 pointer-events-none" style={{ left: `${p}%`, width: 1, background: p===50?"rgba(255,255,255,0.18)":"rgba(255,255,255,0.05)" }} />)}
                      {[25,50,75].map(p => <div key={`gh${p}`} className="absolute left-0 right-0 pointer-events-none" style={{ top: `${p}%`, height: 1, background: p===50?"rgba(255,255,255,0.18)":"rgba(255,255,255,0.05)" }} />)}
                      <div className="absolute top-1.5 left-1.5 bg-black/75 text-[8px] text-white/80 px-1.5 py-1 rounded font-mono pointer-events-none leading-snug">
                        X: {avatarOffsetX.toFixed(2)}<br />Y: {avatarOffsetY.toFixed(2)}<br />SCALE: {avatarScale.toFixed(2)}
                      </div>
                      {avatarPreviewUrl && (
                        <div className="absolute pointer-events-none overflow-hidden" style={{ width: `${avatarScale*62}%`, aspectRatio: "15/16", left: `${50+avatarOffsetX*50}%`, bottom: `${(0.09-avatarOffsetY)*50}%`, transform: "translateX(-50%)", outline: "1px solid rgba(99,179,237,0.4)" }}>
                          <img src={avatarPreviewUrl} draggable={false} className="w-full h-full" style={{ objectFit: "cover", objectPosition: "center 130%" }} />
                        </div>
                      )}
                      {showGreenRef && avatarGreenUrl && <video src={avatarGreenUrl} className="absolute inset-0 w-full h-full object-cover pointer-events-none" style={{ mixBlendMode: "screen", opacity: 0.85 }} muted loop autoPlay playsInline />}
                      <div className="absolute w-2.5 h-2.5 rounded-full border-2 border-cyan-400 bg-cyan-500/50 pointer-events-none" style={{ left: `${50+avatarOffsetX*50}%`, bottom: `${(-0.05-avatarOffsetY)*50}%`, transform: "translate(-50%, 50%)" }} />
                    </>
                  </div>}
                  {/* Sliders — generate mode only */}
                  {avatarInputMode === "generate" && (
                  <div className="flex-1 space-y-3 min-w-0">
                    {([
                      { label: "Offset X", value: avatarOffsetX, onChange: setAvatarOffsetX, min: -2, max: 2, step: 0.01 },
                      { label: "Offset Y", value: avatarOffsetY, onChange: setAvatarOffsetY, min: -2, max: 2, step: 0.01 },
                      { label: "Scale",    value: avatarScale,   onChange: setAvatarScale,   min: 0.1, max: 5.0, step: 0.01 },
                    ] as const).map(({ label, value, onChange, min, max, step }) => (
                      <div key={label} className="space-y-1">
                        <div className="flex justify-between">
                          <p className="text-[10px] font-bold uppercase tracking-widest text-white/30">{label}</p>
                          <span className="text-[10px] font-mono text-cyan-400">{value.toFixed(2)}</span>
                        </div>
                        <Slider value={[value]} onValueChange={([v]) => onChange(v)} min={min} max={max} step={step} />
                      </div>
                    ))}
                    <button onClick={() => { setAvatarOffsetX(0); setAvatarOffsetY(0.13); setAvatarScale(2.02); }}
                      className="flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white/45 transition-colors hover:text-white/70"
                      style={{ background: "var(--sv-input)", border: "1px solid var(--sv-border2)" }}>
                      <RotateCcw className="h-3.5 w-3.5" /> Reset
                    </button>
                  </div>
                  )}
                </div>
              </div>)}{/* end useAvatar */}
                </div>{/* end p-4 */}
              </div>{/* end Avatar card */}

            </div>{/* end RIGHT column */}
          </div>{/* end 2-col grid */}

          {/* ── Execution Pipeline ── */}
          <div className="rounded-2xl overflow-hidden" style={{ background: "var(--sv-card)", border: "1px solid var(--sv-border)" }}>

            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5" style={{ background: "hsl(190 100% 50% / 0.04)", borderBottom: "1px solid var(--sv-border)" }}>
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: "hsl(190 100% 50% / 0.12)", border: "1px solid hsl(190 100% 50% / 0.22)" }}>
                  <Layers className="h-3.5 w-3.5 text-cyan-400" />
                </div>
                <div>
                  <p className="font-bold text-white text-sm leading-none">Execution Pipeline</p>
                  <p className="text-[10px] text-white/30 mt-0.5">กดแต่ละขั้นตอนเพื่อ run หรือ re-run</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {stockCacheInfo && stockCacheInfo.count > 0 && (
                  <button onClick={clearStockCache} disabled={clearingCache}
                    className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-colors disabled:opacity-40"
                    style={{ background: "hsl(0 80% 35% / 0.15)", color: "hsl(0 80% 65%)", border: "1px solid hsl(0 80% 35% / 0.3)" }}
                    title={`ลบ stock cache ${stockCacheInfo.count} ไฟล์`}>
                    {clearingCache ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RotateCcw className="h-3 w-3 mr-1" />}
                    Cache {stockCacheInfo.sizeMb}MB
                  </button>
                )}
                {running && (
                  <button onClick={() => { abortRef.current = true; abortControllerRef.current?.abort(); }}
                    className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-bold text-white transition-all hover:opacity-90 shadow-lg"
                    style={{ background: "linear-gradient(135deg, hsl(0 80% 45%), hsl(20 90% 45%))", boxShadow: "0 4px 16px hsl(0 80% 40% / 0.3)" }}>
                    <Square className="h-3.5 w-3.5 fill-white" />
                    Stop
                  </button>
                )}
                <button onClick={runAll} disabled={running || !script.trim()}
                  className="flex items-center gap-2 rounded-xl px-5 py-2 text-sm font-bold text-white transition-all hover:opacity-90 disabled:opacity-40 shadow-lg"
                  style={{ background: "linear-gradient(135deg, hsl(190 100% 42%), hsl(230 100% 55%))", boxShadow: "0 4px 16px hsl(190 100% 40% / 0.25)" }}>
                  {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  Run All
                </button>
              </div>
            </div>

            {/* Phase rows */}
            <div className="p-3 space-y-1.5">

              {/* Phase 1 — Prepare */}
              <PhaseRow
                phaseNum={1}
                label="Prepare"
                color="cyan"
                steps={[
                  { key: "keywords" as const,   label: "Keywords",  icon: Wand2,     canRun: !!script.trim() },
                  { key: "tts" as const,        label: "TTS Voice", icon: Mic,       canRun: !!script.trim() },
                  { key: "transcribe" as const, label: "Transcribe",icon: Captions,  canRun: !!pipe.current.voiceUrl },
                  { key: "fetchStock" as const, label: "Stock",     icon: Film,      canRun: !!script.trim() },
                ]}
                stepStates={steps}
                running={running}
                onRerun={rerunFrom}
                action={
                  <button onClick={runAll} disabled={running || !script.trim()}
                    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-40 transition-all hover:opacity-90"
                    style={{ background: "linear-gradient(135deg, hsl(190 100% 42%), hsl(230 100% 55%))" }}>
                    {running && ["keywords","tts","transcribe","fetchStock"].includes(Object.entries(steps).find(([,v])=>v==="running")?.[0]??"") ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                    Run
                  </button>
                }
              />

              {/* Phase 2 — Render */}
              <PhaseRow
                phaseNum={2}
                label="Render"
                color="blue"
                steps={[
                  { key: "config", label: "Config", icon: Settings2, canRun: !!pipe.current.captions?.length },
                  { key: "render", label: "Render",  icon: Video,    canRun: !!pipe.current.config },
                ]}
                stepStates={steps}
                running={running}
                onRerun={rerunFrom}
                action={
                  <button onClick={runGenerate} disabled={running || !editedSceneCaptions.length}
                    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-40 transition-all hover:opacity-90"
                    style={{ background: "linear-gradient(135deg, hsl(220 100% 50%), hsl(190 100% 38%))" }}>
                    {running && (steps.config === "running" || steps.render === "running") ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                    Render
                  </button>
                }
              />

              {/* Phase 3 — Avatar + Composite */}
              {useAvatar && (
                <PhaseRow
                  phaseNum={3}
                  label="Avatar"
                  color="purple"
                  steps={[
                    { key: "avatar",    label: "Avatar",    icon: User,   canRun: !!pipe.current.voiceUrl && useAvatar },
                    { key: "composite", label: "Composite", icon: Layers, canRun: !!preRenderUrl && !!avatarGreenUrl },
                  ]}
                  stepStates={steps}
                  running={running}
                  onRerun={rerunFrom}
                  action={
                    <button onClick={runAvatarPipeline} disabled={running || !preRenderUrl}
                      className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-40 transition-all hover:opacity-90"
                      style={{ background: "linear-gradient(135deg, hsl(252 83% 45%), hsl(190 100% 38%))" }}>
                      {running && (steps.avatar === "running" || steps.composite === "running") ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                      Run
                    </button>
                  }
                />
              )}


            </div>
          </div>

          {/* ── Bottom panels ── */}
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">

            {/* Col 1 — Live Status (narrow) */}
            <div className="xl:col-span-3 rounded-2xl overflow-hidden" style={{ background: "var(--sv-card)", border: "1px solid var(--sv-border)" }}>
              <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: "1px solid var(--sv-border)" }}>
                <Settings2 className="h-3.5 w-3.5 text-cyan-400" />
                <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">Live Status</p>
              </div>
              <div className="p-2 space-y-0.5">
              <div className="space-y-0.5">
                {STEP_ORDER.map((key, idx) => {
                  const status = steps[key];
                  const isDone = status === "done";
                  const isErr = status === "error";
                  const isRun = status === "running";

                  return (
                    <div key={key} className="rounded-lg overflow-hidden"
                      style={{ background: status !== "idle" ? "var(--sv-input)" : "transparent" }}>

                      {/* Row header */}
                      <div className="flex items-center gap-2 px-2.5 py-1.5">
                        <div className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[8px] font-bold border",
                          isDone ? "border-green-500/40 bg-green-500/10 text-green-400" :
                          isRun  ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-400" :
                          isErr  ? "border-red-500/40 bg-red-500/10 text-red-400" :
                          "border-white/8 bg-white/4 text-white/20"
                        )}>
                          {isRun ? <Loader2 className="h-2 w-2 animate-spin" /> :
                           isDone ? <CheckCircle2 className="h-2 w-2" /> :
                           isErr  ? "✗" : idx + 1}
                        </div>
                        <p className={cn("flex-1 text-[10px] font-medium",
                          isDone ? "text-white/70" : isRun ? "text-white" : isErr ? "text-red-400" : "text-white/22"
                        )}>{idx + 1}. {STEP_DISPLAY[key]}</p>

                        {isErr && !running && (
                          <button onClick={() => rerunFrom(key)}
                            className="text-[9px] font-bold text-red-400 hover:text-red-300 uppercase shrink-0 px-1.5 py-0.5 rounded"
                            style={{ background: "hsl(0 84% 60% / 0.1)" }}>RETRY</button>
                        )}
                        {isDone && !running && (
                          <button onClick={() => rerunFrom(key)}
                            className="text-[9px] font-bold text-white/25 hover:text-cyan-400 uppercase shrink-0">↺ rerun</button>
                        )}
                      </div>

                      {/* Inline output — always visible when done or error */}
                      {(isDone || isErr) && (
                        <div className="px-2.5 pb-2.5 space-y-2">

                          {/* Error message — friendly, no code */}
                          {isErr && logs[key] && (
                            <div className="rounded-lg px-3 py-2.5 flex items-start gap-2"
                              style={{ background: "hsl(0 84% 60% / 0.08)", border: "1px solid hsl(0 84% 60% / 0.2)" }}>
                              <span className="text-red-400 shrink-0 mt-0.5">⚠</span>
                              <p className="text-xs text-red-300 leading-relaxed flex-1">{logs[key]}</p>
                            </div>
                          )}

                          {/* keywords → tag chips */}
                          {key === "keywords" && keywords.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {keywords.map((kw, i) => (
                                <span key={i} className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase"
                                  style={{ background: "hsl(190 100% 50% / 0.1)", color: "hsl(190 100% 60%)", border: "1px solid hsl(190 100% 50% / 0.2)" }}>
                                  {kw}
                                </span>
                              ))}
                            </div>
                          )}

                          {/* fetchStock → source + clip count + grid clip picker */}
                          {key === "fetchStock" && (
                            <div className="space-y-3">

                              {/* Row 1: Source + clip count inline */}
                              <div className="flex items-center gap-2">
                                {/* Source pills */}
                                <div className="flex gap-1">
                                  {([
                                    { v: "both",    label: "All",     color: "hsl(190 100% 50%)" },
                                    { v: "pexels",  label: "Pexels",  color: "hsl(142 72% 50%)" },
                                    { v: "pixabay", label: "Pixabay", color: "hsl(262 80% 65%)" },
                                  ] as const).map(({ v, label, color }) => (
                                    <button key={v} onClick={() => setStockSource(v)}
                                      className="rounded-lg px-2.5 py-1 text-[10px] font-bold transition-all"
                                      style={stockSource === v
                                        ? { background: `${color}20`, color, border: `1px solid ${color}55` }
                                        : { background: "var(--sv-input)", color: "color-mix(in srgb, var(--sv-text) 45%, transparent)", border: "1px solid var(--sv-border2)" }
                                      }>{label}</button>
                                  ))}
                                </div>
                                <div className="flex-1" />
                                {/* Clip count: Auto badge or number input */}
                                <div className="flex items-center gap-1.5 rounded-lg px-2 py-1"
                                  style={{ background: "var(--sv-input)", border: "1px solid var(--sv-border2)" }}>
                                  <span className="text-[9px] text-white/35 uppercase tracking-widest">คลิป</span>
                                  <select value={targetClipCount}
                                    onChange={e => setTargetClipCount(Number(e.target.value))}
                                    className="bg-transparent text-[10px] font-mono text-cyan-400 outline-none cursor-pointer"
                                    style={{ minWidth: 52 }}>
                                    <option value={0}>Auto{autoClipCount > 0 ? ` (${autoClipCount})` : ""}</option>
                                    {[3,5,8,10,15,20,25,30].map(n => <option key={n} value={n}>{n} คลิป</option>)}
                                  </select>
                                </div>
                              </div>

                              {/* Grid clip picker — video thumbnails */}
                              {pipeStockVideos.length > 0 && (() => {
                                // Filter grid by selected source tab (All/Pexels/Pixabay)
                                const visibleClips = stockSource === "pexels"
                                  ? pipeStockVideos.filter(v => v.pexelsId < 9_000_000)
                                  : stockSource === "pixabay"
                                  ? pipeStockVideos.filter(v => v.pexelsId >= 9_000_000)
                                  : pipeStockVideos;
                                const activeCnt = pipeStockVideos.filter(v => !excludedClipIds.has(v.pexelsId)).length;
                                const limit = targetClipCount > 0 ? targetClipCount : pipeStockVideos.length;
                                const atLimit = targetClipCount > 0 && activeCnt >= targetClipCount;
                                return (
                                  <div className="space-y-2">
                                    {/* Header bar */}
                                    <div className="flex items-center justify-between px-0.5">
                                      <div className="flex items-center gap-2">
                                        <span className="text-xs font-semibold text-white/60">
                                          เลือกแล้ว
                                          <span className="font-mono ml-1" style={{ color: atLimit ? "hsl(45 100% 60%)" : "hsl(190 100% 60%)" }}>
                                            {activeCnt}
                                          </span>
                                          {targetClipCount > 0 && <span className="text-white/30">/{targetClipCount}</span>}
                                        </span>
                                        {atLimit && (
                                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                                            style={{ background: "hsl(45 100% 50% / 0.15)", color: "hsl(45 100% 65%)", border: "1px solid hsl(45 100% 50% / 0.3)" }}>
                                            ครบแล้ว
                                          </span>
                                        )}
                                      </div>
                                      <div className="flex gap-2">
                                        <button
                                          onClick={() => {
                                            // Smart-select per scene:
                                            // pipeStockVideos is ordered by scene (sceneClipCounts windows).
                                            // Within each scene's window, pick the clip whose keyword best matches that scene's text.
                                            const counts = pipe.current.sceneClipCounts ?? [];
                                            const sceneTexts = pipe.current.scenes ?? [];

                                            // Build scene windows with their corresponding scene text
                                            type SceneWindow = { sceneIdx: number; clips: typeof pipeStockVideos };
                                            const sceneWindows: SceneWindow[] = [];
                                            let off = 0;
                                            if (counts.length > 0) {
                                              counts.forEach((cnt, si) => {
                                                sceneWindows.push({ sceneIdx: si, clips: pipeStockVideos.slice(off, off + cnt) });
                                                off += cnt;
                                              });
                                            } else {
                                              // Fallback: no sceneClipCounts → treat all clips as one scene
                                              sceneWindows.push({ sceneIdx: 0, clips: pipeStockVideos });
                                            }

                                            // Score a clip's keyword against its scene text (word overlap)
                                            function scoreClip(clip: typeof pipeStockVideos[0], si: number): number {
                                              const text = (sceneTexts[si] ?? sceneTexts.join(" ")).toLowerCase();
                                              return clip.keyword.toLowerCase().split(/\s+/).filter(w => w && text.includes(w)).length;
                                            }

                                            // From each scene window, rank clips by match score → best first
                                            const rankedWindows = sceneWindows.map(w => ({
                                              ...w,
                                              ranked: [...w.clips].sort((a, b) => scoreClip(b, w.sceneIdx) - scoreClip(a, w.sceneIdx)),
                                            }));

                                            const keep = new Set<number>();

                                            if (limit >= rankedWindows.length) {
                                              rankedWindows.forEach(w => { if (w.ranked[0]) keep.add(w.ranked[0].pexelsId); });
                                              let extra = limit - keep.size;
                                              let pickIdx = 1;
                                              while (extra > 0) {
                                                let added = 0;
                                                for (const w of rankedWindows) {
                                                  if (extra <= 0) break;
                                                  const clip = w.ranked[pickIdx];
                                                  if (clip && !keep.has(clip.pexelsId)) {
                                                    keep.add(clip.pexelsId);
                                                    extra--; added++;
                                                  }
                                                }
                                                if (added === 0) break;
                                                pickIdx++;
                                              }
                                            } else {
                                              const step = rankedWindows.length / limit;
                                              for (let i = 0; i < limit; i++) {
                                                const si = Math.min(Math.round(i * step), rankedWindows.length - 1);
                                                const clip = rankedWindows[si].ranked[0];
                                                if (clip) keep.add(clip.pexelsId);
                                              }
                                            }

                                            setExcludedClipIds(new Set(pipeStockVideos.filter(v => !keep.has(v.pexelsId)).map(v => v.pexelsId)));
                                          }}
                                          className="text-[9px] text-cyan-400/60 hover:text-cyan-400 transition-colors font-medium">
                                          เลือก {limit < pipeStockVideos.length ? `${limit} อัน` : "ทั้งหมด"}
                                        </button>
                                        <button onClick={() => setExcludedClipIds(new Set())}
                                          className="text-[9px] text-white/25 hover:text-white/50 transition-colors">ทั้งหมด</button>
                                        <button onClick={() => setExcludedClipIds(new Set(pipeStockVideos.map(v => v.pexelsId)))}
                                          className="text-[9px] text-white/25 hover:text-white/50 transition-colors">ล้าง</button>
                                      </div>
                                    </div>

                                    {/* 3-col video grid */}
                                    <div className="grid grid-cols-3 gap-1.5 max-h-80 overflow-y-auto pr-0.5">
                                      {visibleClips.map((v, i) => {
                                        const excluded = excludedClipIds.has(v.pexelsId);
                                        const selected = !excluded;
                                        const isPixabay = v.pexelsId >= 9_000_000;
                                        const previewUrl = v.localUrl || v.videoUrl;
                                        // Grey out + disable if at limit and this clip is not selected
                                        const disabled = atLimit && excluded;
                                        return (
                                          <div key={i}
                                            className="relative rounded-xl overflow-hidden cursor-pointer group/clip transition-all"
                                            style={{
                                              aspectRatio: "9/16",
                                              border: selected
                                                ? "2px solid hsl(190 100% 55%)"
                                                : "2px solid hsl(220 30% 18%)",
                                              opacity: disabled ? 0.3 : excluded ? 0.5 : 1,
                                              cursor: disabled ? "not-allowed" : "pointer",
                                            }}
                                            onClick={() => !disabled && toggleClip(v.pexelsId)}
                                          >
                                            {/* Video preview */}
                                            {previewUrl ? (
                                              <video
                                                src={previewUrl}
                                                muted loop playsInline
                                                className="absolute inset-0 w-full h-full object-cover"
                                                onMouseEnter={e => { const el = e.currentTarget as HTMLVideoElement; el.play().catch(() => {}); }}
                                                onMouseLeave={e => { const el = e.currentTarget as HTMLVideoElement; el.pause(); el.currentTime = 0; }}
                                              />
                                            ) : (
                                              <div className="absolute inset-0" style={{ background: "var(--sv-input)" }} />
                                            )}
                                            {/* Dark overlay when not selected */}
                                            {excluded && <div className="absolute inset-0 bg-black/50" />}
                                            {/* Selection checkmark */}
                                            {selected && (
                                              <div className="absolute top-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded-full"
                                                style={{ background: "hsl(190 100% 50%)", boxShadow: "0 0 8px hsl(190 100% 50% / 0.6)" }}>
                                                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                                                  <path d="M2 5l2.5 2.5L8 3" stroke="#000" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                                                </svg>
                                              </div>
                                            )}
                                            {/* Number badge */}
                                            <div className="absolute top-1.5 left-1.5 flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-black"
                                              style={{ background: "rgba(0,0,0,0.65)", color: selected ? "hsl(190 100% 70%)" : "hsl(0 0% 100% / 0.4)" }}>
                                              {i+1}
                                            </div>
                                            {/* Bottom info bar */}
                                            <div className="absolute bottom-0 left-0 right-0 px-1.5 py-1"
                                              style={{ background: "linear-gradient(to top, rgba(0,0,0,0.85), transparent)" }}>
                                              <div className="flex items-center justify-between gap-1">
                                                <span className="text-[8px] font-medium truncate text-white/70">{v.keyword}</span>
                                                <div className="flex items-center gap-1 shrink-0">
                                                  <span className="text-[7px] font-bold px-0.5 rounded"
                                                    style={isPixabay
                                                      ? { background: "hsl(262 80% 40% / 0.8)", color: "hsl(262 80% 80%)" }
                                                      : { background: "hsl(142 72% 25% / 0.8)", color: "hsl(142 72% 65%)" }
                                                    }>{isPixabay ? "B" : "P"}</span>
                                                  <span className="text-[7px] font-mono text-white/40">{v.duration?.toFixed(0)}s</span>
                                                </div>
                                              </div>
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                );
                              })()}
                            </div>
                          )}

                          {/* tts → audio player */}
                          {key === "tts" && ttsUrl && (
                            <audio src={ttsUrl} controls className="w-full h-8"
                              style={{ colorScheme: "dark", filter: "invert(0.85) hue-rotate(180deg)" }} />
                          )}

                          {/* transcribe → log */}
                          {key === "transcribe" && logs.transcribe && (
                            <p className="text-[10px] font-mono text-white/50 rounded px-2 py-1.5"
                              style={{ background: "var(--sv-card2)" }}>{logs.transcribe}</p>
                          )}

                          {/* config → log string */}
                          {key === "config" && logs.config && (
                            <p className="text-[10px] font-mono text-white/50 rounded px-2 py-1.5"
                              style={{ background: "var(--sv-card2)" }}>{logs.config}</p>
                          )}

                          {/* render → mini video + thumbnail generator */}
                          {key === "render" && preRenderUrl && (
                            <div className="space-y-2">
                              <video src={preRenderUrl} controls className="w-full rounded-lg"
                                style={{ maxHeight: 160, aspectRatio: "9/16", display: "block", margin: "0 auto" }} />
                              <div className="flex items-center gap-2">
                              </div>
                            </div>
                          )}

                          {/* avatar → mini video */}
                          {key === "avatar" && avatarGreenUrl && (
                            <video src={avatarGreenUrl} controls className="w-full rounded-lg"
                              style={{ maxHeight: 160, aspectRatio: "9/16", display: "block", margin: "0 auto" }} />
                          )}

                          {/* composite → composite video */}
                          {key === "composite" && compositePreviewUrl && (
                            <video src={compositePreviewUrl} controls className="w-full rounded-lg"
                              style={{ maxHeight: 160, aspectRatio: "9/16", display: "block", margin: "0 auto" }} />
                          )}

                          {/* log line fallback */}
                          {logs[key] && !["keywords","tts","transcribe","fetchStock","config","render","avatar","composite"].includes(key) && (
                            <p className="text-[9px] font-mono text-white/35 break-all">{logs[key]}</p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              </div>
            </div>

            {/* Col 2 — Subtitle Review + BG Removal stacked */}
            <div className="xl:col-span-4 flex flex-col gap-4">

            {/* Subtitle Review — edit before generate */}
            <div className="rounded-2xl overflow-hidden flex flex-col" style={{ background: "var(--sv-card)", border: "1px solid var(--sv-border)" }}>
              <div className="flex items-center justify-between px-4 py-3 shrink-0" style={{ borderBottom: "1px solid var(--sv-border)" }}>
                <div className="flex items-center gap-2">
                  <Captions className="h-3.5 w-3.5 text-cyan-400" />
                  <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">Subtitle Review</p>
                  {editedSceneCaptions.length > 0 && (
                    <span className="text-[9px] font-bold text-cyan-400/60">{editedSceneCaptions.length} ฉาก</span>
                  )}
                </div>
                {editedSceneCaptions.length > 0 && (
                  <div className="flex items-center gap-2">
                    {/* Export SRT */}
                    <button
                      onClick={() => {
                        const fmt = (ms: number) => {
                          const h = Math.floor(ms / 3600000);
                          const m = Math.floor((ms % 3600000) / 60000);
                          const s = Math.floor((ms % 60000) / 1000);
                          const ms2 = ms % 1000;
                          return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(ms2).padStart(3,"0")}`;
                        };
                        const srt = editedSceneCaptions.map((c, i) =>
                          `${i + 1}\n${fmt(c.startMs)} --> ${fmt(c.endMs)}\n${c.text}`
                        ).join("\n\n");
                        const blob = new Blob([srt], { type: "text/plain" });
                        const a = document.createElement("a");
                        a.href = URL.createObjectURL(blob);
                        a.download = "subtitles.srt";
                        a.click();
                      }}
                      className="text-[9px] font-bold text-white/30 hover:text-cyan-400 transition-colors px-1.5 py-0.5 rounded"
                      style={{ background: "var(--sv-input)" }}>
                      Export SRT
                    </button>
                    <button
                      onClick={() => setEditedSceneCaptions(pipe.current.sceneCaptions ?? [])}
                      className="text-[9px] text-white/25 hover:text-white/50 transition-colors">
                      reset
                    </button>
                  </div>
                )}
              </div>

              {editedSceneCaptions.length === 0 ? (
                <div className="flex flex-col items-center justify-center flex-1 py-10">
                  <Captions className="h-8 w-8 text-white/8 mb-2" />
                  <p className="text-xs text-white/18">Run pipeline first</p>
                  <p className="text-[9px] text-white/10 mt-1">Subtitles appear here after Transcribe</p>
                </div>
              ) : (
                <>
                  <div className="flex-1 overflow-hidden">
                    <div className="overflow-y-auto" style={{ maxHeight: 340 }}>
                      {editedSceneCaptions.map((cap, i) => {
                        const fmt = (ms: number) => {
                          const s = Math.floor(ms / 1000);
                          return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
                        };
                        const isActive = i === activeCaptionIdx;
                        const tag = cap.tag ?? "body";
                        const tagCfg = {
                          hook: { label: "HOOK", bg: "hsl(38 100% 50% / 0.18)", color: "hsl(38 100% 65%)", border: "hsl(38 100% 50% / 0.4)", leftBorder: "hsl(38 100% 55%)" },
                          cta:  { label: "CTA",  bg: "hsl(142 72% 30% / 0.18)", color: "hsl(142 72% 60%)", border: "hsl(142 72% 40% / 0.4)", leftBorder: "hsl(142 72% 50%)" },
                          body: { label: "",     bg: "", color: "", border: "", leftBorder: "" },
                        }[tag];
                        return (
                          <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 transition-colors"
                            style={{
                              background: isActive
                                ? "hsl(190 100% 50% / 0.1)"
                                : tag === "hook" ? "hsl(38 100% 50% / 0.06)"
                                : tag === "cta"  ? "hsl(142 72% 30% / 0.06)"
                                : i % 2 === 0 ? "var(--sv-card)" : "var(--sv-bg)",
                              borderLeft: `2px solid ${isActive ? "hsl(190 100% 50% / 0.6)" : tag !== "body" ? tagCfg.leftBorder : "transparent"}`,
                            }}>
                            <span className={`text-[9px] font-bold shrink-0 w-4 ${isActive ? "text-cyan-400" : "text-cyan-500/50"}`}>{i + 1}</span>
                            <span className="text-[9px] font-mono shrink-0 w-9 text-white/25">{fmt(cap.startMs)}</span>
                            {/* Tag badge — click to cycle hook→body→cta */}
                            {tag !== "body" ? (
                              <button
                                onClick={() => setEditedSceneCaptions(prev => prev.map((c, j) => j === i ? { ...c, tag: tag === "hook" ? "body" : tag === "cta" ? "body" : "body" } : c))}
                                className="shrink-0 rounded px-1 py-0 text-[8px] font-black uppercase tracking-widest transition-all hover:text-white/30"
                                style={{ background: tagCfg.bg, color: tagCfg.color, border: `1px solid ${tagCfg.border}` }}
                                title="คลิกเพื่อเปลี่ยนเป็น body">
                                {tagCfg.label}
                              </button>
                            ) : (
                              <button
                                onClick={() => setEditedSceneCaptions(prev => prev.map((c, j) => j === i ? { ...c, tag: i === 0 ? "hook" : "cta" } : c))}
                                className="shrink-0 w-8 rounded px-1 py-0 text-[8px] text-white/15 hover:text-white/40 transition-colors"
                                title="คลิกเพื่อ tag เป็น hook หรือ cta">
                                ···
                              </button>
                            )}
                            <input
                              value={cap.text}
                              onChange={e => setEditedSceneCaptions(prev =>
                                prev.map((c, j) => j === i ? { ...c, text: e.target.value } : c)
                              )}
                              className="flex-1 text-[11px] font-semibold bg-transparent outline-none min-w-0"
                              style={{ caretColor: "hsl(190 100% 60%)", color: isActive ? "hsl(190 100% 75%)" : tag === "hook" ? "hsl(38 100% 80%)" : tag === "cta" ? "hsl(142 72% 75%)" : "rgba(255,255,255,0.8)" }}
                            />
                            <span className="text-[9px] font-mono shrink-0 w-9 text-right text-white/20">{fmt(cap.endMs)}</span>
                            <button
                              onClick={() => setEditedSceneCaptions(prev => prev.filter((_, j) => j !== i))}
                              className="shrink-0 text-white/15 hover:text-red-400 transition-colors text-[11px] leading-none">✕</button>
                          </div>
                        );
                      })}
                    </div>
                    {/* Add row */}
                    <button
                      onClick={() => {
                        const last = editedSceneCaptions[editedSceneCaptions.length - 1];
                        const startMs = last ? last.endMs + 100 : 0;
                        setEditedSceneCaptions(prev => [...prev, { text: "", startMs, endMs: startMs + 2000 }]);
                      }}
                      className="w-full py-1.5 text-[9px] font-bold text-white/20 hover:text-cyan-400 transition-colors border-t"
                      style={{ borderColor: "var(--sv-border)", background: "var(--sv-card)" }}>
                      + เพิ่มซับ
                    </button>
                  </div>

                </>
              )}
            </div>

            {/* Background Removal panel */}
            {useAvatar && (
              <div className="rounded-2xl overflow-hidden" style={{ background: "var(--sv-card)", border: "1px solid hsl(120 60% 40% / 0.2)" }}>
                <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid hsl(120 60% 40% / 0.12)" }}>
                  <div className="flex items-center gap-2">
                    <Wand2 className="h-3.5 w-3.5 text-green-400/70" />
                    <p className="text-[10px] font-bold uppercase tracking-widest text-green-400/60">Background Removal</p>
                  </div>
                  <span className="text-[9px] text-white/25">ปรับก่อน Composite</span>
                </div>
                <div className="p-4 space-y-3">

                {/* Mode */}
                <div className="flex gap-1.5">
                  {(["chromakey", "rembg"] as const).map(m => (
                    <button key={m} onClick={() => setCompositeMode(m)}
                      className="flex-1 rounded-md px-2 py-1.5 text-[11px] font-semibold transition-all"
                      style={compositeMode === m
                        ? { background: "hsl(120 60% 35% / 0.25)", color: "#4ade80", border: "1px solid hsl(120 60% 40% / 0.4)" }
                        : { background: "var(--sv-input)", color: "color-mix(in srgb, var(--sv-text) 50%, transparent)", border: "1px solid var(--sv-border2)" }}>
                      {m === "chromakey" ? "Green Screen" : "AI rembg"}
                    </button>
                  ))}
                </div>

                {compositeMode === "chromakey" && (
                  <div className="space-y-3">
                    {/* Green color — fixed to match HeyGen API output */}
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-white/35 w-20 shrink-0">Green Color</span>
                      <div className="flex items-center gap-2 rounded px-2.5 py-1" style={{ background: "var(--sv-input)", border: "1px solid hsl(120 60% 40% / 0.3)" }}>
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: "#00FF00" }} />
                        <span className="text-[10px] font-mono text-green-400">#00FF00</span>
                        <span className="text-[9px] text-white/25">—  HeyGen API </span>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-white/35 w-20 shrink-0">Similarity</span>
                        <input type="range" min={0.10} max={0.55} step={0.01} value={chromaSimilarity}
                          onChange={e => setChromaSimilarity(Number(e.target.value))}
                          className="flex-1 accent-green-400 h-1" />
                        <span className="text-[10px] font-mono text-green-400 w-8 text-right">{chromaSimilarity.toFixed(2)}</span>
                      </div>
                      <p className="text-[9px] text-white/20 pl-[88px]">ยังเห็นสีเขียวเหลืออยู่ → เพิ่มขึ้น &nbsp;|&nbsp; ผิว/เสื้อโดนลบด้วย → ลดลง</p>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-white/35 w-20 shrink-0">Blend</span>
                        <input type="range" min={0.00} max={0.20} step={0.01} value={chromaBlend}
                          onChange={e => setChromaBlend(Number(e.target.value))}
                          className="flex-1 accent-green-400 h-1" />
                        <span className="text-[10px] font-mono text-green-400 w-8 text-right">{chromaBlend.toFixed(2)}</span>
                      </div>
                      <p className="text-[9px] text-white/20 pl-[88px]">ขอบหยัก/แข็ง → เพิ่มขึ้น &nbsp;|&nbsp; ขอบโปร่งใส/ฟุ้ง → ลดลง</p>
                    </div>
                  </div>
                )}

                {compositeMode === "rembg" && (
                  <div className="space-y-2">
                    <div className="flex gap-1.5 flex-wrap">
                      {([
                        { id: "u2net", label: "u2net", desc: "Best" },
                        { id: "isnet-general-use", label: "isnet", desc: "HQ" },
                        { id: "silueta", label: "silueta", desc: "Fast" },
                      ] as const).map(m => (
                        <button key={m.id} onClick={() => setRembgModel(m.id)}
                          className="rounded px-2 py-1 text-[10px] font-semibold transition-all"
                          style={rembgModel === m.id
                            ? { background: "hsl(120 60% 35% / 0.3)", color: "#4ade80", border: "1px solid hsl(120 60% 40% / 0.5)" }
                            : { background: "var(--sv-input)", color: "color-mix(in srgb, var(--sv-text) 50%, transparent)", border: "1px solid var(--sv-border2)" }}>
                          {m.label} <span className="opacity-50">{m.desc}</span>
                        </button>
                      ))}
                    </div>
                    <p className="text-[10px] text-yellow-500/50">⚠ ช้ากว่า Green Screen ~3-5x</p>
                  </div>
                )}

                {/* Test button */}
                <div className="flex gap-2">
                  <button
                    disabled={testRemoveLoading || (!avatarDirectUrl.trim() && !avatarGreenUrl) || !preRenderUrl}
                    onClick={async () => {
                      const avatarSrc = avatarDirectUrl.trim() || avatarGreenUrl;
                      if (!avatarSrc) { toast.error("ยังไม่มี Avatar — run Avatar ก่อน"); return; }
                      if (!preRenderUrl) { toast.error("ยังไม่มี BG — Render Video ก่อน"); return; }
                      setTestRemoveLoading(true);
                      setTestRemoveUrl("");
                      try {
                        const res = await fetch("/api/heygen/composite", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            avatarVideoUrl: avatarSrc,
                            bgVideoUrl: preRenderUrl,
                            mode: compositeMode,
                            chromaColor: chromaColor.replace("#", "0x"),
                            chromaSimilarity,
                            chromaBlend,
                            rembgModel,
                          }),
                        });
                        const data = await res.json();
                        if (data.videoUrl) setTestRemoveUrl(data.videoUrl);
                        else toast.error(data.error ?? "Test ไม่สำเร็จ");
                      } catch { toast.error("Test ไม่สำเร็จ"); }
                      finally { setTestRemoveLoading(false); }
                    }}
                    className="flex-1 flex items-center justify-center gap-2 rounded-lg py-2 text-xs font-bold text-white transition-all hover:opacity-90 disabled:opacity-40"
                    style={{ background: "hsl(120 60% 30% / 0.25)", border: "1px solid hsl(120 60% 40% / 0.35)" }}>
                    {testRemoveLoading
                      ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Testing...</>
                      : <><Wand2 className="h-3.5 w-3.5 text-green-400" /> Test Remove BG</>}
                  </button>
                  {testRemoveUrl && (
                    <button onClick={() => setTestRemoveUrl("")}
                      className="rounded-lg px-3 text-[10px] text-white/40 hover:text-white/70 transition-colors"
                      style={{ background: "var(--sv-input)", border: "1px solid var(--sv-border2)" }}>
                      Clear
                    </button>
                  )}
                </div>

                {testRemoveUrl && (
                  <div className="space-y-1.5">
                    <video src={testRemoveUrl} controls autoPlay muted loop
                      className="w-full rounded-lg" style={{ maxHeight: 240, background: "#000" }} />
                    <a href={testRemoveUrl} download
                      className="flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-[10px] font-semibold text-green-400"
                      style={{ background: "hsl(120 60% 20% / 0.2)", border: "1px solid hsl(120 60% 40% / 0.25)" }}>
                      <Download className="h-3 w-3" /> Download Test
                    </a>
                  </div>
                )}
                </div>
              </div>
            )}

            </div>{/* end col-2 */}

            {/* Col 3 — Preview (full height) */}
            <div className="xl:col-span-5 rounded-2xl overflow-hidden flex flex-col" style={{ background: "var(--sv-card)", border: "1px solid var(--sv-border)", minHeight: 600 }}>
              <div className="flex items-center justify-between px-4 py-3 shrink-0" style={{ borderBottom: "1px solid var(--sv-border)" }}>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-cyan-400" />
                  <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">Preview</p>
                  {(videoUrl || compositePreviewUrl || preRenderUrl) && (
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded"
                      style={{ background: "hsl(190 100% 50% / 0.1)", color: "hsl(190 100% 60%)", border: "1px solid hsl(190 100% 50% / 0.25)" }}>
                      {videoUrl ? "Final" : compositePreviewUrl ? "Composite" : "Remotion BG"}
                    </span>
                  )}
                </div>
              </div>

              {(videoUrl || compositePreviewUrl || preRenderUrl) ? (
                <div className="flex flex-col flex-1 min-h-0 p-3 gap-2">
                  <div className="flex flex-col flex-1 min-h-0">
                    <div ref={videoContainerRef} className="relative rounded-xl overflow-hidden bg-black flex-1 min-h-0" style={{ minHeight: 420 }}>
                      <video
                        ref={videoRef}
                        src={videoUrl || compositePreviewUrl || preRenderUrl}
                        controls
                        className="w-full h-full object-contain"
                        style={{ display: "block" }}
                      />
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 mt-1">
                    <a
                      href={videoUrl || compositePreviewUrl || preRenderUrl}
                      download
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2.5 text-xs font-bold text-white transition-all hover:opacity-90"
                      style={{ background: "linear-gradient(135deg, hsl(190 100% 45%), hsl(220 100% 58%))" }}>
                      <Download className="h-3.5 w-3.5" /> Download MP4
                    </a>
                  </div>
                </div>
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center py-12">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full mb-3"
                    style={{ background: "var(--sv-input)", border: "1px solid var(--sv-border2)" }}>
                    <Play className="h-7 w-7 text-white/12 ml-0.5" />
                  </div>
                  <p className="text-xs text-white/25 mb-1">Output will appear here</p>
                  <p className="text-[9px] text-white/15">หรือวาง path วิดีโอด้านบนเพื่อใส่ซับ</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

    </DashboardLayout>
  );
}


/* ── PhaseRow component ── */
type StepKey = "keywords" | "fetchStock" | "tts" | "transcribe" | "config" | "render" | "avatar" | "composite";

function PhaseRow({
  phaseNum, label, color, steps, stepStates, running, onRerun, action, beforeStock,
}: {
  phaseNum: number;
  label: string;
  color: "cyan" | "blue" | "purple" | "yellow";
  steps: { key: StepKey; label: string; icon: React.ElementType; canRun: boolean }[];
  stepStates: StepState;
  running: boolean;
  onRerun: (key: StepKey) => void;
  action: React.ReactNode;
  beforeStock?: React.ReactNode;
}) {
  const colorMap = {
    cyan:   { bg: "hsl(190 100% 50% / 0.05)", border: "hsl(190 100% 50% / 0.15)", badge: "hsl(190 100% 60%)", badgeBg: "hsl(190 100% 50% / 0.12)" },
    blue:   { bg: "hsl(220 100% 60% / 0.05)", border: "hsl(220 100% 60% / 0.15)", badge: "hsl(220 100% 70%)", badgeBg: "hsl(220 100% 60% / 0.12)" },
    purple: { bg: "hsl(252 83% 55% / 0.05)", border: "hsl(252 83% 55% / 0.15)", badge: "hsl(252 83% 75%)", badgeBg: "hsl(252 83% 55% / 0.12)" },
    yellow: { bg: "hsl(45 100% 50% / 0.05)", border: "hsl(45 100% 50% / 0.15)", badge: "hsl(45 100% 65%)", badgeBg: "hsl(45 100% 50% / 0.12)" },
  }[color];

  return (
    <div className="flex items-center gap-3 rounded-xl px-4 py-2.5"
      style={{ background: colorMap.bg, border: `1px solid ${colorMap.border}` }}>
      {/* Phase label */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-[9px] font-black uppercase tracking-widest" style={{ color: colorMap.badge }}>P{phaseNum}</span>
        <span className="text-xs font-semibold text-white/40">{label}</span>
      </div>

      {/* Step chips */}
      <div className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto">
        {steps.map(({ key, label: stepLabel, icon: Icon, canRun }, idx) => {
          const status = stepStates[key as keyof StepState];
          const isDone = status === "done";
          const isRun  = status === "running";
          const isErr  = status === "error";
          const isSkip = status === "skip";
          return (
            <React.Fragment key={key}>
              {key === "fetchStock" && beforeStock}
              <button
                onClick={() => onRerun(key)}
                disabled={running || (!isDone && !isErr && !canRun)}
                title={stepLabel}
                className={cn(
                  "flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold transition-all disabled:opacity-35 shrink-0",
                  isDone ? "cursor-pointer hover:opacity-85" :
                  isErr  ? "cursor-pointer" :
                  isRun  ? "cursor-default" : "cursor-pointer hover:opacity-80"
                )}
                style={{
                  background: isRun ? "hsl(190 100% 50% / 0.15)" : isDone ? "hsl(142 72% 29% / 0.15)" : isErr ? "hsl(0 84% 60% / 0.12)" : isSkip ? "hsl(45 100% 50% / 0.08)" : "var(--sv-border)",
                  border: `1px solid ${isRun ? "hsl(190 100% 50% / 0.3)" : isDone ? "hsl(142 72% 29% / 0.35)" : isErr ? "hsl(0 84% 60% / 0.35)" : isSkip ? "hsl(45 100% 50% / 0.25)" : "var(--sv-border2)"}`,
                  color: isDone ? "hsl(142 72% 55%)" : isRun ? "hsl(190 100% 65%)" : isErr ? "hsl(0 84% 65%)" : isSkip ? "hsl(45 100% 55% / 0.6)" : "rgba(255,255,255,0.35)",
                }}
              >
                {isRun ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> :
                 isDone ? <CheckCircle2 className="h-2.5 w-2.5" /> :
                 isErr  ? <RefreshCw className="h-2.5 w-2.5" /> :
                 <Icon className="h-2.5 w-2.5" />}
                {stepLabel}
              </button>
              {idx < steps.length - 1 && (
                <span className="text-white/15 shrink-0 text-xs">›</span>
              )}
            </React.Fragment>
          );
        })}
      </div>

      {/* Action button */}
      <div className="shrink-0">{action}</div>
    </div>
  );
}
