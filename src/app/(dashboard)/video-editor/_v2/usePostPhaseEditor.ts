"use client";

/**
 * usePostPhaseEditor — เจ้าของ state/logic ทั้งหมดของเฟสแต่งซับ (แยกจาก PostPhase.tsx
 * เพื่อให้จอ desktop และ mobile ใช้ hook ตัวเดียวกัน — one source of truth: caption/
 * style/burn state, undo history, avatar re-composite trigger, export path).
 *
 * ⚠️ นี่คือการ "ย้าย" logic ล้วน (behavior-preserving) — subtitle timing math และ
 * avatar composite ยังคงเดิมทุกบรรทัด. hook เป็นเจ้าของ videoRef (Shell mount จอ
 * แต่งซับทีละจอเท่านั้น → ref ไม่ชนกัน).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  DEFAULT_V2_SUB, buildV2BurnConfig,
  mergeCaptionWithNext, splitCaption, regroupCaptions,
  type V2CardLen, type V2SubConfig, type V2Caption, type V2CardOverrides,
} from "./subtitle-style";
import { loanwordSpans } from "@/lib/thai-loanwords";
import { trackEvent } from "@/lib/client-telemetry";
import {
  normalizeLogoOverlayConfig,
  type LogoOverlayConfig,
} from "@/lib/logo-overlay";
import {
  canToggleAvatarLayer,
  normalizeEditorLayerVisibility,
  resolveEditorPreviewVideoUrl,
  type EditableEditorLayer,
  type EditorLayerVisibility,
} from "@/lib/editor-layer-visibility";
import type { V2JobState } from "./useV2Job";
import { findActiveCaptionIdx } from "../_lib/find-active-caption";
import {
  buildLogoTelemetryProperties,
  useLogoOverlayEditor,
  type LogoEditorSurface,
  type LogoProjectSaveStatus,
} from "./useLogoOverlayEditor";

export type ExportState =
  | { phase: "idle" }
  | { phase: "burning"; progress: number }
  | { phase: "saving" }
  | { phase: "done"; url: string }
  | { phase: "error"; message: string };

// Phase 2 per-window b-roll editing (Task 11) — batched, applied via the free
// broll-rerender job mode (Task 10). `kind` drives the source badge/label in the
// inspector; `label` is a human-readable title (candidate title / "อัปโหลด" / "AI").
export type WindowEditKind = "stock" | "upload" | "ai";
export type WindowEdit = { src: string; keyword?: string; kind: WindowEditKind; label: string };

const ignoreLogoChange = (_next: LogoOverlayConfig | undefined) => {
  void _next;
};
const ignoreProjectSaveRetry = () => undefined;
type LayerVisibilityChange = EditorLayerVisibility | ((current: EditorLayerVisibility) => EditorLayerVisibility);

const ignoreLayerVisibilityChange = (_next: LayerVisibilityChange) => {
  void _next;
};

export type UsePostPhaseEditorOptions = {
  onExportJob: (input: { sourceJobId: string; subtitleOverlayConfig: unknown; script?: string; sceneCount?: number }) => Promise<{ ok: boolean; message?: string }>;
  /** Adopt the NEW job produced by a broll-rerender apply as the active job (jobId +
   *  localStorage resume key). Wired from useV2Job.adoptJob via PostPhase/PostPhaseMobile. */
  onAdoptJob: (next: { id: string; projectId?: string | null }) => void;
  projectId?: string | null;
  logoOverlay?: LogoOverlayConfig;
  onLogoOverlayChange?: (next: LogoOverlayConfig | undefined) => void;
  layerVisibility?: EditorLayerVisibility;
  onLayerVisibilityChange?: (next: LayerVisibilityChange) => void;
  logoEligible?: boolean;
  projectSaveStatus?: LogoProjectSaveStatus;
  onRetryProjectSave?: () => void;
  surface?: LogoEditorSurface;
};

export function usePostPhaseEditor(
  job: V2JobState,
  script: string,
  options: UsePostPhaseEditorOptions,
) {
  const {
    onExportJob,
    onAdoptJob,
    projectId = job.projectId,
    logoOverlay,
    onLogoOverlayChange = ignoreLogoChange,
    layerVisibility,
    onLayerVisibilityChange = ignoreLayerVisibilityChange,
    logoEligible = false,
    projectSaveStatus = "idle",
    onRetryProjectSave = ignoreProjectSaveRetry,
    surface = "desktop",
  } = options;
  const preview = job.output?.preview ?? null;
  const [baseUrl, setBaseUrl] = useState(job.output?.videoUrl ?? "");
  const [captions, setCaptions] = useState<V2Caption[]>(() => preview?.captions ?? []);
  const [selected, setSelected] = useState(0);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [cfg, setCfg] = useState<V2SubConfig>(DEFAULT_V2_SUB);
  const [exp, setExp] = useState<ExportState>({ phase: "idle" });
  const logo = useLogoOverlayEditor({
    projectId,
    eligible: logoEligible,
    value: logoOverlay,
    onChange: onLogoOverlayChange,
    projectSaveStatus,
    onRetryProjectSave,
    surface,
  });
  // ความยาวการ์ด (1 ประโยค / ≤4 / ≤3 / ≤2 / 1 คำ — semantics เดียวกับ v1) —
  // จัดกลุ่มจากชุดต้นฉบับเสมอ (เปลี่ยนแล้วล้างการแก้รายใบ)
  const originalCapsRef = useRef<V2Caption[]>(preview?.captions ?? []);
  const [cardLen, setCardLen] = useState<V2CardLen>("sentence");
  // ปรับสี scope รายการ์ด
  const [scope, setScope] = useState<"all" | "card">("all");
  const [overrides, setOverrides] = useState<V2CardOverrides>({});
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pendingVideoSourceSwapRef = useRef<{ time: number; resume: boolean } | null>(null);
  const [timeMs, setTimeMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const pollStop = useRef(false);
  const windowPollStop = useRef(false);
  const [adjustingAvatar, setAdjustingAvatar] = useState(false);

  // ── Phase 2: per-window b-roll editing (Task 11) ──────────────────────────
  // windowEdits ล้วนอยู่ฝั่ง client จนกว่าจะกด "อัปเดตวิดีโอ" (batched, ไม่เรนเดอร์ทีละจุด).
  // configOverride แทนที่ preview.config หลัง apply สำเร็จ (เห็น bgVideos ใหม่บน timeline)
  // — captions/overrides/cfg เป็น state แยกอยู่แล้ว (init ครั้งเดียวจาก preview เดิม) จึงไม่ถูก
  // เขียนทับตอน config เปลี่ยน (ตามสเปค: ต้องรอด "ไม่แตะ" ของแก้ซับ).
  const [windowEdits, setWindowEditsState] = useState<Map<number, WindowEdit>>(new Map());
  const [selectedWindow, setSelectedWindow] = useState<number | null>(null);
  const [applyingWindows, setApplyingWindows] = useState<{ progress: number } | null>(null);
  const [configOverride, setConfigOverride] = useState<Record<string, unknown> | null>(null);
  const previewConfig = configOverride ?? preview?.config ?? null;
  // compositeBaseUrl แทนที่ preview.compositeBaseUrl หลัง apply สำเร็จ (งาน avatar) —
  // ไม่งั้น AvatarAdjustOverlay จะ re-composite ทับ base เก่า (ก่อนแก้ b-roll) แล้วเขียน
  // ทับผลแก้ b-roll ทิ้งอย่างเงียบๆ ตอนกด save ใน Avatar Adjust (บั๊กที่ fix นี้แก้)
  const [compositeBaseUrlOverride, setCompositeBaseUrlOverride] = useState<string | null>(null);
  const compositeBaseUrl = compositeBaseUrlOverride ?? preview?.compositeBaseUrl ?? null;

  function setWindowEdit(index: number, edit: WindowEdit) {
    setWindowEditsState((m) => {
      const next = new Map(m);
      next.set(index, edit);
      return next;
    });
  }
  function clearWindowEdit(index: number) {
    setWindowEditsState((m) => {
      if (!m.has(index)) return m;
      const next = new Map(m);
      next.delete(index);
      return next;
    });
  }

  /** ส่งงาน broll-rerender (ฟรี, ไม่ใช้นาที) → poll จนเสร็จ → swap videoUrl+config ในที่
   *  (ตามแนว AvatarAdjustOverlay.apply) → เคลียร์ windowEdits ที่ apply แล้ว */
  async function applyWindowEdits() {
    if (windowEdits.size === 0 || applyingWindows) return;
    const sourceJobId = job.jobId;
    if (!sourceJobId) { toast.error("ไม่พบวิดีโอต้นฉบับ"); return; }
    setApplyingWindows({ progress: 0 });
    const edits = Array.from(windowEdits.entries()).map(([index, e]) => ({
      index, src: e.src, ...(e.keyword ? { keyword: e.keyword } : {}),
    }));
    try {
      const res = await fetch("/api/videos/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: `editor-v2-broll-rerender-${globalThis.crypto.randomUUID()}`,
          mode: "broll-rerender",
          sourceJobId,
          windowEdits: edits,
        }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.jobId) throw new Error(d?.message ?? d?.error ?? `อัปเดตวิดีโอไม่สำเร็จ (${res.status})`);
      const newJobId = d.jobId as string;

      let done = false;
      for (let i = 0; i < 450 && !windowPollStop.current; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        let p: {
          status?: string; progress?: number; errorMessage?: string; projectId?: string | null;
          output?: { videoUrl?: string; preview?: { config?: Record<string, unknown>; compositeBaseUrl?: string | null } };
        } | null = null;
        try {
          p = await fetch(`/api/videos/jobs/${encodeURIComponent(newJobId)}`).then((r) => r.json());
        } catch { continue; }
        if (!p) continue;
        if (typeof p.progress === "number") setApplyingWindows({ progress: Math.max(0, Math.min(100, Math.round(p.progress))) });
        if (p.status === "done") {
          const newVideoUrl = p.output?.videoUrl;
          if (!newVideoUrl) throw new Error("อัปเดตวิดีโอไม่สำเร็จ — ไม่พบไฟล์วิดีโอใหม่");
          setBaseUrl(newVideoUrl);
          if (p.output?.preview?.config) setConfigOverride(p.output.preview.config);
          if (p.output?.preview?.compositeBaseUrl) setCompositeBaseUrlOverride(p.output.preview.compositeBaseUrl);
          const v = videoRef.current;
          if (v) { v.load(); v.currentTime = 0; }
          setWindowEditsState(new Map());
          // Adopt the NEW job: repoint jobId + localStorage resume key so a refresh resumes
          // this result and the NEXT apply chains onto it (sourceJobId = job.jobId). Caption/
          // style state is untouched — only the source job identity moves forward.
          onAdoptJob({ id: newJobId, projectId: p.projectId ?? job.projectId ?? null });
          toast.success("อัปเดตวิดีโอแล้ว");
          done = true;
          break;
        }
        if (p.status === "failed" || p.status === "canceled") {
          throw new Error(p.errorMessage ?? "อัปเดตวิดีโอไม่สำเร็จ");
        }
      }
      if (!done && !windowPollStop.current) throw new Error("อัปเดตวิดีโอไม่เสร็จในเวลาที่กำหนด — เช็คสถานะภายหลัง");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "อัปเดตวิดีโอไม่สำเร็จ");
    } finally {
      setApplyingWindows(null);
    }
  }
  // ปรับได้เมื่องานนี้มีอวตาร + worker เก็บข้อมูล re-composite ไว้ (งานเก่าก่อนฟีเจอร์นี้ = ซ่อน)
  // bookend-both ต้องมี tailAvatarUrl ด้วย ไม่งั้น composite split ขาดท่อน
  const canAdjustAvatar = !!(
    preview?.avatarModel && preview.avatarModel !== "none" &&
    preview.avatarVideoUrl && compositeBaseUrl && preview.avatarMode &&
    (preview.avatarMode !== "bookend-both" || preview.tailAvatarUrl)
  );
  const hasAvatar = Boolean(preview?.avatarModel && preview.avatarModel !== "none");
  const canToggleAvatar = canToggleAvatarLayer({
    hasAvatar,
    avatarBaseVideoUrl: compositeBaseUrl,
  });
  const persistedLayerVisibility = normalizeEditorLayerVisibility(layerVisibility);
  const effectiveLayerVisibility: EditorLayerVisibility = {
    ...persistedLayerVisibility,
    avatar: canToggleAvatar ? persistedLayerVisibility.avatar : true,
  };
  const logoConfig = normalizeLogoOverlayConfig(logoOverlay);
  const editorLayerVisibility: Record<EditableEditorLayer, boolean> = {
    avatar: effectiveLayerVisibility.avatar,
    subtitles: effectiveLayerVisibility.subtitles,
    logo: Boolean(logoConfig?.enabled),
  };
  const layerAvailability: Record<EditableEditorLayer, boolean> = {
    avatar: canToggleAvatar,
    subtitles: captions.length > 0,
    logo: Boolean(logoConfig),
  };
  const previewVideoUrl = resolveEditorPreviewVideoUrl({
    renderedVideoUrl: baseUrl,
    avatarBaseVideoUrl: compositeBaseUrl,
    avatarVisible: effectiveLayerVisibility.avatar,
  });

  function setLayerEnabled(layer: EditableEditorLayer, enabled: boolean) {
    if (!layerAvailability[layer]) return;
    if (layer === "avatar") {
      const video = videoRef.current;
      pendingVideoSourceSwapRef.current = video
        ? { time: video.currentTime, resume: !video.paused && !video.ended }
        : null;
      onLayerVisibilityChange((current) => ({
        ...normalizeEditorLayerVisibility(current),
        avatar: enabled,
      }));
    } else if (layer === "subtitles") {
      onLayerVisibilityChange((current) => ({
        ...normalizeEditorLayerVisibility(current),
        subtitles: enabled,
      }));
    } else {
      logo.setEnabled(enabled);
    }
    trackEvent("editor_layer_visibility_changed", {
      status: "done",
      properties: { layer, enabled, surface },
    });
  }

  useEffect(() => {
    const pending = pendingVideoSourceSwapRef.current;
    const video = videoRef.current;
    if (!pending || !video) return;
    const restorePlayback = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : pending.time;
      video.currentTime = Math.min(pending.time, Math.max(0, duration));
      setTimeMs(video.currentTime * 1000);
      pendingVideoSourceSwapRef.current = null;
      if (pending.resume) void video.play().catch(() => undefined);
    };
    video.addEventListener("loadedmetadata", restorePlayback, { once: true });
    video.load();
    return () => video.removeEventListener("loadedmetadata", restorePlayback);
  }, [previewVideoUrl]);

  // การ์ดที่ "กำลังพูด" ตาม preview (แยกจาก selected = การ์ดที่เลือกแก้)
  const activeIdx = useMemo(() => findActiveCaptionIdx(captions, timeMs), [captions, timeMs]);
  const [follow, setFollow] = useState(true);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const lastAutoScrollAt = useRef(0);

  // auto-scroll ตามการ์ด active — หยุดชั่วคราวถ้ากำลังพิมพ์แก้ซับ (กันเลื่อนหนี)
  useEffect(() => {
    if (!follow || !playing || editingIdx !== null || activeIdx < 0) return;
    const el = cardRefs.current[activeIdx];
    if (!el) return;
    lastAutoScrollAt.current = Date.now();
    el.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [activeIdx, follow, playing, editingIdx]);

  function onListScroll() {
    // programmatic scroll ใช้ behavior:"auto" (จบใน frame เดียว) — event ของมันตกใน window นี้เสมอ ที่เหลือ = ผู้ใช้เลื่อนเอง
    if (Date.now() - lastAutoScrollAt.current < 700) return;
    if (playing && follow) setFollow(false);
  }

  function resumeFollow() {
    setFollow(true);
    const el = activeIdx >= 0 ? cardRefs.current[activeIdx] : null;
    if (el) { lastAutoScrollAt.current = Date.now(); el.scrollIntoView({ block: "nearest", behavior: "auto" }); }
  }

  // Undo history สำหรับการแก้เวลาซับบน timeline (push เฉพาะตอน commit = ปล่อยเมาส์)
  const historyRef = useRef<V2Caption[][]>([]);
  const committedRef = useRef<V2Caption[]>(preview?.captions ?? []);
  const [historyLen, setHistoryLen] = useState(0);
  function handleCaptionsChange(next: V2Caption[], commit: boolean) {
    setCaptions(next);
    if (commit) {
      historyRef.current.push(committedRef.current.map((c) => ({ ...c })));
      if (historyRef.current.length > 50) historyRef.current.shift();
      committedRef.current = next.map((c) => ({ ...c }));
      setHistoryLen(historyRef.current.length);
    }
  }
  function undoCaptions() {
    const prev = historyRef.current.pop();
    if (!prev) return;
    committedRef.current = prev.map((c) => ({ ...c }));
    setCaptions(prev);
    setHistoryLen(historyRef.current.length);
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT";
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        if (typing) return; // ให้ undo ของช่องพิมพ์ทำงานปกติ
        e.preventDefault();
        undoCaptions();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      // shortcuts แบบ editor ทั่วไป (v1 มี space อยู่แล้ว — page.tsx:630)
      const v = videoRef.current;
      if (!v) return;
      if (e.key === " ") {
        e.preventDefault();
        if (v.paused || v.ended) void v.play(); else v.pause();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        v.currentTime = Math.max(0, v.currentTime - 1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => { pollStop.current = true; windowPollStop.current = true; }, []);

  function set<K extends keyof V2SubConfig>(k: K, v: V2SubConfig[K]) {
    setCfg((c) => ({ ...c, [k]: v }));
  }

  /** สี text/accent เคารพ scope: ทั้งคลิป = config กลาง · การ์ดนี้ = override รายใบ */
  function setColorScoped(key: "textColor" | "accentColor", v: string) {
    if (scope === "card") {
      setOverrides((o) => ({ ...o, [selected]: { ...o[selected], [key]: v } }));
    } else {
      set(key, v);
    }
  }
  const activeOverride = overrides[selected] ?? {};

  function applyCardLen(len: V2CardLen) {
    setCardLen(len);
    setOverrides({});
    handleCaptionsChange(regroupCaptions(originalCapsRef.current, len, preview?.words, preview?.fullText), true);
    setSelected(0);
  }

  /** เลื่อน key ของ override รายการ์ดตามการเปลี่ยนโครงการ์ด — ห้ามล้างทั้ง map
   *  (QA 07-03: รวม/แยกการ์ด 2-3 เคยทำให้สีที่ตั้งไว้บนการ์ด 1 หายไปด้วย) */
  function shiftOverrides(from: number, delta: number, dropIdx?: number) {
    setOverrides((o) => {
      const next: V2CardOverrides = {};
      for (const [k, v] of Object.entries(o)) {
        const idx = Number(k);
        if (dropIdx !== undefined && idx === dropIdx) continue;
        next[idx >= from ? idx + delta : idx] = v;
      }
      return next;
    });
  }

  function mergeSelected() {
    if (selected >= captions.length - 1) { toast("การ์ดสุดท้าย — ไม่มีใบถัดไปให้รวม"); return; }
    shiftOverrides(selected + 2, -1, selected + 1); // ใบที่ถูกกลืนทิ้ง override ของตัวเอง ที่เหลือเลื่อนซ้าย
    handleCaptionsChange(mergeCaptionWithNext(captions, selected), true);
  }

  function splitSelected() {
    const next = splitCaption(captions, selected, loanwordSpans(captions[selected]?.text ?? ""));
    if (next === captions) { toast("การ์ดสั้นเกินไปหรือหาจุดตัดไม่ได้"); return; }
    shiftOverrides(selected + 1, +1); // ใบครึ่งซ้ายเก็บ override เดิม ใบใหม่ขวาเริ่มว่าง
    handleCaptionsChange(next, true);
  }

  async function exportVideo() {
    if (!baseUrl || !captions.length || exp.phase === "burning" || exp.phase === "saving") return;
    if (!job.jobId) {
      setExp({ phase: "error", message: "ไม่พบวิดีโอต้นฉบับ" });
      return;
    }
    setExp({ phase: "saving" });
    try {
      const overlay = buildV2BurnConfig(
        previewVideoUrl,
        captions,
        preview?.audioDurationMs ?? 0,
        cfg,
        30,
        overrides,
        logoOverlay,
        effectiveLayerVisibility,
      );
      const result = await onExportJob({
        sourceJobId: job.jobId,
        subtitleOverlayConfig: overlay,
        script: script.trim() || preview?.fullText || undefined,
        sceneCount: captions.length,
      });
      if (!result.ok) throw new Error(result.message ?? "ส่งออกไม่สำเร็จ");
      const submittedLogo = normalizeLogoOverlayConfig(logoOverlay);
      if (submittedLogo?.enabled) {
        trackEvent("logo_overlay_export_submitted", {
          properties: buildLogoTelemetryProperties({
            surface,
            position: submittedLogo.position,
          }),
        });
      }
    } catch (e) {
      setExp({ phase: "error", message: e instanceof Error ? e.message : "ส่งออกไม่สำเร็จ" });
    }
  }

  return {
    preview,
    logo,
    layerVisibility: editorLayerVisibility,
    layerAvailability,
    setLayerEnabled,
    previewVideoUrl,
    previewConfig,
    compositeBaseUrl,
    windowEdits, setWindowEdit, clearWindowEdit,
    selectedWindow, setSelectedWindow,
    applyWindowEdits, applyingWindows,
    baseUrl, setBaseUrl,
    captions, setCaptions,
    selected, setSelected,
    editingIdx, setEditingIdx,
    cfg, setCfg,
    exp, setExp,
    cardLen,
    scope, setScope,
    overrides, setOverrides,
    videoRef,
    timeMs, setTimeMs,
    playing, setPlaying,
    adjustingAvatar, setAdjustingAvatar,
    canAdjustAvatar,
    activeIdx,
    follow, setFollow,
    cardRefs,
    historyLen,
    activeOverride,
    handleCaptionsChange,
    undoCaptions,
    onListScroll,
    resumeFollow,
    set,
    setColorScoped,
    applyCardLen,
    mergeSelected,
    splitSelected,
    exportVideo,
  };
}

export type PostPhaseEditor = ReturnType<typeof usePostPhaseEditor>;
