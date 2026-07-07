"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { V2Project } from "./useV2Project";
import type { ParsedVideoJobOutput } from "@/lib/mcp/video-job";
import { PRESET_WEIGHTS } from "./mix-presets";

/**
 * Editor v2 background-render job (P4b) — submit → poll → done/failed + resume.
 * jobId persists ใน localStorage: ปิดแท็บได้ งานวิ่งต่อบน server (mcp-video-worker)
 * กลับมา = resume สถานะอัตโนมัติ ("ปิดหน้าได้ งานทำต่อ" ตามดีไซน์ 5b — ของจริง)
 */

const STORAGE_KEY = "editor-v2-job";
const POLL_MS = 5000;

function storageKey(projectId: string | null | undefined) {
  return projectId ? `${STORAGE_KEY}:${projectId}` : STORAGE_KEY;
}

function browserStorage() {
  if (typeof window === "undefined") return null;
  const storage = window.localStorage;
  return storage && typeof storage.getItem === "function" ? storage : null;
}

export type V2JobPhase = "idle" | "submitting" | "rendering" | "done" | "failed";

export interface V2JobState {
  phase: V2JobPhase;
  jobId: string | null;
  jobType: string | null;
  projectId: string | null;
  currentStep: string | null;
  progress: number;
  errorMessage: string | null;
  output: ParsedVideoJobOutput | null;
}

const IDLE: V2JobState = { phase: "idle", jobId: null, jobType: null, projectId: null, currentStep: null, progress: 0, errorMessage: null, output: null };

export type SubmitExportInput = {
  sourceJobId: string;
  subtitleOverlayConfig: unknown;
  script?: string;
  sceneCount?: number;
};

export function useV2Job(p: V2Project) {
  const [job, setJob] = useState<V2JobState>(IDLE);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const lastPreviewJobIdRef = useRef<string | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const applyStatus = useCallback((d: {
    id: string; projectId?: string | null; type?: string | null; status: string; currentStep: string | null; progress: number;
    errorMessage: string | null; output?: ParsedVideoJobOutput | null;
  }) => {
    // done/failed ห้ามลบ jobId ที่จำไว้ — ไม่งั้นออกจากหน้าแล้วกลับมา งาน "หาย" ทั้งที่
    // วิดีโอ+ซับยังอยู่ (บั๊กที่ Mew เจอตอน QA 07-03). ลบเฉพาะตอนผู้ใช้สั่งเอง (reset:
    // เริ่มโปรเจกต์ใหม่ / กลับไปตั้งค่า) หรือ Burn เสร็จใน P6.
    if (d.type !== "export" && d.output?.preview) {
      lastPreviewJobIdRef.current = d.id;
    }
    if (d.status === "done") {
      stopPolling();
      setJob({ phase: "done", jobId: d.id, jobType: d.type ?? null, projectId: d.projectId ?? null, currentStep: d.currentStep, progress: 100, errorMessage: null, output: d.output ?? null });
    } else if (d.status === "failed" || d.status === "canceled") {
      stopPolling();
      setJob({ phase: "failed", jobId: d.id, jobType: d.type ?? null, projectId: d.projectId ?? null, currentStep: d.currentStep, progress: d.progress ?? 0, errorMessage: d.errorMessage ?? "งานไม่สำเร็จ", output: null });
    } else {
      setJob({ phase: "rendering", jobId: d.id, jobType: d.type ?? null, projectId: d.projectId ?? null, currentStep: d.currentStep, progress: d.progress ?? 0, errorMessage: null, output: null });
    }
  }, [stopPolling]);

  const pollOnce = useCallback(async (jobId: string) => {
    try {
      const res = await fetch(`/api/videos/jobs/${encodeURIComponent(jobId)}`);
      if (res.status === 404) {
        stopPolling();
        try { browserStorage()?.removeItem(storageKey(p.projectId)); } catch {}
        setJob(IDLE);
        return;
      }
      if (!res.ok) return; // transient — คง state เดิม รอรอบถัดไป
      const d = await res.json();
      applyStatus(d);
    } catch { /* transient network — รอรอบถัดไป */ }
  }, [applyStatus, p.projectId, stopPolling]);

  const startPolling = useCallback((jobId: string) => {
    jobIdRef.current = jobId;
    stopPolling();
    void pollOnce(jobId);
    pollRef.current = setInterval(() => { void pollOnce(jobId); }, POLL_MS);
  }, [pollOnce, stopPolling]);

  // Resume from the server project row first. localStorage is only a per-project fallback
  // for older/in-flight rows that predate activeJobId/activeExportJobId wiring.
  useEffect(() => {
    if (!p.projectReady) return;
    const serverJobId =
      (p.projectStatus === "exporting" || p.projectStatus === "exported")
        ? p.activeExportJobId
        : p.activeJobId;
    let stored: string | null = null;
    try { stored = browserStorage()?.getItem(storageKey(p.projectId)) ?? null; } catch {}
    const nextJobId = serverJobId ?? stored;
    if (nextJobId && nextJobId !== jobIdRef.current) {
      startPolling(nextJobId);
    } else if (!nextJobId) {
      stopPolling();
      jobIdRef.current = null;
      setJob(IDLE);
    }
    return stopPolling;
  }, [p.projectReady, p.projectId, p.projectStatus, p.activeJobId, p.activeExportJobId, startPolling, stopPolling]);

  /** ยิงงานจริง (previewMode ฝั่ง server) จาก project state ปัจจุบัน */
  const submit = useCallback(async (): Promise<{ ok: boolean; message?: string }> => {
    setJob((j) => ({ ...j, phase: "submitting", errorMessage: null }));
    try {
      // โหมดอัปคลิปเอง (cutaway): ส่งแค่คลิป + b-roll — เสียง/เพลง/อวตารมาจากคลิป
      const body: Record<string, unknown> = p.mode === "upload" ? {
        ...(p.projectId ? { projectId: p.projectId } : {}),
        mode: "upload",
        clipUrl: p.clipUrl,
        stockSource: p.brollSource === "kie-image" ? "kie-image" : p.brollSource === "automix" ? "auto-mix" : "stock",
        ...(p.targetClipCount > 0 ? { targetClipCount: p.targetClipCount } : {}),
        ...(p.brollRegionPreference !== "auto" ? { brollRegionPreference: p.brollRegionPreference } : {}),
        ...(p.brollVisualStyle !== "auto" ? { brollVisualStyle: p.brollVisualStyle } : {}),
        ...(p.kieModel && (p.brollSource === "kie-image" || p.brollSource === "automix") ? { kieModel: p.kieModel } : {}),
        ...(p.brollSource === "automix" ? { autoMixProviders: p.autoMixProviders } : {}),
        // Mix preset weights (D5.1) — non-admins only; admins keep env weights. Server
        // (fetch-stock) honors these ONLY under MANAGED_KIE and force-zeros ai for the
        // unauthorized. brollSource is already "automix" for any preset ≠ ฟรีล้วน.
        ...(!p.isAdmin && p.brollSource === "automix" ? { autoMixWeights: PRESET_WEIGHTS[p.mixPreset] } : {}),
        subtitleMode: "sentence",
        subtitlePosition: "bottom",
      } : {
        ...(p.projectId ? { projectId: p.projectId } : {}),
        script: p.script,
        voiceProvider: p.voiceEngine,
        ...(p.voiceEngine === "gemini" ? { geminiVoiceName: p.geminiVoiceName } : {}),
        ...(p.voiceEngine === "elevenlabs" && p.voiceId ? { voiceId: p.voiceId } : {}),
        // เพลง: system → /music/<f> (resolver เดิม) · ของผู้ใช้ → /api/music/<f> (แบบ v1)
        ...(p.musicTrack ? { bgmFile: p.musicTrackKind === "user" ? `/api/music/${p.musicTrack}` : `/music/${p.musicTrack}`, bgmVolume: p.bgmVolume } : {}),
        // b-roll source ที่เลือกจริง (kie-image/auto-mix = Beta, server เช็ค admin ซ้ำ)
        stockSource: p.brollSource === "kie-image" ? "kie-image" : p.brollSource === "automix" ? "auto-mix" : "stock",
        // อวตาร: โหมด/วินาทีจากขั้นสูง (default bookend 5 วิ — ประหยัด HeyGen)
        ...(p.useAvatar && p.avatarId
          ? { avatarMode: p.avatarMode, avatarId: p.avatarId, avatarIntroSecs: p.avatarIntroSecs, avatarTailSecs: p.avatarTailSecs }
          : {}),
        ...(p.targetClipCount > 0 ? { targetClipCount: p.targetClipCount } : {}),
        ...(p.brollRegionPreference !== "auto" ? { brollRegionPreference: p.brollRegionPreference } : {}),
        ...(p.brollVisualStyle !== "auto" ? { brollVisualStyle: p.brollVisualStyle } : {}),
        ...(p.kieModel && (p.brollSource === "kie-image" || p.brollSource === "automix") ? { kieModel: p.kieModel } : {}),
        ...(p.brollSource === "automix" ? { autoMixProviders: p.autoMixProviders } : {}),
        // Mix preset weights (D5.1) — non-admins only; admins keep env weights. Server
        // (fetch-stock) honors these ONLY under MANAGED_KIE and force-zeros ai for the
        // unauthorized. brollSource is already "automix" for any preset ≠ ฟรีล้วน.
        ...(!p.isAdmin && p.brollSource === "automix" ? { autoMixWeights: PRESET_WEIGHTS[p.mixPreset] } : {}),
        subtitleMode: "sentence",
        subtitlePosition: "bottom",
      };
      const res = await fetch("/api/videos/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.jobId) {
        setJob((j) => ({ ...j, phase: "idle" }));
        return { ok: false, message: d?.message ?? d?.error ?? `ส่งงานไม่สำเร็จ (${res.status})` };
      }
      try { browserStorage()?.setItem(storageKey(p.projectId), d.jobId); } catch {}
      setJob({ phase: "rendering", jobId: d.jobId, jobType: "create", projectId: p.projectId ?? null, currentStep: null, progress: 0, errorMessage: null, output: null });
      startPolling(d.jobId);
      return { ok: true };
    } catch {
      setJob((j) => ({ ...j, phase: "idle" }));
      return { ok: false, message: "เครือข่ายมีปัญหา — ลองใหม่อีกครั้ง" };
    }
  }, [p, startPolling]);

  /** ส่งออกแบบ background job: worker เป็นเจ้าของ burn + save Gallery + project status */
  const submitExport = useCallback(async (input: SubmitExportInput): Promise<{ ok: boolean; message?: string }> => {
    if (!input.sourceJobId) return { ok: false, message: "ไม่พบวิดีโอต้นฉบับ" };
    setJob((j) => ({ ...j, phase: "submitting", errorMessage: null }));
    try {
      lastPreviewJobIdRef.current = input.sourceJobId;
      const res = await fetch("/api/videos/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "export",
          sourceJobId: input.sourceJobId,
          subtitleOverlayConfig: input.subtitleOverlayConfig,
          ...(input.script ? { script: input.script } : {}),
          ...(typeof input.sceneCount === "number" ? { exportSceneCount: input.sceneCount } : {}),
        }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.jobId) {
        setJob((j) => ({ ...j, phase: jobIdRef.current ? "done" : "idle" }));
        return { ok: false, message: d?.message ?? d?.error ?? `ส่งออกไม่สำเร็จ (${res.status})` };
      }
      try { browserStorage()?.setItem(storageKey(p.projectId), d.jobId); } catch {}
      setJob({ phase: "rendering", jobId: d.jobId, jobType: "export", projectId: p.projectId ?? null, currentStep: null, progress: 0, errorMessage: null, output: null });
      startPolling(d.jobId);
      return { ok: true };
    } catch {
      setJob((j) => ({ ...j, phase: jobIdRef.current ? "done" : "idle" }));
      return { ok: false, message: "เครือข่ายมีปัญหา — ลองใหม่อีกครั้ง" };
    }
  }, [p.projectId, startPolling]);

  /** ยกเลิก — สำเร็จเฉพาะงานที่ยังอยู่ในคิว (ยังไม่เริ่มทำ) */
  const cancel = useCallback(async (): Promise<{ ok: boolean; message?: string }> => {
    const id = jobIdRef.current ?? job.jobId;
    if (!id) return { ok: false };
    try {
      const res = await fetch(`/api/videos/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.ok) {
        stopPolling();
        const keyProjectId = job.projectId ?? p.projectId;
        const previewJobId = lastPreviewJobIdRef.current ?? p.activeJobId;
        if (job.jobType === "export" && previewJobId) {
          try { browserStorage()?.setItem(storageKey(keyProjectId), previewJobId); } catch {}
          startPolling(previewJobId);
          return { ok: true };
        }
        try { browserStorage()?.removeItem(storageKey(keyProjectId)); } catch {}
        setJob(IDLE);
        return { ok: true };
      }
      const d = await res.json().catch(() => null);
      return { ok: false, message: d?.message ?? "งานเริ่มทำไปแล้ว — ยกเลิกไม่ได้" };
    } catch {
      return { ok: false, message: "เครือข่ายมีปัญหา" };
    }
  }, [job.jobId, job.jobType, job.projectId, p.activeJobId, p.projectId, startPolling, stopPolling]);

  /** เคลียร์ state (หลัง done/failed → กลับไปตั้งค่า) */
  const reset = useCallback(() => {
    stopPolling();
    lastPreviewJobIdRef.current = null;
    try { browserStorage()?.removeItem(storageKey(job.projectId ?? p.projectId)); } catch {}
    setJob(IDLE);
  }, [job.projectId, p.projectId, stopPolling]);

  /** Adopt a NEW job as the active one after an in-place free re-render (broll-rerender).
   *  Repoints jobId + the localStorage resume key at the new job so (a) a tab refresh resumes
   *  IT — not the pre-edit job — and (b) the next re-render chains onto it (applyWindowEdits
   *  reads job.jobId as sourceJobId). The caller already holds the finished output and swapped
   *  the video/config in place, so this stays phase "done" without re-polling and does NOT
   *  touch caption/subtitle state. projectId is unchanged (the new job inherited the source's). */
  const adoptJob = useCallback((next: { id: string; projectId?: string | null }) => {
    stopPolling();
    jobIdRef.current = next.id;
    lastPreviewJobIdRef.current = next.id;
    try { browserStorage()?.setItem(storageKey(next.projectId ?? p.projectId), next.id); } catch {}
    setJob((j) => ({ ...j, jobId: next.id, jobType: j.jobType ?? "create", projectId: next.projectId ?? j.projectId }));
  }, [p.projectId, stopPolling]);

  const resumeJob = useCallback((jobId: string) => {
    if (!jobId) return;
    try { browserStorage()?.setItem(storageKey(p.projectId), jobId); } catch {}
    startPolling(jobId);
  }, [p.projectId, startPolling]);

  return { job, submit, submitExport, cancel, reset, adoptJob, resumeJob };
}
