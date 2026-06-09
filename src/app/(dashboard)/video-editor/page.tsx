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
  Download, Scissors, Trash2,
  ChevronDown, ChevronLeft, ChevronRight, Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Volume1,
  Maximize2, Minimize2, Plus, Search, Loader2,
  ZoomIn, User, X, Save, Pencil,
} from "lucide-react";
import { ApiKeyModal, detectMissingKeyType, type RequiredKeyType } from "@/components/ui/api-key-modal";
import { UpgradeModal } from "@/components/ui/upgrade-modal";

// ─── Refactored sub-components & utilities ────────────────────────────────
import type {
  StepStatus, StepState, Caption, StockVideo, PipelineData,
  SubPreset, SubTextEffect, EditorDraft,
} from "./_components/types";
import { DEFAULT_STEPS } from "./_components/types";
import { loadDrafts, saveDrafts, newDraftId } from "./_components/draft-helpers";
import { StepIcon } from "./_components/StepIcon";
import { renderSubEl } from "./_components/subtitle-renderer";
import { ApiCallError } from "./_components/ApiCallError";
import { OrderPanel } from "./_components/OrderPanel";
import { RightSettingsPanel } from "./_components/RightSettingsPanel";
import { ScrubberBar } from "./_components/ScrubberBar";
import { trackEvent } from "@/lib/client-telemetry";

const STEP_EVENT_LABELS: Record<string, string> = {
  keywords: "หา keyword",
  fetchStock: "หา B-roll",
  tts: "สร้างเสียง",
  transcribe: "ถอดเสียงเป็นซับ",
  config: "จัดลำดับคลิป",
  render: "เรนเดอร์",
  avatar: "สร้าง Avatar",
  avatarTail: "Avatar ปิดท้าย",
  composite: "วาง Avatar บนวิดีโอ",
  burnSubtitles: "ฝังซับลงวิดีโอ",
};

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
  const stepStartedAtRef = useRef<Partial<Record<keyof StepState, number>>>({});
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
  const activeSegCardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activeSegCardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [activeCaptionIdx]);

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

  const captionEndMs = captions.length > 0 ? Math.max(...captions.map(c => c.endMs)) : 0;
  // Timeline is in caption/audio time. The HTML video can differ slightly (burned
  // output, avatar bookends), so all caption/timeline operations use this mapper.
  const totalMs = captionEndMs > 0 ? captionEndMs : durationMs > 0 ? durationMs : 0;
  const videoMsToCaptionMs = useCallback((videoMs: number) => (
    durationMs > 0 && captionEndMs > 0 ? videoMs * (captionEndMs / durationMs) : videoMs
  ), [durationMs, captionEndMs]);
  const captionMsToVideoMs = useCallback((captionMs: number) => (
    durationMs > 0 && captionEndMs > 0 ? captionMs * (durationMs / captionEndMs) : captionMs
  ), [durationMs, captionEndMs]);
  const playheadMs = videoMsToCaptionMs(currentMs);

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
  // Default to Kanit because it ships with weights up to 900 — Mitr only goes to
  // 700, so the default fontWeight=900 was forcing the browser to synthesize bold,
  // which looked different in preview vs the burned MP4 (Remotion uses real 900).
  const [subFontFamily, setSubFontFamily] = useState("'Kanit', sans-serif");
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
  const [activeRightTab, setActiveRightTab] = useState<"style" | "font" | "transcript">("font");
  const [orderPanelOpen, setOrderPanelOpen] = useState(true);

  // ── Avatar (HeyGen pipeline) ───────────────────────────────────────────
  const [useAvatar, setUseAvatar] = useState(false);
  const [avatarId, setAvatarId] = useState("");
  const [avatarScale, setAvatarScale] = useState(2.02);
  const [avatarOffsetX, setAvatarOffsetX] = useState(0.0);
  const [avatarOffsetY, setAvatarOffsetY] = useState(0.13);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState("");
  const [avatarName, setAvatarName] = useState("");
  // idle = nothing checked yet, loading = fetching, ok = valid ID, error = not found / invalid
  const [avatarStatus, setAvatarStatus] = useState<"idle" | "loading" | "ok" | "error" | "unverified">("idle");
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

  // ── Render settings modal ─────────────────────────────────────────────
  const [renderSettingsOpen, setRenderSettingsOpen] = useState(false);
  const [renderFps, setRenderFps] = useState<24 | 30 | 50 | 60>(30);
  const [renderQuality, setRenderQuality] = useState<"480p" | "720p" | "1080p">("720p");
  const renderQualityToJpeg: Record<string, number> = { "480p": 70, "720p": 85, "1080p": 95 };
  const pendingRunAllRef = useRef<(() => void) | null>(null);

  // ── Missing key modal ─────────────────────────────────────────────────
  const [missingKey, setMissingKey] = useState<{ type: RequiredKeyType; retryStep: keyof StepState | "runAll" | "runAvatarPipeline" } | null>(null);
  const [upgradeModal, setUpgradeModal] = useState<{ open: boolean; message?: string }>({ open: false });

  // ── Timeline zoom ─────────────────────────────────────────────────────

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
  const clipResizeRef = useRef<{ capIdx: number; edge: "left" | "right" | "move"; startX: number; startMs: number; durMs?: number; moved?: boolean } | null>(null);

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

    // If jobId is in URL from a previous render session, cancel that job and clear the URL.
    // Refresh = stop render immediately — no auto-resume.
    const urlJobId = new URL(window.location.href).searchParams.get("jobId");
    if (urlJobId) {
      navigator.sendBeacon(`/api/videos/render-cancel?jobId=${encodeURIComponent(urlJobId)}`);
      try { const u = new URL(window.location.href); u.searchParams.delete("jobId"); window.history.replaceState({}, "", u.toString()); } catch {}
    }

    // Stop all polling and cancel active render job when tab closes/refreshes
    const onUnload = () => {
      abortControllerRef.current?.abort();
      stopRenderPollRef.current?.();
      const jobId = activeJobIdRef.current;
      if (jobId) {
        // sendBeacon survives page unload; fetch does not
        navigator.sendBeacon(`/api/videos/render-cancel?jobId=${encodeURIComponent(jobId)}`);
      }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch the HeyGen avatar thumbnail + name for the current Avatar ID. Shared by
  // the debounced auto-load effect and the manual "โหลด avatar" button.
  const loadAvatarInfo = useCallback(async (id: string) => {
    if (!id || id.length < 10) { setAvatarPreviewUrl(""); setAvatarName(""); setAvatarStatus("idle"); return; }
    setAvatarStatus("loading");
    try {
      const r = await fetch(`/api/heygen/avatar-info?avatarId=${encodeURIComponent(id)}`);
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        setAvatarPreviewUrl(""); setAvatarName("");
        // Only flag the KEY when the server says so via missingKey:"heygen"
        // (a real HeyGen 401/403). A bare 401 without missingKey is a Clerk/session
        // issue, not the HeyGen key — and the key already lives in Settings, so we
        // never ask the user to re-enter it here. Everything else = unverified.
        if (d?.missingKey === "heygen") {
          setAvatarStatus("error");
          toast.error("HeyGen key ใน Settings ไม่ถูกต้อง/หมดสิทธิ์ — แก้ที่ Settings");
        } else if (r.status === 401) {
          setAvatarStatus("unverified");
          toast.message("เซสชันหมดอายุ — รีเฟรชหน้าแล้วลองใหม่");
        } else {
          setAvatarStatus("unverified");
          toast.message("เช็ค Avatar ID ไม่ได้ตอนนี้ (HeyGen ช้า) — แต่ลอง render ได้");
        }
        return;
      }
      const d = await r.json();
      setAvatarPreviewUrl(d.previewImageUrl ?? "");
      setAvatarName(d.name ?? "");
      // unverified = ID not in HeyGen's list, but the list isn't exhaustive so it
      // may still render. Don't block — show a soft "ลองได้" state.
      if (d.unverified) {
        setAvatarStatus("unverified");
        if (d.note) toast.message(d.note);
      } else {
        setAvatarStatus("ok");
      }
    } catch {
      // Network blip — not a key problem. Soft state, no "check your key" nag.
      setAvatarPreviewUrl(""); setAvatarName(""); setAvatarStatus("unverified");
      toast.message("เช็ค Avatar ID ไม่ได้ตอนนี้ — แต่ลอง render ได้");
    }
  }, []);

  // Auto-load avatar preview when avatarId changes (debounced)
  useEffect(() => {
    if (!avatarId || avatarId.length < 10) { setAvatarPreviewUrl(""); setAvatarName(""); return; }
    const t = setTimeout(() => { void loadAvatarInfo(avatarId); }, 600);
    return () => clearTimeout(t);
  }, [avatarId, loadAvatarInfo]);

  // ── Video sync — rAF loop for smooth subtitle tracking ────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let rafId = 0;
    let lastIdx = -1;

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const ms = v.currentTime * 1000;
      const captionMs = videoMsToCaptionMs(ms);
      setCurrentMs(ms);
      const idx = captionsRef.current.findIndex(c => captionMs >= c.startMs && captionMs < c.endMs);
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
      const captionMs = videoMsToCaptionMs(ms);
      setCurrentMs(ms);
      const idx = captionsRef.current.findIndex(c => captionMs >= c.startMs && captionMs < c.endMs);
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
  }, [captions, videoUrl, preRenderUrl, videoMsToCaptionMs]);  // re-run when video src changes so listeners attach to new element

  // ── Reset to a fresh project (mirrors all fields that loadDraftInto restores) ──
  function resetEditorState() {
    setDraftId(newDraftId());
    setProjectName("New Project");
    setScript("");
    setScriptOverride("");
    setShowScriptOverride(false);

    // Style — restore defaults
    setSubFontFamily("'Kanit', sans-serif");
    setSubFontSize(80);
    setSubFontWeight(900);
    setSubColor("#ffffff");
    setSubAccentColor("#FFE500");
    setSubPreset("stroke");
    setSubEffect("pop");
    setSubPosition(82);
    setSubShadow(true);
    setSubOutline(false);
    setSubOutlineSize(2);

    // TTS
    setTtsProvider("gemini");
    setVoiceId("");
    setGeminiVoiceName("Aoede");

    // Video + captions
    setVideoUrl("");
    setPreRenderUrl("");
    setTtsUrl("");
    setCaptionsRaw([]); captionsRef.current = [];
    setActiveCaptionIdx(-1);
    setEditingCapIdx(null);
    setActiveSegIdx(0);

    // Playback
    setPlaying(false);
    setCurrentMs(0);
    setDurationMs(0);

    // Stock
    setStockSource("both");
    setStockVideos([]);

    // BGM
    setBgmEnabled(false);
    setBgmFile("");
    setBgmVolume(0.12);

    // Avatar
    setUseAvatar(false);
    setAvatarId("");
    setAvatarName("");
    setAvatarPreviewUrl("");
    setAvatarTiming("full");
    setAvatarBookendSecs(5);
    setAvatarTailSecs(5);
    setAvatarScale(2.02);
    setAvatarOffsetX(0.0);
    setAvatarOffsetY(0.13);
    setAvatarInputMode("generate");
    setAvatarDirectUrl("");
    setChromaSimilarity(0.28);
    setChromaBlend(0.04);
    setAvatarGreenUrl("");
    setAvatarTailGreenUrl("");

    // Pipeline steps + logs
    setSteps({ ...DEFAULT_STEPS });
    stepsRef.current = { ...DEFAULT_STEPS };
    setLogs({});
    setRenderProgress(0);
    setRenderProgressError(null);

    // Wipe pipeline cache so old data doesn't leak into the new project
    pipe.current = {};

    setLastSaved(null);
    setShowDraftList(false);
  }

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
    const previous = stepsRef.current[key];
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const label = STEP_EVENT_LABELS[String(key)] ?? String(key);

    if (status === "running" && previous !== "running") {
      stepStartedAtRef.current[key] = now;
      trackEvent("pipeline_step_started", {
        category: "pipeline",
        path: "/video-editor",
        step: String(key),
        status: "running",
        properties: { label },
      });
    }

    if ((status === "done" || status === "error" || status === "skip") && previous !== status) {
      const startedAt = stepStartedAtRef.current[key];
      const durationMs = typeof startedAt === "number" ? now - startedAt : undefined;
      trackEvent(
        status === "done" ? "pipeline_step_done" : status === "error" ? "pipeline_step_error" : "pipeline_step_skipped",
        {
          category: status === "error" ? "error" : "pipeline",
          path: "/video-editor",
          step: String(key),
          status,
          durationMs,
          properties: {
            label,
            message: log ? log.slice(0, 180) : undefined,
          },
        },
      );
      if (status !== "error") delete stepStartedAtRef.current[key];
    }

    setSteps(s => { const next = { ...s, [key]: status }; stepsRef.current = next; return next; });
    if (log) setLogs(l => ({ ...l, [key]: log }));
  }

  function clearDerivedPreviewOutputs({ clearComposite = false }: { clearComposite?: boolean } = {}) {
    pipe.current.burnedVideoUrl = "";
    if (clearComposite) pipe.current.compositeUrl = "";
    setSteps(s => {
      const next = { ...s, burnSubtitles: "idle" as StepStatus };
      if (clearComposite) next.composite = "idle";
      stepsRef.current = next;
      return next;
    });
    setLogs(l => {
      const next = { ...l };
      delete next.burnSubtitles;
      if (clearComposite) delete next.composite;
      return next;
    });
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
    if (err instanceof ApiCallError) {
      const status = (err.data as any)._status as number | undefined;
      const errMsg = String(err.data.error ?? "");
      if (status === 429 && errMsg) return errMsg;
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
    if (raw.includes("429")) return "API เกิน Rate Limit — รอสักครู่แล้วลองใหม่";
    return raw.split("\n")[0].slice(0, 200) || "เกิดข้อผิดพลาด";
  }

  // Show error as toast with action button + helpful link based on error type
  function showErrorToast(err: unknown) {
    const message = friendlyError(err);
    const lower = message.toLowerCase();

    // Detect type to pick the right action
    let action: { label: string; url: string } | null = null;
    if (lower.includes("generative language api") || lower.includes("permission_denied") || lower.includes("service_disabled")) {
      action = { label: "เปิด API ที่ Cloud Console", url: "https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com" };
    } else if (lower.includes("gemini") && (lower.includes("ไม่ถูกต้อง") || lower.includes("401") || lower.includes("invalid"))) {
      action = { label: "สร้าง Key ใหม่", url: "https://aistudio.google.com/apikey" };
    } else if (lower.includes("โควต้าฟรี") || lower.includes("ผูกบัตร google") || lower.includes("quota")) {
      action = { label: "ไปที่ Settings", url: "/settings?tab=api-keys" };
    } else if (lower.includes("high demand") || lower.includes("503") || lower.includes("ขัดข้อง") || lower.includes("ใช้งานหนาแน่น")) {
      action = { label: "ดูวิธีแก้", url: "/settings?tab=api-keys" };
    } else if (lower.includes("key") && (lower.includes("settings") || lower.includes("ไม่ถูกต้อง"))) {
      action = { label: "ไปที่ Settings", url: "/settings?tab=api-keys" };
    }

    if (action) {
      toast.error(message, {
        duration: 10000,
        action: {
          label: action.label,
          onClick: () => window.open(action!.url, action!.url.startsWith("http") ? "_blank" : "_self"),
        },
      });
    } else {
      toast.error(message);
    }
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
      // ตัดวงเล็บและเนื้อหาข้างใน — ไม่ควรอ่านออกเสียง เช่น (Artificial Intelligence), (อ่านว่า xxx)
      .replace(/\([^)]{1,80}\)/g, "")
      // ตัดวงเล็บเหลี่ยมและเนื้อหาข้างใน เช่น [หมายเหตุ], [ดนตรี]
      .replace(/\[[^\]]{1,80}\]/g, "")
      // ตัด hashtag เช่น #AI #tech
      .replace(/#\S+/g, "")
      // ตัด URL
      .replace(/https?:\/\/\S+/g, "")
      // ตัด emoji
      .replace(/[\u{1F300}-\u{1FFFF}]/gu, "")
      // ตัด stage direction เช่น *หยุดพัก*, _เน้น_
      .replace(/\*[^*]{1,50}\*/g, "")
      .replace(/_[^_]{1,50}_/g, "")
      .replace(/\r?\n/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  // ── Step runners (same logic as video-creator) ─────────────────────────

  async function runKeywords(): Promise<string[]> {
    setStep("keywords", "running");
    try {
      // If captions are already generated (post-transcribe), use them as "scenes" so each
      // caption gets its own visual moment — otherwise the LLM-split script ignores audio pacing.
      // Falls back to line-split for first run before transcribe.
      const existingCaps = captionsRef.current ?? [];
      const sc = existingCaps.length > 0
        ? existingCaps.map(c => c.text)
        : splitScenes(script);
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
        body: JSON.stringify({ scenes: sc, audioDurationSec: Math.min(1800, estimatedDurSec), preferredLLM: preferredLLMRef.current }),
        signal: abortControllerRef.current?.signal,
      });
      const data = await res.json();
      assertOk("Keywords", res, data);
      const kws: string[] = data.keywords ?? [];
      if (kws.length === 0) {
        throw new Error("ไม่สามารถดึง keywords ได้ กรุณาตรวจสอบ Gemini API Key หรือโควต้า Google");
      }
      pipe.current.keywords = kws;
      pipe.current.keywordAlternatives = data.keywordAlternatives ?? [];
      pipe.current.keywordsPerScene = data.keywordsPerScene ?? 5;
      pipe.current.sceneClipCounts = data.sceneClipCounts ?? [];
      pipe.current.sceneDurations = data.sceneDurations ?? [];
      pipe.current.visualDirection = data.visualDirection ?? "";
      const totalClips = (data.sceneClipCounts ?? []).reduce((a: number, b: number) => a + b, kws.length);
      setStep("keywords", "done", `${sc.length} ฉาก → ${kws.length} keywords (${totalClips} คลิปที่ต้องการ)`);
      return kws;
    } catch (err) {
      setStep("keywords", "error", friendlyError(err));
      throw err;
    }
  }

  async function runFetchStock(kws: string[]): Promise<StockVideo[]> {
    const srcLabel = stockSource === "pexels" ? "Pexels" : stockSource === "pixabay" ? "Pixabay" : "Pexels+Pixabay";
    setStep("fetchStock", "running", `${kws.length} keywords → ${srcLabel}...`);
    const sceneDurations: number[] = pipe.current.sceneDurations ?? [];
    const totalDurationSec = sceneDurations.length > 0
      ? sceneDurations.reduce((a, b) => a + b, 0)
      : Math.max(30, Math.ceil((pipe.current.scenes ?? []).reduce((s, sc) => s + sc.replace(/\s/g,"").length, 0) / 3));
    const caps = pipe.current.sceneCaptions ?? [];
    const captionClipLimit = caps.length > 0 && kws.length > 0 ? Math.min(caps.length, kws.length) : 0;
    const perSubtitleClipCount = caps.length > 0 && caps.length === kws.length ? caps.length : 0;
    const res = await fetch("/api/videos/fetch-stock", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keywords: kws, download: true, totalDurationSec, stockSource,
        preferredLLM: preferredLLMRef.current,
        ...(perSubtitleClipCount > 0
          ? { overrideClipCount: perSubtitleClipCount, perSubtitleMode: true }
          : captionClipLimit > 0 ? { overrideClipCount: captionClipLimit }
          : targetClipCount > 0 ? { overrideClipCount: targetClipCount } : {}),
        ...(pipe.current.visualDirection ? { visualDirection: pipe.current.visualDirection } : {}),
        ...(pipe.current.keywordAlternatives?.length ? { keywordAlternatives: pipe.current.keywordAlternatives } : {}),
        ...(perSubtitleClipCount > 0 ? { subtitleTexts: caps.map(c => c.text) } : {}),
      }),
      signal: abortControllerRef.current?.signal,
    });
    const data = await res.json();
    assertOk("Stock", res, data);
    const svRaw: StockVideo[] = (data.results ?? []).filter((r: StockVideo) => r.localUrl || r.videoUrl);
    if (!svRaw.length) throw new Error("ไม่พบ stock video");

    // ── Match stock count to caption count for per-subtitle B-ROLL mode ──
    // We want 1 B-ROLL clip per caption so cuts land on subtitle boundaries.
    // If caps already exist (runAll path), apply now so the timeline UI
    // reflects what the renderer will actually use:
    //   sv ≥ caps → trim down to caps.length
    //   sv  < caps → cycle clips so every caption still has one
    let sv = svRaw;
    if (caps.length > 0 && svRaw.length > 0) {
      if (svRaw.length >= caps.length) {
        sv = svRaw.slice(0, caps.length);
        console.log(`[runFetchStock] per-subtitle: trimmed ${svRaw.length} → ${sv.length} clips`);
      } else {
        sv = Array.from({ length: caps.length }, (_, i) => svRaw[i % svRaw.length]);
        console.log(`[runFetchStock] per-subtitle: cycled ${svRaw.length} clips → ${sv.length} (one per caption)`);
      }
    }

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
    setStep("transcribe", "running", "กำลังถอดเสียง...");
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

    // คำนวณ MAX_CHARS จาก font size จริง: วิดีโอ 1080px กว้าง, ตัวอักษรไทยเฉลี่ย ~0.47 × fontSize px
    // padding ซ้าย-ขวา ~80px ต่อด้าน → พื้นที่ใช้ได้ = 1080 - 160 = 920px
    const AVG_CHAR_WIDTH_RATIO = 0.47; // Thai chars are narrower than Latin (~0.47× not 0.62×)
    const VIDEO_WIDTH = 1080;
    const SUBTITLE_PADDING = 160;
    const MAX_CHARS = Math.max(10, Math.floor((VIDEO_WIDTH - SUBTITLE_PADDING) / (subFontSize * AVG_CHAR_WIDTH_RATIO)));
    const MIN_CHARS = Math.max(4, Math.floor(MAX_CHARS * 0.25));

    // Look up real spoken time for a substring by matching it to STT word timestamps
    // that fall inside [capStart, capEnd]. Falls back to char-proportion when STT
    // words aren't available (e.g. ElevenLabs path with no word-level timing).
    const wordsInRange = (capStartMs: number, capEndMs: number) =>
      whisperWords.filter(w => w.endMs > capStartMs && w.startMs < capEndMs);

    function realTimingForChunks(cap: Caption, chunks: string[][]): { startMs: number; endMs: number }[] {
      const span = Math.max(cap.endMs - cap.startMs, 1);
      const wordsHere = wordsInRange(cap.startMs, cap.endMs);
      // Fallback to char proportion if we have no STT word timestamps
      if (wordsHere.length === 0) {
        return chunks.map((_, i) => {
          const start = cap.startMs + Math.floor((span * i) / chunks.length);
          const end = i === chunks.length - 1 ? cap.endMs : cap.startMs + Math.floor((span * (i + 1)) / chunks.length);
          return { startMs: start, endMs: Math.max(start + 240, end) };
        });
      }
      // Greedy walk: for each chunk advance a word pointer until accumulated char
      // length covers the chunk's char length (whichever metric matches better
      // between Latin word.length and Thai char count).
      let wi = 0;
      const totalChars = chunks.reduce((s, c) => s + joinWords(c).replace(/\s/g, "").length, 0) || 1;
      let consumedChars = 0;
      return chunks.map((chunk, i) => {
        const chunkChars = joinWords(chunk).replace(/\s/g, "").length;
        const startWord = wordsHere[Math.min(wi, wordsHere.length - 1)];
        // Walk word pointer until we've covered this chunk's share of total chars
        consumedChars += chunkChars;
        const targetWordIdx = Math.min(
          wordsHere.length - 1,
          Math.max(0, Math.round((consumedChars / totalChars) * wordsHere.length) - 1),
        );
        wi = targetWordIdx + 1;
        const endWord = wordsHere[targetWordIdx];
        const startMs = i === 0 ? cap.startMs : Math.max(cap.startMs, startWord.startMs);
        const endMs = i === chunks.length - 1 ? cap.endMs : Math.min(cap.endMs, endWord.endMs);
        return { startMs, endMs: Math.max(startMs + 240, endMs) };
      });
    }

    const forceSplitByLength = (cap: Caption, tag: "hook" | "body" | "cta" | undefined): Caption[] => {
      const src = (cap.text ?? "").trim();
      const capTag = tag ?? (cap.tag as "hook" | "body" | "cta" | undefined);
      if (!src) return [{ ...cap, text: src, tag: capTag }];
      if (src.length <= MAX_CHARS) return [{ ...cap, text: src, tag: capTag }];
      const words = segmentWords(src);
      if (words.length <= 1) return [{ ...cap, text: src, tag: capTag }];
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
          if (joinWords(prevMerged).length <= MAX_CHARS) {
            rebalanced[rebalanced.length - 1] = prevMerged;
            continue;
          }
        }
        rebalanced.push(chunk);
      }
      const finalChunks = rebalanced.filter(c => c.length > 0);
      if (finalChunks.length <= 1) return [{ ...cap, text: src, tag: capTag }];

      // Use STT word timestamps for split timing instead of char-proportion math.
      // Falls back to char proportion when word timestamps aren't available.
      const timings = realTimingForChunks(cap, finalChunks);
      return finalChunks.map((tokens, i) => ({
        text: joinWords(tokens),
        startMs: timings[i].startMs,
        endMs: timings[i].endMs,
        tag: capTag,
      }));
    };

    // Trust Gemini's caption boundaries — they came from real word timestamps and
    // breath-aware breaks. Splitting again on the client (forceSplitByLength) created
    // captions with char-proportion timing that drifted from the actual audio words
    // → "ซับไม่ตรงเสียง". Long captions that overflow the line are wrapped by CSS
    // (word-wrap), not split into separate cues.
    let sceneCaptions: Caption[] = [];
    if (rawCaptions.length > 0) {
      sceneCaptions = rawCaptions.map((cap, i) => ({
        ...cap,
        text: (cap.text ?? "").trim(),
        tag: (cap.tag as "hook" | "body" | "cta" | undefined) ?? (i === 0 ? "hook" : "body"),
      }));
    }
    void forceSplitByLength;  // keep available for future opt-in modes

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

    // ── Post-process: merge captions ที่เป็นเศษคำ หรือสั้นเกิน (< 800ms) ──
    const MIN_DUR_MS = 800;
    const MAX_MERGE_CHARS = MAX_CHARS;
    // Thai leading vowels (เ แ โ ใ ไ) appear BEFORE the consonant in Unicode but render before it
    // A caption starting with these means the previous caption ended mid-word
    const thaiLeadingVowelRe = /^[เแโใไ]/;
    // A caption of ≤3 Thai chars with no punctuation = almost certainly a syllable fragment
    const isThaiFragment = (t: string) => {
      const thaiLen = (t.match(/[฀-๿]/g) ?? []).length;
      return thaiLen > 0 && thaiLen <= 3 && !/[.!?ฯ]/.test(t);
    };
    if (sceneCaptions.length > 1) {
      const merged: Caption[] = [];
      let i = 0;
      while (i < sceneCaptions.length) {
        const cur = sceneCaptions[i];
        const next = sceneCaptions[i + 1];
        const curText = cur.text.trim();
        const nextText = next?.text.trim() ?? "";
        const dur = cur.endMs - cur.startMs;

        // Merge if: next starts with a Thai leading vowel (prev ended mid-word),
        // or next is a tiny fragment, or cur is very short duration
        const nextStartsMidWord = nextText && thaiLeadingVowelRe.test(nextText);
        const nextIsFragment = nextText && isThaiFragment(nextText);
        const curIsFragment = isThaiFragment(curText);
        const tooShort = dur < MIN_DUR_MS;
        const combinedLen = curText.length + nextText.length;

        const shouldMerge = next &&
          (nextStartsMidWord || nextIsFragment || curIsFragment || tooShort) &&
          combinedLen <= MAX_MERGE_CHARS;

        if (shouldMerge) {
          merged.push({
            text: curText + nextText,
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
        if (bucket.length > 0 && (gap >= 500 || chars + wc > MAX_CHARS)) flush();
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

    // ── Force per-subtitle B-ROLL mode ──────────────────────────────────────
    // Want exactly 1 B-ROLL clip per caption so every cut lands on a subtitle
    // boundary (fixes 'ซับไม่ตรงเสียง / B-ROLL กระตุก').
    //
    // Two cases to handle:
    //   • sv ≥ caps (script short): trim the stock pool to caps.length
    //   • sv  < caps (script long): cycle through sv to fill caps.length
    //
    // Either way the resulting stock list has the same length as caps and we
    // emit sceneClipCounts=[1,1,...] so generate-config takes the
    // isPerSubtitleTop branch instead of falling back to scene-aware mode
    // (which produced the 30 even-split cuts seen in the user's log).
    let svForConfig = sv;
    let sceneClipCountsForConfig = pipe.current.sceneClipCounts ?? [];
    const capN = caps.length;
    if (capN > 0 && sv.length > 0) {
      if (sv.length >= capN) {
        svForConfig = sv.slice(0, capN);
        console.log(`[runConfig] per-subtitle: trimmed ${sv.length} → ${capN} clips`);
      } else {
        // Cycle the available clips so every caption gets a clip
        svForConfig = Array.from({ length: capN }, (_, i) => sv[i % sv.length]);
        console.log(`[runConfig] per-subtitle: cycled ${sv.length} clips → ${capN} (one per caption)`);
      }
      sceneClipCountsForConfig = Array.from({ length: capN }, () => 1);
      setStockVideos(svForConfig);
      pipe.current.stockVideos = svForConfig;
    }

    const res = await fetch("/api/videos/generate-config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      signal: abortControllerRef.current?.signal,
      body: JSON.stringify({
        sceneCaptions: caps, stockVideos: svForConfig, voiceFile: voiceUrl, audioDurationMs,
        fontFamily: subFontFamily, subtitlePosition: subPosition, subtitleSize: subFontSize,
        subtitleColor: subColor, subtitleAccentColor: subAccentColor,
        subtitleStylePreset: subPreset, subtitleTextEffect: subEffect, subtitleFontWeight: subFontWeight,
        scenes: pipe.current.scenes ?? [], keywordsPerScene: pipe.current.keywordsPerScene ?? 5,
        sceneClipCounts: sceneClipCountsForConfig, sceneDurations: pipe.current.sceneDurations ?? [],
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
        thumbnail: thumbnailUrl,
        script: script.trim() || null,
        avatarModel: avatarId || "none",
        voiceModel: voiceId || geminiVoiceName || "unknown",
        sceneCount: pipe.current.scenes?.length ?? 1,
        renderConfig: pipe.current.config ?? null,
        status: opts.status ?? "COMPLETED",
      };
      if (opts.avatarVideoUrl !== undefined) {
        Object.assign(payload, { avatarVideoUrl: opts.avatarVideoUrl });
      }

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
        if (d.error) { renderFailedMessage = d.error; setRenderProgressError(d.error); setStep("render", "error", d.error); stopPoll(); return; }
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
        // Always sync BGM from current UI state, not the cached config. The
        // config object is built once by runConfig; if the user toggles/sets
        // background music afterward and hits Render (which reuses
        // pipe.current.config), the cached config wouldn't carry bgmFile and the
        // render would come out silent. Patch it here so BGM always applies.
        ...(bgmEnabled && bgmFile
          ? { bgmFile, bgmVolume }
          : { bgmFile: undefined }),
      } : config;

      const res = await fetch("/api/videos/render", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shortVideoConfig: patchedConfig, fps: renderFps, jpegQuality: renderQualityToJpeg[renderQuality] }),
        signal: abortControllerRef.current?.signal,
      });
      if (renderFailedMessage) throw new Error(renderFailedMessage);
      const data = await res.json();
      assertOk("Render", res, data);

      const jobId = data.jobId as string | undefined;
      const immediateUrl = data.videoUrl as string | undefined;
      if (immediateUrl) {
        pipe.current.renderedVideoUrl = immediateUrl;
        pipe.current.renderedVideoNoSubUrl = immediateUrl;
        clearDerivedPreviewOutputs({ clearComposite: true });
        setPreRenderUrl(immediateUrl); setVideoUrl(immediateUrl);
        setStep("render", "done", immediateUrl); setRenderProgress(100); return immediateUrl;
      }
      if (!jobId) throw new Error("Render server did not return jobId");
      currentJobId = jobId; activeJobIdRef.current = jobId;
      // บันทึก jobId ลงใน URL เพื่อให้ resume ได้หลัง refresh
      try { const u = new URL(window.location.href); u.searchParams.set("jobId", jobId); window.history.replaceState({}, "", u.toString()); } catch {}

      // Stale detection: ถ้า progress ไม่เปลี่ยนนาน 60 นาที → ถือว่า hang → error
      const STALE_TIMEOUT_MS = 60 * 60 * 1000;
      let lastProgressValue = -1;
      let lastProgressChangedAt = Date.now();

      let statusNotFoundCount = 0;
      const url = await new Promise<string>((resolve, reject) => {
        resolveRenderUrl = resolve;
        const si = setInterval(async () => {
          if (activeJobIdRef.current !== jobId) { clearInterval(si); resolveRenderUrl = null; reject(new Error("__SUPERSEDED__")); return; }
          if (renderFailedMessage) { clearInterval(si); reject(new Error(renderFailedMessage)); return; }
          if (!resolveRenderUrl) { clearInterval(si); return; }

          // Stale check: progress ไม่เปลี่ยนนานเกิน 5 นาที → hang
          const curProgress = renderProgressRef.current;
          if (curProgress !== lastProgressValue) { lastProgressValue = curProgress; lastProgressChangedAt = Date.now(); }
          else if (Date.now() - lastProgressChangedAt > STALE_TIMEOUT_MS) {
            clearInterval(si); resolveRenderUrl = null;
            reject(new Error("Render หยุดค้างนานเกิน 60 นาที — กรุณาลองใหม่"));
            return;
          }

          try {
            const sr = await fetch(`/api/videos/render-status?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store", signal: abortControllerRef.current?.signal });
            const sd = await sr.json();
            if (activeJobIdRef.current !== jobId) { clearInterval(si); resolveRenderUrl = null; reject(new Error("__SUPERSEDED__")); return; }
            if (sd.status === "done" && sd.videoUrl) { clearInterval(si); resolveRenderUrl = null; resolve(sd.videoUrl as string); }
            else if (sd.status === "error") { clearInterval(si); resolveRenderUrl = null; reject(new Error(sd.error ?? "Render failed")); }
            else if (sd.status === "not_found" || sr.status === 404) {
              statusNotFoundCount++;
              if (statusNotFoundCount >= 3) {
                clearInterval(si);
                console.warn(`[render] render-status not_found ×${statusNotFoundCount} — falling back to progress-file polling`);
              }
            }
          } catch (e) { if (e instanceof Error && e.name === "AbortError") { clearInterval(si); resolveRenderUrl = null; reject(e); } }
        }, 3000);
      });

      if (activeJobIdRef.current !== jobId) throw new Error("__SUPERSEDED__");
      // เคลียร์ jobId ออกจาก URL หลัง render เสร็จ
      try { const u = new URL(window.location.href); u.searchParams.delete("jobId"); window.history.replaceState({}, "", u.toString()); } catch {}
      // Render always produces a no-sub video — Burn Subtitles adds them separately
      pipe.current.renderedVideoUrl = url;
      pipe.current.renderedVideoNoSubUrl = url;
      clearDerivedPreviewOutputs({ clearComposite: true });
      setPreRenderUrl(url); setVideoUrl(url);
      // Save the editable preview as PROCESSING; Burn Subtitles promotes it to final.
      saveToGallery({ videoUrl: url, videoUrlNoSub: url, status: "PROCESSING" });
      // Snapshot style at render time so user can reset back to this
      lastRenderedStyleRef.current = {
        fontFamily: subFontFamily, fontSize: subFontSize, fontWeight: subFontWeight,
        color: subColor, accentColor: subAccentColor, preset: subPreset,
        effect: subEffect, position: subPosition,
        captions: captionsRef.current.map(c => ({ ...c })),
      };
      setStyleIsDirty(false);
      setStep("render", "done", url); setRenderProgress(100); return url;
    } catch (err) {
      if (err instanceof Error && err.message === "__SUPERSEDED__") throw err;
      try { const u = new URL(window.location.href); u.searchParams.delete("jobId"); window.history.replaceState({}, "", u.toString()); } catch {}
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
            // The rendered background already contains the direct-avatar voice plus BGM.
            audioFromAvatar: false,
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
    clearDerivedPreviewOutputs();
    setVideoUrl(finalUrl);
    setStep("composite", "done", finalUrl);
    // Composite is still an editable preview; Burn Subtitles exports the final video.
    saveToGallery({
      videoUrl: finalUrl,
      avatarVideoUrl: avatarUrl,
      status: "PROCESSING",
    });
    return finalUrl;
  }

  async function runAvatarTail(audioUrl: string): Promise<string> {
    setStep("avatarTail", "running", `Trimming tail audio ${avatarTailSecs}s...`);
    setAvatarTailGreenUrl("");
    const trimRes = await fetch("/api/videos/trim-audio", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioUrl, durationSecs: 0, tailSecs: avatarTailSecs }),
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
      if (abortRef.current) return;
      toast.success(captionsRef.current.length > 0
        ? "Avatar preview พร้อมแล้ว — ปรับซับ แล้วกด Burn & Download ตอนจบ"
        : "Avatar preview พร้อมแล้ว");
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.message === "__SUPERSEDED__")) return;
      if (handlePlanError(err)) return;
      if (!handleMissingKey(err, "runAvatarPipeline")) showErrorToast(err);
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
        // ElevenLabs TTS ต้องการ key (ข้ามถ้าใช้ Direct URL mode)
        const needsTts = !(avatarInputMode === "direct" && !!avatarDirectUrl.trim());
        if (needsTts && ttsProvider === "elevenlabs" && !keysData.elevenlabsKey) {
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
    stepStartedAtRef.current = {};
    trackEvent("editor_script_ready", {
      category: "product",
      path: "/video-editor",
      status: "started",
      properties: {
        scriptChars: script.trim().length,
        ttsProvider,
        stockSource,
        useAvatar,
      },
    });

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

      if (!abortRef.current) toast.success("Preview พร้อมแล้ว — ปรับซับ แล้วกด Burn & Download ตอนจบ");
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.message === "__SUPERSEDED__")) return;
      if (handlePlanError(err)) return;
      if (!handleMissingKey(err, "runAll")) showErrorToast(err);
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
    trackEvent("editor_script_ready", {
      category: "product",
      path: "/video-editor",
      status: "started",
      properties: {
        scriptChars: script.trim().length,
        resumedFrom: String(startStep),
        ttsProvider,
        stockSource,
        useAvatar,
      },
    });
    try {
      // ── Always ensure we have voice + caps first (so keywords gets accurate duration) ──
      const isDirectMode = avatarInputMode === "direct" && !!avatarDirectUrl.trim();
      let vUrl = pipe.current.voiceUrl ?? "";
      if (!vUrl || startStep === "tts") {
        if (isDirectMode) {
          setStep("tts", "skip", "ข้าม — ใช้เสียงจาก Direct URL");
          vUrl = avatarDirectUrl.trim();
          pipe.current.voiceUrl = vUrl;
        } else {
          vUrl = await runTts();
          if (abortRef.current) return;
        }
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

      if (!abortRef.current) toast.success("Preview พร้อมแล้ว — ปรับซับ แล้วกด Burn & Download ตอนจบ");
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.message === "__SUPERSEDED__")) return;
      if (handlePlanError(err)) return;
      if (!handleMissingKey(err, "runAll")) showErrorToast(err);
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
      if (!abortRef.current) toast.success("Render preview พร้อมแล้ว — กด Burn & Download ตอนจบ");
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.message === "__SUPERSEDED__")) return;
      if (!handlePlanError(err)) showErrorToast(err);
    } finally {
      runningRef.current = false; setRunning(false);
    }
  }

  // Burn subtitles onto an already-rendered video using SubtitleOverlayComposition.
  // Priority: compositeUrl (render + avatar) > renderedVideoNoSubUrl (render only).
  // Using compositeUrl ensures the avatar is preserved in the final burned video.
  async function burnSubtitlesCore({
    toastOnSuccess = true,
    toastOnError = true,
  }: { toastOnSuccess?: boolean; toastOnError?: boolean } = {}) {
    const baseVideo = pipe.current.compositeUrl || pipe.current.renderedVideoNoSubUrl;
    if (!baseVideo) throw new Error("ต้อง Render วิดีโอก่อน แล้วค่อย Burn Subtitles");
    if (!captionsRef.current.length) throw new Error("ไม่มีซับให้ Burn — กรุณา Transcribe ก่อน");
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
        // Burn output is the final user-facing clip. Keep renderedVideoNoSubUrl as
        // the editable base, but show/download/save the burned version.
        pipe.current.burnedVideoUrl = url;
        setVideoUrl(url);
        lastRenderedStyleRef.current = {
          fontFamily: subFontFamily, fontSize: subFontSize, fontWeight: subFontWeight,
          color: subColor, accentColor: subAccentColor, preset: subPreset, effect: subEffect, position: subPosition,
          captions: captionsRef.current.map(c => ({ ...c })),
        };
        setStyleIsDirty(false);
        setStep("burnSubtitles", "done", url);
        setRenderProgress(100);
        // Update Gallery: replace videoUrl with the burned-in version (final result)
        saveToGallery({
          videoUrl: url,
          videoUrlNoSub: pipe.current.renderedVideoNoSubUrl,
          avatarVideoUrl: pipe.current.compositeUrl ? avatarGreenUrl || undefined : undefined,
          status: "COMPLETED",
        });
        if (toastOnSuccess) toast.success("Burn Subtitles เสร็จแล้ว! วิดีโอมีซับพร้อม Download");
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
      if (err instanceof Error && (err.name === "AbortError" || err.message === "__SUPERSEDED__")) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      setStep("burnSubtitles", "error", msg);
      if (toastOnError) toast.error(msg);
      throw err;
    } finally {
      stopPoll();
    }
  }

  async function runBurnSubtitles() {
    if (runningRef.current) return;
    runningRef.current = true; setRunning(true);
    abortRef.current = false;
    abortControllerRef.current = new AbortController();
    try {
      await burnSubtitlesCore();
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.message === "__SUPERSEDED__")) return;
    } finally {
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

  const burnedPreviewUrl = pipe.current.burnedVideoUrl || "";
  const burnedPreviewIsClean = Boolean(burnedPreviewUrl && !styleIsDirty);
  const editablePreviewUrl = pipe.current.compositeUrl || pipe.current.renderedVideoNoSubUrl || preRenderUrl || "";
  const previewVideoUrl = burnedPreviewIsClean
    ? burnedPreviewUrl
    : editablePreviewUrl || videoUrl || preRenderUrl;
  const previewUsesBurnedOutput = Boolean(burnedPreviewUrl && previewVideoUrl === burnedPreviewUrl);

  // activeSub: only show when video is ready AND a caption is active at current time.
  // Burned MP4s already contain subtitles. When the style becomes dirty we switch
  // back to the no-sub/composite base so the draggable live overlay does not stack
  // on top of old burned subtitles.
  const hasVideo = !!previewVideoUrl;
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
    if (v.paused || v.ended) {
      void v.play();
    } else {
      v.pause();
    }
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
      "ve-no-padding relative flex flex-col bg-[#0c0c0f] text-slate-100 overflow-hidden text-[13px]",
      isEditorExpanded ? "fixed inset-0 z-[200]" : "flex-1 min-h-0"
    )}>
      {/* Sci-fi accent — subtle neon grid + cyan glow so the editor matches the
          rest of the app's theme. Purely decorative: sits behind all UI, never
          intercepts clicks, and leaves every panel/timeline colour untouched. */}
      <div aria-hidden className="ve-scifi-grid pointer-events-none absolute inset-0 z-0" />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 h-64 w-[60%] rounded-full blur-3xl z-0"
        style={{ background: "radial-gradient(closest-side, hsl(190 100% 50% / 0.10), transparent)" }}
      />

      {/* ── TOPBAR ── */}
      <div className="relative z-10 h-12 bg-[#111115]/85 backdrop-blur-sm border-b border-cyan-500/15 flex items-center gap-2 px-4 flex-shrink-0">
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
                    // Already-burned path — make sure Gallery has the latest version
                    // (covers the case where the user loaded a draft whose galleryVideoId
                    // was never persisted, so the burn pass never linked it.)
                    await saveToGallery({
                      videoUrl: dlUrl,
                      videoUrlNoSub: pipe.current.renderedVideoNoSubUrl,
                      status: "COMPLETED",
                    });
                    const a = document.createElement("a");
                    a.href = dlUrl; a.download = ""; a.click();
                    toast.success("ดาวน์โหลดและบันทึกลง Gallery แล้ว");
                  } else {
                    // Need either composite (render+avatar) or plain render before we can burn
                    const baseAvailable = pipe.current.compositeUrl || pipe.current.renderedVideoNoSubUrl;
                    if (!baseAvailable) { toast.error("ต้อง Render วิดีโอก่อน"); return; }
                    toast("กำลัง Burn Subtitles...", { duration: 3000 });
                    await runBurnSubtitles();
                    const burned = pipe.current.burnedVideoUrl;
                    if (burned) {
                      // runBurnSubtitles → finalizeBurn → saveToGallery is already called
                      // inside, so we don't double-save here. Just download.
                      const a = document.createElement("a"); a.href = burned; a.download = ""; a.click();
                      toast.success("Burn + Download + บันทึกลง Gallery แล้ว");
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
          <button onClick={() => {
              if (running) { stopAll(); return; }
              if (!script.trim()) return;
              setRenderSettingsOpen(true);
            }} disabled={!script.trim()}
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
                  resetEditorState();
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
      <div className="relative z-10 flex flex-1 overflow-hidden">

        {/* ── LEFT: TRANSCRIPT ── */}
        <div className="relative flex-shrink-0 bg-[#111115]/90 border-r border-cyan-500/15 flex flex-col" style={{ width: leftPanelWidth }}>
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

          <div className="flex-1 overflow-y-auto py-2 px-2 flex flex-col gap-1">

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
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider flex-1 flex items-center gap-1.5">
                      <Pencil className="w-3 h-3" />
                      TTS Script
                    </span>
                    {scriptOverride.trim() && (
                      <span className="text-[9px] bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded px-1.5 py-0.5 font-bold">แก้แล้ว</span>
                    )}
                    <ChevronDown className={cn("w-3 h-3 text-slate-600 transition-transform", showScriptOverride ? "rotate-180" : "")} />
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
                  ref={isActive ? activeSegCardRef : null}
                  className={cn("rounded-xl border transition-all group",
                    isActive ? "bg-violet-500/10 border-violet-500/40" : "bg-transparent border-transparent hover:bg-[#1a1a22] hover:border-[#2a2a36]")}>

                  {/* Header row */}
                  <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1 cursor-pointer"
                    onClick={() => {
                      setActiveSegIdx(i);
                      setActiveCaptionIdx(i);
                      // cap.startMs is caption-space; map to video-space before seeking.
                      if (videoRef.current) {
                        videoRef.current.currentTime = captionMsToVideoMs(cap.startMs) / 1000;
                      }
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
              {/* Order matches runAll: TTS → Transcribe → Keywords → B-roll → Config → Render → (Avatar/Composite) → Burn */}
              {(() => {
              const visibleSteps = ([ ["tts","TTS Voice"], ["transcribe","Transcribe"], ["keywords","Keywords"], ["fetchStock","B-roll"], ["config","Config"], ["render","Render"], ["avatar","Avatar"], ["avatarTail","Avatar Tail"], ["composite","Composite"], ["burnSubtitles","Burn Subtitles"] ] as [keyof StepState, string][]).filter(([k]) => {
                if (!useAvatar && (k === "avatar" || k === "avatarTail" || k === "composite")) return false;
                if (k === "avatarTail" && avatarTiming !== "bookend-both") return false;
                if (k === "burnSubtitles" && steps.burnSubtitles === "idle" && steps.render === "idle") return false;
                return true;
              });
              // The next action = first idle step whose previous step is already done.
              // Used to highlight exactly ONE row so the user knows what to click next
              // (e.g. after the avatar pipeline stops at Composite → Burn Subtitles).
              const nextActionIdx = visibleSteps.findIndex(([k], i) =>
                steps[k] === "idle" && (i === 0 || steps[visibleSteps[i - 1][0]] === "done")
              );
              return visibleSteps.map(([k, label], stepIdx) => {
                const isDone = steps[k] === "done";
                const isError = steps[k] === "error";
                const isIdle = steps[k] === "idle";
                const isRunning = steps[k] === "running";
                const log = logs[k] ?? "";
                const burnedUrl = k === "burnSubtitles" ? (pipe.current.burnedVideoUrl ?? "") : "";
                const isVideoUrl = isDone && (k === "render" || k === "tts" || k === "avatar" || k === "avatarTail" || k === "composite") && log.startsWith("/");
                const isBurnDone = isDone && k === "burnSubtitles" && !!burnedUrl;
                const isClickable = isDone || isError;

                // Direct-URL mode supplies the avatar video itself — there's
                // nothing to "generate", so the Avatar/Tail/Composite steps have no
                // standalone Run action (they run as part of the main pipeline).
                const isDirectAvatar = avatarInputMode === "direct";
                // Determine the run action for this step
                const stepRunAction: (() => void) | null = !running ? (() => {
                  if (k === "burnSubtitles") return () => runBurnSubtitles();
                  if (k === "avatar" || k === "avatarTail" || k === "composite") return (useAvatar && !isDirectAvatar) ? () => runAvatarPipeline() : null;
                  if (k === "render") return pipe.current.config ? () => runRenderOnly() : () => runFrom("render");
                  if (k === "tts" && avatarInputMode === "direct" && avatarDirectUrl.trim()) return null;
                  return () => runFrom(k as keyof StepState);
                })() : null;

                // "▶ Run" shown always when idle (and runnable), "↺" shown on hover when done/error
                // Burn needs either composite (avatar) or no-sub render as base
                const burnHasBase = !!(pipe.current.compositeUrl || pipe.current.renderedVideoNoSubUrl);
                const showRunBtn = !running && isIdle && stepRunAction !== null && (
                  k !== "burnSubtitles" || (burnHasBase && captions.length > 0 && !running)
                ) && (
                  k !== "avatar" && k !== "avatarTail" && k !== "composite" || (useAvatar && !isDirectAvatar)
                );
                const showRerunBtn = !running && (isDone || isError) && stepRunAction !== null;

                const labelColor = isRunning ? "text-violet-300"
                  : isDone ? "text-emerald-400 group-hover:text-emerald-300"
                  : isError ? "text-red-400"
                  : showRunBtn ? "text-slate-400"
                  : "text-slate-600";

                // The single next-action step (e.g. Burn after the avatar pipeline
                // stops at Composite) gets a highlighted row so it's obvious what to
                // click next — but only when it's actually runnable.
                const isNextAction = showRunBtn && stepIdx === nextActionIdx;

                return (
                  <div key={k}
                    className={cn("flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors group",
                      isClickable ? "cursor-pointer hover:bg-[#1a1a22]" : "",
                      isNextAction ? "bg-emerald-500/10 ring-1 ring-emerald-500/40 animate-pulse" : "")}
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
                        className={cn("rounded font-bold text-white transition-colors",
                          k === "burnSubtitles"
                            ? "px-2.5 py-1 text-[10px] bg-emerald-600 hover:bg-emerald-500 shadow-sm shadow-emerald-500/30"
                            : "px-2 py-0.5 text-[9px] bg-violet-700/70 hover:bg-violet-600"
                        )}
                      >{k === "burnSubtitles" ? "▶ Burn ซับ" : "▶ Run"}</button>
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
              });
              })()}
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
        <div ref={centerPanelRef} className="flex-1 flex flex-col bg-[#0c0c0f]/80 min-w-0">
          {/* Preview area with dot grid */}
          <div className="flex-1 flex items-center justify-center relative overflow-hidden"
            style={{ backgroundImage: "radial-gradient(circle,#1e1e2a 1px,transparent 1px)", backgroundSize: "24px 24px" }}>

            {/* Phone frame.
                In fullscreen the .video-editor-phone-frame CSS rule expands this
                to 100vw/100vh — subtitle overlay travels along because it uses
                percentage positioning. */}
            <div ref={phoneFrameRef} className="video-editor-phone-frame relative select-none" style={{ width: 260, height: 462 }}>

              {/* Video layer */}
              <div className="absolute inset-0 rounded-2xl overflow-hidden shadow-[0_0_0_1px_#2a2a36,0_24px_64px_rgba(0,0,0,0.8)]"
                style={{ background: "linear-gradient(160deg,#0f0f1a 0%,#1a0f2e 40%,#0f1a2e 100%)" }}>
                {previewVideoUrl ? (
                  <video
                    ref={videoRef}
                    src={previewVideoUrl}
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
                  <div className="h-full bg-violet-500 transition-none" style={{ width: totalMs > 0 ? `${(playheadMs / totalMs) * 100}%` : "0%" }} />
                </div>
              </div>

              {/* Subtitle overlay — draggable, clickable */}
              {!previewUsesBurnedOutput && (() => {
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

                    {/* Subtitle text — matches Remotion render exactly.
                        data-subtitle-text lets the :fullscreen CSS upscale the font
                        when the phone-frame is fullscreened, so the subtitle stays
                        legible at viewport-width sizes. */}
                    <div data-subtitle-text style={{ width: "100%", textAlign: "center" }} onClick={e => { e.stopPropagation(); setActiveRightTab("font"); }}>
                      {(() => {
                        const PREVIEW_FPS = 30;
                        const capDurMs = Math.max(1, cap.endMs - cap.startMs);
                        const capDurFrames = Math.max(1, Math.round((capDurMs / 1000) * PREVIEW_FPS));
                        const elapsedMs = Math.max(0, Math.min(capDurMs, playheadMs - cap.startMs));
                        // frame for the INNER text effects (glow-pulse/highlight/karaoke/
                        // typewriter). -1 when paused = resting/fully-visible.
                        const frame = playing ? Math.round((elapsedMs / 1000) * PREVIEW_FPS) : -1;

                        // Container ENTRANCE animation — must MATCH AnimatedSubtitle
                        // (ShortVideoComposition) so preview === burned MP4. We can't
                        // call Remotion spring() here, so approximate it: same start/end
                        // values and similar durations, with an ease that mimics the
                        // spring's settle. Only animates while playing; when paused we
                        // show the resting state (transform none, opacity 1).
                        const f = playing ? Math.max(0, Math.round((elapsedMs / 1000) * PREVIEW_FPS)) : 9999;
                        const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
                        const easeBack = (t: number) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
                        const prog = (dur: number) => Math.min(1, f / dur);
                        const fadeIn = Math.min(1, f / 5);
                        let tf = "", op = 1;
                        if (subEffect === "pop")        { const t = easeOut(prog(12)); tf = `translateY(${6*(1-t)}px) scale(${0.76+0.24*t})`; }
                        else if (subEffect === "bounce"){ const t = easeBack(prog(18)); tf = `translateY(${14*(1-Math.min(1,t))}px) scale(${0.5+0.5*t})`; }
                        else if (subEffect === "quick") { const t = easeOut(prog(6));  tf = `translateY(${8*(1-t)}px) scale(${0.6+0.4*t})`; }
                        else if (subEffect === "fade")  { op = Math.min(1, f/8); }
                        else if (subEffect === "slide") { const t = easeOut(prog(16)); tf = `translateY(${40*(1-t)}px)`; op = fadeIn; }
                        else if (subEffect === "flip")  { const t = easeOut(prog(14)); tf = `perspective(600px) rotateX(${90*(1-t)}deg)`; op = Math.min(1, f/6); }
                        return (
                          <div style={{ transform: tf || undefined, opacity: op, transformOrigin: subEffect === "flip" ? "center top" : "center" }}>
                            {renderSubEl(cap.text, subColor, subAccentColor, cap.tag === "hook", subPreset, subFontFamily, subFontSize, subFontWeight, previewScale, subEffect, frame, capDurFrames)}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                );
              })()}

              {/* Border overlay */}
              <div className="absolute inset-0 rounded-2xl pointer-events-none" style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.07)" }} />
            </div>

            {/* Avatar direct-URL note — only shown when relevant (audio controls live in playback bar below) */}
            {ttsUrl && avatarInputMode === "direct" && (
              <div className="absolute bottom-3 left-3 right-3 text-center text-[9px] text-slate-600">🔇 Direct URL — เสียงอยู่ในวิดีโอ</div>
            )}
          </div>

          {/* ── Playback controls ──
              No overflow-hidden: would clip the volume popup that lives above the bar.
              isolate keeps the popup's z-50 scoped to this toolbar. */}
          <div className="relative isolate h-12 bg-[#111115] border-t border-[#1e1e28] flex flex-nowrap items-center gap-2 px-4 flex-shrink-0 min-w-0">
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

            {/* Scrubber — hover shows time preview, drag to seek */}
            <ScrubberBar
              currentMs={currentMs}
              totalMs={totalMs}
              durationMs={durationMs}
              isScrubbing={isScrubbing}
              setIsScrubbing={setIsScrubbing}
              videoRef={videoRef}
              setCurrentMs={setCurrentMs}
              fmtMs={fmtMs}
            />

            <span className="text-[11px] text-slate-600 tabular-nums flex-shrink-0">/ {fmtMs(totalMs)}</span>

            <div className="w-px h-4 bg-[#2a2a36] mx-1 flex-shrink-0" />

            {/* Volume — hover icon to show slider; click icon to toggle mute */}
            <div className="relative flex items-center flex-shrink-0"
              onMouseEnter={() => setShowVolumeSlider(true)}
              onMouseLeave={() => setShowVolumeSlider(false)}>
              <button onClick={() => setMuted(m => !m)}
                className="w-7 h-7 rounded flex items-center justify-center text-slate-500 hover:text-slate-200 transition-colors">
                {muted || volume === 0 ? <VolumeX className="w-3.5 h-3.5" /> : volume < 0.5 ? <Volume1 className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
              </button>
              {/* Volume slider popup — invisible bridge prevents hover-gap losing focus */}
              {showVolumeSlider && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 pb-2 z-50">
                  <div className="bg-[#1a1a22] border border-[#2a2a36] rounded-xl p-3 shadow-2xl flex flex-col items-center gap-2" style={{ width: 36 }}>
                  {/* Vertical slider — wider hit area for easier click/drag */}
                  <div className="relative h-20 w-6 cursor-pointer flex-shrink-0 flex items-center justify-center touch-none select-none outline-none focus:outline-none" tabIndex={-1}
                    onPointerDown={e => {
                      e.currentTarget.setPointerCapture(e.pointerId);
                      const r = e.currentTarget.getBoundingClientRect();
                      const pct = 1 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
                      const v = Math.round(pct * 100) / 100;
                      setVolume(v);
                      if (videoRef.current) videoRef.current.volume = v;
                      setMuted(v === 0);
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
                    <div className="relative h-full w-1.5 rounded-full bg-[#2a2a36] pointer-events-none">
                      <div className="absolute bottom-0 left-0 right-0 bg-violet-500 rounded-full" style={{ height: `${(muted ? 0 : volume) * 100}%` }} />
                      <div className="absolute left-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-white border-2 border-violet-500 shadow-[0_0_8px_rgba(124,58,237,0.6)]" style={{ bottom: `calc(${(muted ? 0 : volume) * 100}% - 6px)` }} />
                    </div>
                  </div>
                    <span className="text-[9px] text-slate-500 tabular-nums">{muted ? 0 : Math.round(volume * 100)}</span>
                  </div>
                </div>
              )}
            </div>

            {/* Fullscreen — fullscreen the PHONE FRAME (video + subtitle overlay).
                Earlier this fullscreened the <video> element directly, which left
                the absolute-positioned subtitle <div> behind in the editor → user
                report: 'ขยายหน้าจอแล้วไม่มีซับ'.
                Now we fullscreen phoneFrameRef so the subtitle overlay travels with
                the video. Falls back to center panel → document body. */}
            <button onClick={async () => {
                try {
                  if (document.fullscreenElement) {
                    await document.exitFullscreen();
                    return;
                  }
                  const target =
                    (phoneFrameRef.current as HTMLElement | null)
                    ?? (centerPanelRef.current as HTMLElement | null)
                    ?? document.documentElement;
                  const req = (target as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen
                    ?? target.requestFullscreen;
                  if (req) await req.call(target);
                  else toast.error("เบราว์เซอร์นี้ไม่รองรับ fullscreen");
                } catch (err) {
                  console.error("[fullscreen] failed:", err);
                  toast.error("เปิด fullscreen ไม่ได้ — ลองคลิกบนหน้าจอก่อน แล้วลองใหม่");
                }
              }}
              className="w-7 h-7 rounded flex items-center justify-center text-slate-500 hover:text-slate-200 transition-colors flex-shrink-0"
              title={isFullscreen ? "ออกจาก fullscreen" : "ดู fullscreen"}>
              {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* ── RIGHT: SUBTITLE SETTINGS ── */}
        {!rightPanelOpen && !panelDetached && (
          <div className="flex-shrink-0 border-l border-[#1e1e28] flex flex-col h-full bg-[#111115]" style={{ width: 32 }}>
            <div className="h-11 flex items-center justify-center border-b border-[#1e1e28] flex-shrink-0">
              <button onClick={() => setRightPanelOpen(true)}
                className="w-6 h-6 flex items-center justify-center text-slate-600 hover:text-slate-300 transition-colors rounded"
                title="Open settings panel">
                <ChevronLeft className="w-3 h-3" />
              </button>
            </div>
          </div>
        )}

        {/* Order panel + Settings — wrapped together with single resize handle on left edge */}
        {rightPanelOpen && !panelDetached && (
          <div className="flex-shrink-0 flex flex-row h-full overflow-hidden">
            {/* Resize handle — ลากเพื่อขยาย/ย่อ Settings panel */}
            <div
              className="relative w-1 flex-shrink-0 cursor-col-resize z-10 group border-l border-[#1e1e28]"
              onPointerDown={e => { e.preventDefault(); rightResizeRef.current = { startX: e.clientX, startW: rightPanelWidth }; }}
            >
              <div className="absolute inset-0 group-hover:bg-violet-500/30 group-active:bg-violet-500/60 transition-colors" />
            </div>
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
              onReloadAvatar={() => loadAvatarInfo(avatarId)} avatarStatus={avatarStatus}
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
            <div className="flex-shrink-0 border-l border-[#1e1e28] flex flex-col h-full" style={{ width: rightPanelWidth }}>
              <RightSettingsPanel
                wide={rightPanelWide} detached={false} dragging={false}
                panelPos={panelPos} panelWidth={rightPanelWidth}
                onDetach={() => { const pw = 360; setPanelPos({ x: Math.max(40, window.innerWidth - pw - 60), y: 60 }); setPanelDetached(true); }}
                onDock={() => { setPanelDetached(false); setRightPanelOpen(true); }}
                onToggleWide={() => {}}
                onClose={() => { setRightPanelOpen(false); setRightPanelWidth(268); }}
                onDragStart={() => {}} onDragMove={() => {}} onDragEnd={() => {}}
                activeTab={activeRightTab} onTab={setActiveRightTab}
                allCaptions={captions} activeCaptionIdx={activeCaptionIdx}
                onSeekCaption={idx => {
                  setActiveCaptionIdx(idx);
                  setActiveSegIdx(idx);
                  const cap = captions[idx];
                  if (cap && videoRef.current) {
                    videoRef.current.currentTime = captionMsToVideoMs(cap.startMs) / 1000;
                  }
                }}
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
                avatarPreviewUrl={avatarPreviewUrl} avatarName={avatarName} onReloadAvatar={() => loadAvatarInfo(avatarId)} avatarStatus={avatarStatus}
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
            allCaptions={captions} activeCaptionIdx={activeCaptionIdx}
            onSeekCaption={idx => {
              setActiveCaptionIdx(idx);
              setActiveSegIdx(idx);
              const cap = captions[idx];
              if (cap && videoRef.current) {
                videoRef.current.currentTime = captionMsToVideoMs(cap.startMs) / 1000;
              }
            }}
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
            avatarPreviewUrl={avatarPreviewUrl} avatarName={avatarName} onReloadAvatar={() => loadAvatarInfo(avatarId)} avatarStatus={avatarStatus}
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
      <div className="relative z-10 flex-shrink-0 bg-[#0e0e13] border-t border-[#1e1e28] flex flex-col" style={{ height: timelineHeight }}>
        {/* Timeline resize handle */}
        <div
          className="absolute top-0 left-0 right-0 h-1 cursor-row-resize z-10 group"
          onPointerDown={e => { e.preventDefault(); timelineResizeRef.current = { startY: e.clientY, startH: timelineHeight }; }}
        >
          <div className="absolute top-0 left-0 right-0 h-px bg-[#1e1e28] group-hover:bg-violet-500/60 group-active:bg-violet-500 transition-colors" />
        </div>

        {/* Timeline toolbar */}
        <div className="h-10 bg-[#111115] border-b border-[#1e1e28] flex items-center gap-2 px-4 flex-shrink-0">
          <span className="text-violet-400 font-bold tabular-nums text-[12px]">{fmtMs(playheadMs)}</span>
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
                const splitMs = playheadMs;
                if (splitMs <= 0 || activeSegIdx < 0 || activeSegIdx >= displayCaptions.length) return;
                const cap = displayCaptions[activeSegIdx];
                if (splitMs <= cap.startMs || splitMs >= cap.endMs) return;
                const a: Caption = { ...cap, endMs: splitMs };
                const b: Caption = { ...cap, text: cap.text, startMs: splitMs };
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
            {/* Timeline stays at max 100% so playhead/caption positions remain easy to scan. */}
            <div
              className="relative w-20 h-5 flex items-center touch-none select-none outline-none"
              tabIndex={-1}
            >
              <div className="relative w-full h-1 rounded-full bg-[#2a2a36] pointer-events-none">
                <div className="absolute left-0 top-0 h-full bg-violet-500 rounded-full" style={{ width: "100%" }} />
                <div
                  className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-white border-2 border-violet-500 shadow-[0_0_6px_rgba(124,58,237,0.5)]"
                  style={{ left: "100%" }}
                />
              </div>
            </div>
            <span className="text-[11px] text-slate-600 tabular-nums min-w-[32px] text-right">100%</span>
          </div>
        </div>

        {/* Timeline tracks — wrapper allows vertical scroll when tracks exceed panel height */}
        <div className="flex flex-1 overflow-y-auto overflow-x-hidden">
          {/* Track labels — sticky so labels stay visible during horizontal scroll of track content */}
          <div className="w-[110px] flex-shrink-0 border-r border-[#1e1e28] sticky left-0 z-10 bg-[#0e0e13]">
            <div className="h-[22px] border-b border-[#1e1e28]" />
            {[["💬","Subtitles"],["🎬","B-roll"],["🎤","Voice"],["🎵","Music"]].map(([icon, label]) => (
              <div key={label} className="h-[38px] flex items-center gap-2 px-3 border-b border-[#1a1a20] last:border-b-0">
                <span className="text-[11px] opacity-60">{icon}</span>
                <span className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">{label}</span>
              </div>
            ))}
          </div>

          {/* Track content */}
          <div className="tl-track-content flex-1 overflow-x-auto overflow-y-hidden relative"
            onPointerMove={e => {
              const r = clipResizeRef.current;
              if (!r || e.buttons !== 1) return;
              const trackEl = e.currentTarget.querySelector(".tl-subtitle-track") as HTMLElement | null;
              if (!trackEl) return;
              const trackW = trackEl.getBoundingClientRect().width;
              const dxPx = e.clientX - r.startX;
              // Track drag distance — used to distinguish click vs drag on release
              if (Math.abs(dxPx) > 3) r.moved = true;
              const dxMs = (dxPx / trackW) * totalMs;
              setCaptionsRaw(prev => {
                const next = prev.map((c, j) => {
                  if (j !== r.capIdx) return c;
                  const prevClip = prev[j - 1];
                  const nextClip = prev[j + 1];
                  const minGap = 50; // ms gap ระหว่าง clip
                  const lowerBound = prevClip ? prevClip.endMs + minGap : 0;
                  const upperBound = nextClip ? nextClip.startMs - minGap : (totalMs || 999999);
                  if (r.edge === "left") {
                    const newStart = Math.max(lowerBound, Math.min(c.endMs - 200, r.startMs + dxMs));
                    return { ...c, startMs: Math.round(newStart) };
                  } else if (r.edge === "right") {
                    const newEnd = Math.max(c.startMs + 200, Math.min(upperBound, r.startMs + dxMs));
                    return { ...c, endMs: Math.round(newEnd) };
                  } else {
                    // "move" — slide whole clip, preserving duration, clamp between neighbors
                    const dur = r.durMs ?? (c.endMs - c.startMs);
                    const maxStart = Math.max(lowerBound, upperBound - dur);
                    const newStart = Math.max(lowerBound, Math.min(maxStart, r.startMs + dxMs));
                    return { ...c, startMs: Math.round(newStart), endMs: Math.round(newStart + dur) };
                  }
                });
                captionsRef.current = next;
                return next;
              });
            }}
            onPointerUp={() => {
              if (clipResizeRef.current) {
                if (clipResizeRef.current.moved) {
                  setCaptions(captions); // push to history on release (only if actually dragged)
                }
                clipResizeRef.current = null;
              }
            }}
          >
            <div className="relative" style={{ width: "100%", minWidth: "100%" }}>

              {/* Ruler — click/drag to seek */}
              <div className="h-[22px] bg-[#0a0a10] border-b border-[#1e1e28] relative flex items-end cursor-pointer"
                onPointerDown={e => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  if (!videoRef.current || !totalMs) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
                  // Timeline is in caption-space; convert to video-space before seeking.
                  const captionMs = pct * totalMs;
                  const videoMs = captionMsToVideoMs(captionMs);
                  videoRef.current.currentTime = videoMs / 1000;
                  setCurrentMs(videoMs);
                }}
                onPointerMove={e => {
                  if (e.buttons !== 1 || !videoRef.current || !totalMs) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
                  // Timeline is in caption-space; convert to video-space before seeking.
                  const captionMs = pct * totalMs;
                  const videoMs = captionMsToVideoMs(captionMs);
                  videoRef.current.currentTime = videoMs / 1000;
                  setCurrentMs(videoMs);
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
                  const isTiny = width < 0.3; // clip แคบมากจริงๆ เท่านั้นถึงซ่อนข้อความ
                  const startResize = (e: React.PointerEvent, edge: "left" | "right" | "move") => {
                    e.stopPropagation();
                    const trackContent = e.currentTarget.closest(".tl-track-content") as HTMLElement | null;
                    if (trackContent) trackContent.setPointerCapture(e.pointerId);
                    clipResizeRef.current = {
                      capIdx: i,
                      edge,
                      startX: e.clientX,
                      startMs: edge === "right" ? cap.endMs : cap.startMs,
                      durMs: cap.endMs - cap.startMs,
                      moved: false,
                    };
                  };
                  return (
                    <div key={i}
                      title={cap.text}
                      onPointerDown={e => startResize(e, "move")}
                      onClick={() => {
                        if (clipResizeRef.current?.moved) return;
                        setActiveSegIdx(i);
                        if (videoRef.current) {
                          videoRef.current.currentTime = captionMsToVideoMs(cap.startMs) / 1000;
                        }
                      }}
                      className={cn("absolute top-1.5 h-[26px] rounded-md flex items-center text-[10px] font-semibold overflow-hidden whitespace-nowrap border transition-all hover:brightness-125 select-none touch-none cursor-grab active:cursor-grabbing",
                        i === activeSegIdx ? `${tagClipBg(cap.tag)} ring-1 ring-white/20` : tagClipBg(cap.tag))}
                      style={{ left: `${left}%`, width: `calc(${Math.max(0.4, width)}% - 2px)`, marginRight: "2px" }}>
                      <div className="absolute left-0 top-0 bottom-0 w-2.5 cursor-ew-resize hover:bg-white/20 rounded-l-md z-10"
                        onPointerDown={e => startResize(e, "left")} />
                      {!isTiny && <span className="truncate px-3 pointer-events-none">{cap.text.slice(0, 20)}{cap.text.length > 20 ? "…" : ""}</span>}
                      <div className="absolute right-0 top-0 bottom-0 w-2.5 cursor-ew-resize hover:bg-white/20 rounded-r-md z-10"
                        onPointerDown={e => startResize(e, "right")} />
                    </div>
                  );
                })}
              </div>

              {/* B-roll clips — aligned 1:1 with subtitle timing when caption count matches.
                  Falls back to even-split when stockVideos > captions (pre-config / mismatch). */}
              <div className="h-[38px] relative border-b border-[#1a1a20]">
                {stockVideos.length > 0 ? (() => {
                  const perCaption = stockVideos.length === captions.length && totalMs > 0;
                  return stockVideos.map((sv, i) => {
                    let left: number, width: number;
                    if (perCaption) {
                      const cap = captions[i];
                      left = (cap.startMs / totalMs) * 100;
                      width = Math.max(0.5, ((cap.endMs - cap.startMs) / totalMs) * 100 - 0.3);
                    } else {
                      const n = stockVideos.length;
                      left = (i / n) * 100;
                      width = (1 / n) * 100 - 0.3;
                    }
                    return (
                      <div key={i} className="absolute top-1.5 h-[26px] rounded-md flex items-center px-2 text-[10px] font-semibold bg-sky-500/10 border border-sky-500/25 text-sky-300 overflow-hidden whitespace-nowrap cursor-pointer hover:brightness-125 transition-all"
                        style={{ left: `${left}%`, width: `${width}%` }}>
                        <div className="absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize bg-white/10 rounded-l-md" />
                        <span className="truncate">{sv.keyword || `Clip ${i + 1}`}</span>
                        <div className="absolute right-0 top-0 bottom-0 w-1 cursor-ew-resize bg-white/10 rounded-r-md" />
                      </div>
                    );
                  });
                })() : (
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

              {/* Playhead — uses playheadMs (video-time mapped into caption-time) so it
                  tracks the caption clips exactly, even when the video is longer. */}
              <div className="absolute top-0 bottom-0 w-[1.5px] bg-violet-500 pointer-events-none z-10"
                style={{ left: totalMs > 0 ? `${(playheadMs / totalMs) * 100}%` : "0%" }}>
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

      {/* Render settings modal */}
      {renderSettingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setRenderSettingsOpen(false)}>
          <div className="relative w-full max-w-sm mx-4 rounded-2xl overflow-hidden" onClick={e => e.stopPropagation()}
            style={{ background: "linear-gradient(145deg, #0f0f18, #16102a)", border: "1px solid rgba(139,92,246,0.3)", boxShadow: "0 0 40px rgba(109,40,217,0.25)" }}>
            {/* glow top */}
            <div className="absolute inset-x-0 top-0 h-px" style={{ background: "linear-gradient(90deg, transparent, rgba(167,139,250,0.6), transparent)" }} />
            <div className="p-5 space-y-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-white">ตั้งค่าการเรนเดอร์</h3>
                <button onClick={() => setRenderSettingsOpen(false)} className="text-slate-500 hover:text-slate-300 transition-colors"><X className="w-4 h-4" /></button>
              </div>

              {/* FPS */}
              <div className="space-y-2">
                <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">เลือก FPS สำหรับเรนเดอร์</p>
                <div className="space-y-1.5">
                  {([
                    { fps: 24 as const, label: "24 FPS", desc: "ซีเนมาติค เหมาะกับหนัง" },
                    { fps: 30 as const, label: "30 FPS", desc: "แนะนำ - ไฟล์เล็ก เรนเดอร์เร็ว", recommended: true },
                    { fps: 50 as const, label: "50 FPS", desc: "อัพเกรดแพลนเพื่อปลดล็อค", locked: true },
                    { fps: 60 as const, label: "60 FPS", desc: "อัพเกรดแพลนเพื่อปลดล็อค", locked: true },
                  ] as { fps: 24|30|50|60; label: string; desc: string; recommended?: boolean; locked?: boolean }[]).map(opt => (
                    <button key={opt.fps}
                      disabled={opt.locked}
                      onClick={() => !opt.locked && setRenderFps(opt.fps)}
                      className={cn("w-full text-left px-3 py-2.5 rounded-xl border transition-all",
                        opt.locked ? "opacity-40 cursor-not-allowed" : "cursor-pointer",
                        renderFps === opt.fps && !opt.locked
                          ? "border-violet-500 bg-violet-500/10"
                          : "border-white/8 hover:border-white/20 bg-white/3"
                      )}>
                      <div className="flex items-center justify-between">
                        <span className="text-[13px] font-bold text-white">{opt.label}</span>
                        {opt.locked && <span className="text-[10px] text-slate-500">🔒</span>}
                      </div>
                      <p className="text-[11px] text-slate-500 mt-0.5">{opt.desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Quality */}
              <div className="space-y-2">
                <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">คุณภาพไฟล์</p>
                <div className="space-y-1.5">
                  {([
                    { q: "480p" as const, label: "คุณภาพต่ำ", desc: "ไฟล์เล็ก เรนเดอร์เร็วสุด" },
                    { q: "720p" as const, label: "คุณภาพสูง", desc: "แนะนำ - คุณภาพดี ไฟล์เล็ก", recommended: true },
                    { q: "1080p" as const, label: "คุณภาพสูงสุด", desc: "อัพเกรดแพลนเพื่อปลดล็อค", locked: true },
                  ] as { q: "480p"|"720p"|"1080p"; label: string; desc: string; recommended?: boolean; locked?: boolean }[]).map(opt => (
                    <button key={opt.q}
                      disabled={opt.locked}
                      onClick={() => !opt.locked && setRenderQuality(opt.q)}
                      className={cn("w-full text-left px-3 py-2.5 rounded-xl border transition-all",
                        opt.locked ? "opacity-40 cursor-not-allowed" : "cursor-pointer",
                        renderQuality === opt.q && !opt.locked
                          ? "border-violet-500 bg-violet-500/10"
                          : "border-white/8 hover:border-white/20 bg-white/3"
                      )}>
                      <div className="flex items-center justify-between">
                        <span className="text-[13px] font-bold text-white">{opt.label}</span>
                        {opt.locked && <span className="text-[10px] text-slate-500">🔒</span>}
                      </div>
                      <p className="text-[11px] text-slate-500 mt-0.5">{opt.desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Start button */}
              <button
                onClick={() => { setRenderSettingsOpen(false); runAll(); }}
                className="w-full py-3 rounded-xl text-[13px] font-bold text-white transition-all hover:brightness-110"
                style={{ background: "linear-gradient(135deg, hsl(252 83% 58%), hsl(220 90% 62%))", boxShadow: "0 2px 16px rgba(109,40,217,0.5)" }}>
                เริ่มเรนเดอร์
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden audio element for TTS preview before video is ready */}
      <audio ref={audioRef} src={ttsUrl || undefined} muted={avatarInputMode === "direct"} style={{ display: "none" }} />
    </div>
  );
}
