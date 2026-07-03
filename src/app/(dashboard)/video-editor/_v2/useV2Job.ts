"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { V2Project } from "./useV2Project";
import type { ParsedVideoJobOutput } from "@/lib/mcp/video-job";

/**
 * Editor v2 background-render job (P4b) — submit → poll → done/failed + resume.
 * jobId persists ใน localStorage: ปิดแท็บได้ งานวิ่งต่อบน server (mcp-video-worker)
 * กลับมา = resume สถานะอัตโนมัติ ("ปิดหน้าได้ งานทำต่อ" ตามดีไซน์ 5b — ของจริง)
 */

const STORAGE_KEY = "editor-v2-job";
const POLL_MS = 5000;

export type V2JobPhase = "idle" | "submitting" | "rendering" | "done" | "failed";

export interface V2JobState {
  phase: V2JobPhase;
  jobId: string | null;
  currentStep: string | null;
  progress: number;
  errorMessage: string | null;
  output: ParsedVideoJobOutput | null;
}

const IDLE: V2JobState = { phase: "idle", jobId: null, currentStep: null, progress: 0, errorMessage: null, output: null };

export function useV2Job(p: V2Project) {
  const [job, setJob] = useState<V2JobState>(IDLE);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const jobIdRef = useRef<string | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const applyStatus = useCallback((d: {
    id: string; status: string; currentStep: string | null; progress: number;
    errorMessage: string | null; output?: ParsedVideoJobOutput | null;
  }) => {
    // done/failed ห้ามลบ jobId ที่จำไว้ — ไม่งั้นออกจากหน้าแล้วกลับมา งาน "หาย" ทั้งที่
    // วิดีโอ+ซับยังอยู่ (บั๊กที่ Mew เจอตอน QA 07-03). ลบเฉพาะตอนผู้ใช้สั่งเอง (reset:
    // เริ่มโปรเจกต์ใหม่ / กลับไปตั้งค่า) หรือ Burn เสร็จใน P6.
    if (d.status === "done") {
      stopPolling();
      setJob({ phase: "done", jobId: d.id, currentStep: d.currentStep, progress: 100, errorMessage: null, output: d.output ?? null });
    } else if (d.status === "failed" || d.status === "canceled") {
      stopPolling();
      setJob({ phase: "failed", jobId: d.id, currentStep: d.currentStep, progress: d.progress ?? 0, errorMessage: d.errorMessage ?? "งานไม่สำเร็จ", output: null });
    } else {
      setJob({ phase: "rendering", jobId: d.id, currentStep: d.currentStep, progress: d.progress ?? 0, errorMessage: null, output: null });
    }
  }, [stopPolling]);

  const pollOnce = useCallback(async (jobId: string) => {
    try {
      const res = await fetch(`/api/videos/jobs/${encodeURIComponent(jobId)}`);
      if (res.status === 404) {
        stopPolling();
        try { localStorage.removeItem(STORAGE_KEY); } catch {}
        setJob(IDLE);
        return;
      }
      if (!res.ok) return; // transient — คง state เดิม รอรอบถัดไป
      const d = await res.json();
      applyStatus(d);
    } catch { /* transient network — รอรอบถัดไป */ }
  }, [applyStatus, stopPolling]);

  const startPolling = useCallback((jobId: string) => {
    jobIdRef.current = jobId;
    stopPolling();
    void pollOnce(jobId);
    pollRef.current = setInterval(() => { void pollOnce(jobId); }, POLL_MS);
  }, [pollOnce, stopPolling]);

  // Resume on mount: draft jobId → โหลดสถานะทันที (แท็บใหม่/กลับมาใหม่)
  useEffect(() => {
    let stored: string | null = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch {}
    if (stored) startPolling(stored);
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** ยิงงานจริง (previewMode ฝั่ง server) จาก project state ปัจจุบัน */
  const submit = useCallback(async (): Promise<{ ok: boolean; message?: string }> => {
    setJob((j) => ({ ...j, phase: "submitting", errorMessage: null }));
    try {
      // โหมดอัปคลิปเอง (cutaway): ส่งแค่คลิป + b-roll — เสียง/เพลง/อวตารมาจากคลิป
      const body: Record<string, unknown> = p.mode === "upload" ? {
        mode: "upload",
        clipUrl: p.clipUrl,
        stockSource: p.brollSource === "kie-image" ? "kie-image" : p.brollSource === "automix" ? "auto-mix" : "stock",
        ...(p.targetClipCount > 0 ? { targetClipCount: p.targetClipCount } : {}),
        ...(p.kieModel && (p.brollSource === "kie-image" || p.brollSource === "automix") ? { kieModel: p.kieModel } : {}),
        ...(p.brollSource === "automix" ? { autoMixProviders: p.autoMixProviders } : {}),
        subtitleMode: "sentence",
        subtitlePosition: "bottom",
      } : {
        script: p.script,
        voiceProvider: p.voiceEngine,
        ...(p.voiceEngine === "gemini" ? { geminiVoiceName: p.geminiVoiceName } : {}),
        ...(p.voiceEngine === "elevenlabs" && p.voiceId ? { voiceId: p.voiceId } : {}),
        // เพลง: system track → path ตรง (resolver ฝั่ง server รองรับ) · null = ไม่ใส่เพลง
        ...(p.musicTrack ? { bgmFile: `/music/${p.musicTrack}` } : {}),
        // b-roll source ที่เลือกจริง (kie-image/auto-mix = Beta, server เช็ค admin ซ้ำ)
        stockSource: p.brollSource === "kie-image" ? "kie-image" : p.brollSource === "automix" ? "auto-mix" : "stock",
        // อวตาร: โหมด/วินาทีจากขั้นสูง (default bookend 5 วิ — ประหยัด HeyGen)
        ...(p.useAvatar && p.avatarId
          ? { avatarMode: p.avatarMode, avatarId: p.avatarId, avatarIntroSecs: p.avatarIntroSecs, avatarTailSecs: p.avatarTailSecs }
          : {}),
        ...(p.targetClipCount > 0 ? { targetClipCount: p.targetClipCount } : {}),
        ...(p.kieModel && (p.brollSource === "kie-image" || p.brollSource === "automix") ? { kieModel: p.kieModel } : {}),
        ...(p.brollSource === "automix" ? { autoMixProviders: p.autoMixProviders } : {}),
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
      try { localStorage.setItem(STORAGE_KEY, d.jobId); } catch {}
      setJob({ phase: "rendering", jobId: d.jobId, currentStep: null, progress: 0, errorMessage: null, output: null });
      startPolling(d.jobId);
      return { ok: true };
    } catch {
      setJob((j) => ({ ...j, phase: "idle" }));
      return { ok: false, message: "เครือข่ายมีปัญหา — ลองใหม่อีกครั้ง" };
    }
  }, [p, startPolling]);

  /** ยกเลิก — สำเร็จเฉพาะงานที่ยังอยู่ในคิว (ยังไม่เริ่มทำ) */
  const cancel = useCallback(async (): Promise<{ ok: boolean; message?: string }> => {
    const id = jobIdRef.current ?? job.jobId;
    if (!id) return { ok: false };
    try {
      const res = await fetch(`/api/videos/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.ok) {
        stopPolling();
        try { localStorage.removeItem(STORAGE_KEY); } catch {}
        setJob(IDLE);
        return { ok: true };
      }
      const d = await res.json().catch(() => null);
      return { ok: false, message: d?.message ?? "งานเริ่มทำไปแล้ว — ยกเลิกไม่ได้" };
    } catch {
      return { ok: false, message: "เครือข่ายมีปัญหา" };
    }
  }, [job.jobId, stopPolling]);

  /** เคลียร์ state (หลัง done/failed → กลับไปตั้งค่า) */
  const reset = useCallback(() => {
    stopPolling();
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    setJob(IDLE);
  }, [stopPolling]);

  /** Export สำเร็จ = งานนี้จบแล้ว: ลืม jobId (ออกจากหน้าแล้วกลับมา → เริ่ม step 1 สด)
   *  แต่ไม่แตะ state ในหน้า — user ยังแก้ซับต่อ/ส่งออกซ้ำได้จนกว่าจะออก (spec ข้อ 5) */
  const markExported = useCallback(() => {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }, []);

  return { job, submit, cancel, reset, markExported };
}
