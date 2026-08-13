"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { V2Project } from "./useV2Project";
import type { ParsedVideoJobOutput } from "@/lib/mcp/video-job";
import { isProviderErrorCode, type ProviderErrorCode } from "@/lib/provider-errors";
import type { HeygenProviderAction } from "@/lib/heygen-readiness";
import type { ProjectMediaState } from "@/lib/media-retention";
import { PRESET_WEIGHTS } from "./mix-presets";
import {
  disclosedAutoMixAiSlotIndices,
  estimateClipSecV2,
  reusableAutoMixAiSlotCount,
} from "./estimate";
import { mediaStateFromJobPoll, previewMediaStateAfterVideoError } from "./ExpiredPreviewView";
import {
  fingerprintVideoJobRequest,
  type VideoJobOperation,
} from "@/lib/video-job-idempotency";
import { authenticatedFetch } from "@/lib/authenticated-fetch";
import { buildBgmSelectionInput } from "@/lib/bgm-selection";
import { shouldSendLegacyBrollVisualStyle } from "@/lib/broll-preferences";
import { createClientPoller, type ClientPoller } from "@/lib/client-polling";
import {
  effectiveManualCutawayPieceCount,
  estimatedCutawayPieceCount,
} from "@/lib/cutaway-plan";

/**
 * Editor v2 background-render job (P4b) — submit → poll → done/failed + resume.
 * jobId persists ใน localStorage: ปิดแท็บได้ งานวิ่งต่อบน server (mcp-video-worker)
 * กลับมา = resume สถานะอัตโนมัติ ("ปิดหน้าได้ งานทำต่อ" ตามดีไซน์ 5b — ของจริง)
 */

const STORAGE_KEY = "editor-v2-job";
const POLL_MS = 5000;
// Exported so other v2 editor hooks (e.g. useEditorStylePresets) can reuse the same
// copy when they gate on p.canRunProjectOperation() instead of inventing new wording.
export const PROJECT_OPERATION_BLOCKED_MESSAGE = "โปรเจกต์ยังไม่พร้อม กรุณาจัดการการกู้คืนข้อมูลก่อน";

function storageKey(projectId: string | null | undefined) {
  return projectId ? `${STORAGE_KEY}:${projectId}` : STORAGE_KEY;
}

function browserStorage() {
  if (typeof window === "undefined") return null;
  const storage = window.localStorage;
  return storage && typeof storage.getItem === "function" ? storage : null;
}

export type V2JobPhase = "idle" | "submitting" | "rendering" | "done" | "failed";

export function pollResponseIsCurrent({
  responseGeneration,
  currentGeneration,
  responseJobId,
  currentJobId,
  responseRequestId,
  lastAppliedRequestId,
}: {
  responseGeneration: number;
  currentGeneration: number;
  responseJobId: string;
  currentJobId: string | null;
  responseRequestId: number;
  lastAppliedRequestId: number;
}): boolean {
  return (
    responseGeneration === currentGeneration &&
    responseJobId === currentJobId &&
    responseRequestId > lastAppliedRequestId
  );
}

export interface V2JobState {
  phase: V2JobPhase;
  jobId: string | null;
  jobType: string | null;
  projectId: string | null;
  contentPreflightId?: string | null;
  currentStep: string | null;
  progress: number;
  queuePosition: number | null;
  errorMessage: string | null;
  errorCode: string | null;
  errorProvider: string | null;
  output: ParsedVideoJobOutput | null;
  mediaState: ProjectMediaState | null;
}

const IDLE: V2JobState = { phase: "idle", jobId: null, jobType: null, projectId: null, currentStep: null, progress: 0, queuePosition: null, errorMessage: null, errorCode: null, errorProvider: null, output: null, mediaState: null };

export type SubmitExportInput = {
  sourceJobId: string;
  subtitleOverlayConfig: unknown;
  script?: string;
  sceneCount?: number;
};

export type SubmitResult = {
  ok: boolean;
  message?: string;
  warning?: string;
  code?: ProviderErrorCode;
  provider?: string;
  actions?: HeygenProviderAction[];
};

function isHeygenProviderAction(value: unknown): value is HeygenProviderAction {
  return value === "open_heygen" || value === "switch_faceless";
}
type OwnedSubmitAttempt = {
  kind: "create" | "export";
  projectId: string | null;
  idempotencyKey: string;
  idempotencyFingerprint: string | null;
  fingerprintPromise: Promise<string>;
  body: Record<string, unknown>;
  baselineActiveJobId: string | null;
  baselineActiveExportJobId: string | null;
  baselineStoredJobId: string | null;
  promise: Promise<SubmitResult> | null;
};

function createSubmitIdempotencyKey(kind: OwnedSubmitAttempt["kind"]): string {
  return `editor-v2-${kind}-${globalThis.crypto.randomUUID()}`;
}

function operationForAttempt(kind: OwnedSubmitAttempt["kind"]): VideoJobOperation {
  return kind === "export" ? "export" : "preview";
}

function responseMatchesAttempt(
  response: {
    idempotencyKey?: unknown;
    idempotencyFingerprint?: unknown;
    projectId?: unknown;
    type?: unknown;
  },
  attempt: OwnedSubmitAttempt,
  requireJobContext: boolean,
): boolean {
  if (
    !attempt.idempotencyFingerprint
    || response.idempotencyKey !== attempt.idempotencyKey
    || response.idempotencyFingerprint !== attempt.idempotencyFingerprint
  ) return false;
  if (!requireJobContext) return true;
  return (
    response.projectId === attempt.projectId
    && (attempt.kind === "export" ? response.type === "export" : response.type !== "export")
  );
}

function storedJobId(projectId: string | null | undefined): string | null {
  try { return browserStorage()?.getItem(storageKey(projectId)) ?? null; }
  catch { return null; }
}

export function useV2Job(p: V2Project) {
  const [job, setJob] = useState<V2JobState>(IDLE);
  const pollRef = useRef<ClientPoller | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const lastPreviewJobIdRef = useRef<string | null>(null);
  const pollGenerationRef = useRef(0);
  const pollRequestSequenceRef = useRef(0);
  const lastAppliedPollRequestRef = useRef(0);
  const previewMediaStateRef = useRef(p.previewMediaState);
  const submitAttemptRef = useRef<OwnedSubmitAttempt | null>(null);

  useEffect(() => {
    previewMediaStateRef.current = p.previewMediaState;
  }, [p.previewMediaState]);

  const stopPolling = useCallback(() => {
    pollGenerationRef.current += 1;
    pollRef.current?.stop();
    pollRef.current = null;
  }, []);

  const applyStatus = useCallback((d: {
    id: string; projectId?: string | null; contentPreflightId?: string | null; type?: string | null; status: string; currentStep: string | null; progress: number;
    queuePosition?: number | null;
    errorMessage: string | null; errorCode?: string | null; errorProvider?: string | null; output?: ParsedVideoJobOutput | null; mediaState?: ProjectMediaState | null;
    idempotencyKey?: string | null; idempotencyFingerprint?: string | null;
  }) => {
    // done/failed ห้ามลบ jobId ที่จำไว้ — ไม่งั้นออกจากหน้าแล้วกลับมา งาน "หาย" ทั้งที่
    // วิดีโอ+ซับยังอยู่ (บั๊กที่ Mew เจอตอน QA 07-03). ลบเฉพาะตอนผู้ใช้สั่งเอง (reset:
    // เริ่มโปรเจกต์ใหม่ / กลับไปตั้งค่า) หรือ Burn เสร็จใน P6.
    if (d.type !== "export" && d.output?.preview) {
      lastPreviewJobIdRef.current = d.id;
    }
    const ownedAttempt = submitAttemptRef.current;
    if (ownedAttempt && responseMatchesAttempt(d, ownedAttempt, true)) {
      submitAttemptRef.current = null;
    }
    if (d.status === "done") {
      stopPolling();
      setJob({
        phase: "done", jobId: d.id, jobType: d.type ?? null, projectId: d.projectId ?? null, contentPreflightId: d.contentPreflightId ?? null,
        currentStep: d.currentStep, progress: 100, queuePosition: null, errorMessage: null, errorCode: null, errorProvider: null, output: d.output ?? null,
        // A fresh job poll is authoritative. Project detail is only a compatibility
        // fallback for a rolling deploy where the poll response lacks mediaState.
        mediaState: mediaStateFromJobPoll(d.mediaState, previewMediaStateRef.current),
      });
    } else if (d.status === "failed" || d.status === "canceled") {
      stopPolling();
      setJob({ phase: "failed", jobId: d.id, jobType: d.type ?? null, projectId: d.projectId ?? null, contentPreflightId: d.contentPreflightId ?? null, currentStep: d.currentStep, progress: d.progress ?? 0, queuePosition: null, errorMessage: d.errorMessage ?? "งานไม่สำเร็จ", errorCode: d.errorCode ?? null, errorProvider: d.errorProvider ?? null, output: null, mediaState: null });
    } else {
      setJob({ phase: "rendering", jobId: d.id, jobType: d.type ?? null, projectId: d.projectId ?? null, contentPreflightId: d.contentPreflightId ?? null, currentStep: d.currentStep, progress: d.progress ?? 0, queuePosition: d.queuePosition ?? null, errorMessage: null, errorCode: null, errorProvider: null, output: null, mediaState: null });
    }
  }, [stopPolling]);

  const pollOnce = useCallback(async (
    jobId: string,
    generation: number,
    requestId: number,
    signal: AbortSignal,
  ) => {
    try {
      const res = await authenticatedFetch(`/api/videos/jobs/${encodeURIComponent(jobId)}`, { signal });
      if (!pollResponseIsCurrent({
        responseGeneration: generation,
        currentGeneration: pollGenerationRef.current,
        responseJobId: jobId,
        currentJobId: jobIdRef.current,
        responseRequestId: requestId,
        lastAppliedRequestId: lastAppliedPollRequestRef.current,
      })) return;
      if (res.status === 404) {
        lastAppliedPollRequestRef.current = requestId;
        stopPolling();
        try { browserStorage()?.removeItem(storageKey(p.projectId)); } catch {}
        setJob(IDLE);
        return;
      }
      if (!res.ok) throw new Error(`video_job_poll_${res.status}`);
      const d = await res.json();
      if (!pollResponseIsCurrent({
        responseGeneration: generation,
        currentGeneration: pollGenerationRef.current,
        responseJobId: jobId,
        currentJobId: jobIdRef.current,
        responseRequestId: requestId,
        lastAppliedRequestId: lastAppliedPollRequestRef.current,
      })) return;
      lastAppliedPollRequestRef.current = requestId;
      applyStatus(d);
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
  }, [applyStatus, p.projectId, stopPolling]);

  const startPolling = useCallback((jobId: string) => {
    stopPolling();
    jobIdRef.current = jobId;
    const generation = pollGenerationRef.current;
    const poller = createClientPoller({
      task: (signal) => {
        const requestId = ++pollRequestSequenceRef.current;
        return pollOnce(jobId, generation, requestId, signal);
      },
      isActive: () => (
        generation === pollGenerationRef.current
        && jobIdRef.current === jobId
      ),
      isVisible: () => document.visibilityState === "visible",
      nextDelayMs: ({ isVisible, failures }) => (
        failures >= 3 ? 30_000 : isVisible ? POLL_MS : 30_000
      ),
    });
    pollRef.current = poller;
    poller.start();
  }, [pollOnce, stopPolling]);

  useEffect(() => {
    const wake = () => {
      if (document.visibilityState === "visible") pollRef.current?.wake();
    };
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);

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
    if (nextJobId && (nextJobId !== jobIdRef.current || pollRef.current === null)) {
      // Resume candidates can predate the current POST or belong to a different
      // operation. Polling is safe, but only matching key+fingerprint evidence in
      // applyStatus may release an ambiguous attempt descriptor.
      startPolling(nextJobId);
    } else if (!nextJobId && !submitAttemptRef.current) {
      stopPolling();
      jobIdRef.current = null;
      setJob(IDLE);
    }
    return stopPolling;
  }, [p.projectReady, p.projectId, p.projectStatus, p.activeJobId, p.activeExportJobId, startPolling, stopPolling]);

  /** ยิงงานจริง (previewMode ฝั่ง server) จาก project state ปัจจุบัน */
  const submit = useCallback(async (): Promise<SubmitResult> => {
    const existingAttempt = submitAttemptRef.current;
    if (existingAttempt?.kind !== undefined && existingAttempt.kind !== "create") {
      return { ok: false, message: "มีคำขอส่งออกก่อนหน้าที่ยังยืนยันผลไม่ได้ กรุณาลองส่งออกซ้ำ" };
    }
    if (existingAttempt && existingAttempt.projectId !== (p.projectId ?? null)) {
      return { ok: false, message: "มีคำขอเรนเดอร์ของโปรเจกต์ก่อนหน้าที่ยังยืนยันผลไม่ได้ กรุณากลับไปโปรเจกต์เดิมแล้วลองซ้ำ" };
    }
    if (existingAttempt?.promise) return existingAttempt.promise;
    if (!p.canRunProjectOperation()) return { ok: false, message: PROJECT_OPERATION_BLOCKED_MESSAGE };
    const idempotencyKey = existingAttempt?.idempotencyKey ?? createSubmitIdempotencyKey("create");
    // Disclose-then-charge: send the EXACT affected/new AutoMix AI-image count the
    // Render Receipt showed as a hard server-side ceiling. The server plans with the source families
    // it can actually serve, which can raise the AI share above the quoted one — the
    // ceiling keeps the charge inside the number the user approved. Mirrors
    // RenderReceiptDialog's inputs exactly (same weights, same duration estimate).
    const receiptWeights = p.isAdmin ? PRESET_WEIGHTS.recommended : PRESET_WEIGHTS[p.mixPreset];
    const receiptEstSec = p.mode === "upload" && p.clipDurationSec > 0
      ? p.clipDurationSec
      : estimateClipSecV2(p.mode === "upload" ? "" : p.script);
    const quotedTargetClipCount = p.mode === "upload" && p.clipDurationSec > 0
      ? estimatedCutawayPieceCount(p.targetClipCount, p.clipDurationSec * 1_000)
      : p.targetClipCount;
    const submittedTargetClipCount = p.mode === "upload" && p.clipDurationSec > 0 && p.targetClipCount > 0
      ? effectiveManualCutawayPieceCount(p.targetClipCount, p.clipDurationSec * 1_000)
      : p.targetClipCount;
    const disclosedAiSlots = p.brollSource === "automix"
      ? disclosedAutoMixAiSlotIndices(receiptEstSec, receiptWeights, quotedTargetClipCount)
      : null;
    let reusableAiImages = 0;
    if (
      !existingAttempt
      && disclosedAiSlots !== null
      && (p.brandVisualAllowed || p.hasPersistedVisualPin)
      && p.projectId
      && p.brandContentPreflightId
    ) {
      try {
        const response = await authenticatedFetch(
          `/api/editor-projects/${encodeURIComponent(p.projectId)}/visual-context?preflightId=${encodeURIComponent(p.brandContentPreflightId)}`,
          { cache: "no-store" },
        );
        if (!response.ok) {
          return { ok: false, message: "ยืนยันจำนวนฉากที่ต้องสร้างใหม่ไม่สำเร็จ กรุณาลองอีกครั้ง" };
        }
        const visual = await response.json() as {
          reusableAiSceneIndices?: number[];
        };
        reusableAiImages = reusableAutoMixAiSlotCount(
          disclosedAiSlots,
          Array.isArray(visual.reusableAiSceneIndices) ? visual.reusableAiSceneIndices : [],
        );
      } catch {
        return { ok: false, message: "ยืนยันจำนวนฉากที่ต้องสร้างใหม่ไม่สำเร็จ กรุณาลองอีกครั้ง" };
      }
    }
    const maxAiImages = disclosedAiSlots === null
      ? null
      : Math.max(0, disclosedAiSlots.length - reusableAiImages);
    const bgmInput = buildBgmSelectionInput(p.musicTrack, p.musicTrackKind, p.bgmVolume);
    // โหมดอัปคลิปเอง (cutaway): เสียงพูดมาจากคลิป ส่วนเพลงใช้ตัวเลือกเดียวกับโหมดสคริปต์
    const body: Record<string, unknown> = existingAttempt?.body ?? (p.mode === "upload" ? {
      idempotencyKey,
      ...(p.projectId ? { projectId: p.projectId } : {}),
      mode: "upload",
      clipUrl: p.clipUrl,
      stockSource: p.brollSource === "kie-image" ? "kie-image" : p.brollSource === "automix" ? "auto-mix" : "stock",
      ...(submittedTargetClipCount > 0 ? { targetClipCount: submittedTargetClipCount } : {}),
      ...(p.brollRegionPreference !== "auto" ? { brollRegionPreference: p.brollRegionPreference } : {}),
      ...(p.brollVisualStyle !== "auto" && shouldSendLegacyBrollVisualStyle(p.brollSource)
        ? { brollVisualStyle: p.brollVisualStyle }
        : {}),
      ...(p.brollSource === "kie-image" ? { imageEngine: "runpod", imageModel: "z-image-turbo" } : {}),
      ...(p.kieModel && p.brollSource === "automix" ? { kieModel: p.kieModel } : {}),
      ...(p.brollSource === "automix" ? { autoMixProviders: p.autoMixProviders } : {}),
      // Mix preset weights (D5.1) — non-admins only; admins keep env weights. Server
      // (fetch-stock) honors these ONLY under MANAGED_KIE and force-zeros ai for the
      // unauthorized. brollSource is already "automix" for any preset ≠ ฟรีล้วน.
      ...(!p.isAdmin && p.brollSource === "automix" ? { autoMixWeights: PRESET_WEIGHTS[p.mixPreset] } : {}),
      ...(maxAiImages !== null ? { maxAiImages } : {}),
      ...bgmInput,
      subtitleMode: "sentence",
      subtitlePosition: "bottom",
    } : {
      idempotencyKey,
      ...(p.projectId ? { projectId: p.projectId } : {}),
      ...((p.brandVisualAllowed || p.hasPersistedVisualPin) && p.brandContentPreflightId ? {
        contentPreflightId: p.brandContentPreflightId,
        narrativeSourceKind: p.narrativeSourceKind,
      } : {}),
      script: p.script,
      voiceProvider: p.voiceEngine,
      ...(p.voiceEngine === "gemini" ? { geminiVoiceName: p.geminiVoiceName } : {}),
      ...(p.voiceEngine === "elevenlabs" && p.voiceId ? { voiceId: p.voiceId } : {}),
      ...(p.voiceEngine === "omnivoice" ? { omniVoiceId: p.omniVoiceId } : {}),
      ...bgmInput,
      // b-roll source ที่เลือกจริง (kie-image/auto-mix = Beta, server เช็ค admin ซ้ำ)
      stockSource: p.brollSource === "kie-image" ? "kie-image" : p.brollSource === "automix" ? "auto-mix" : "stock",
      // อวตาร: โหมด/วินาทีจากขั้นสูง (default bookend 5 วิ — ประหยัด HeyGen)
      ...(p.useAvatar && p.avatarId
        ? { avatarMode: p.avatarMode, avatarId: p.avatarId, avatarIntroSecs: p.avatarIntroSecs, avatarTailSecs: p.avatarTailSecs }
        : {}),
      ...(submittedTargetClipCount > 0 ? { targetClipCount: submittedTargetClipCount } : {}),
      ...(p.brollRegionPreference !== "auto" ? { brollRegionPreference: p.brollRegionPreference } : {}),
      ...(p.brollVisualStyle !== "auto" && shouldSendLegacyBrollVisualStyle(p.brollSource)
        ? { brollVisualStyle: p.brollVisualStyle }
        : {}),
      ...(p.brollSource === "kie-image" ? { imageEngine: "runpod", imageModel: "z-image-turbo" } : {}),
      ...(p.kieModel && p.brollSource === "automix" ? { kieModel: p.kieModel } : {}),
      ...(p.brollSource === "automix" ? { autoMixProviders: p.autoMixProviders } : {}),
      ...(!p.isAdmin && p.brollSource === "automix" ? { autoMixWeights: PRESET_WEIGHTS[p.mixPreset] } : {}),
      ...(maxAiImages !== null ? { maxAiImages } : {}),
      subtitleMode: "sentence",
      subtitlePosition: "bottom",
    });
    const attempt: OwnedSubmitAttempt = existingAttempt ?? {
      kind: "create",
      projectId: p.projectId ?? null,
      idempotencyKey,
      idempotencyFingerprint: null,
      fingerprintPromise: fingerprintVideoJobRequest(operationForAttempt("create"), body),
      body,
      baselineActiveJobId: p.activeJobId ?? null,
      baselineActiveExportJobId: p.activeExportJobId ?? null,
      baselineStoredJobId: storedJobId(p.projectId),
      promise: null,
    };
    let ownedPromise!: Promise<SubmitResult>;
    ownedPromise = (async () => {
      setJob((j) => ({ ...j, phase: "submitting", errorMessage: null, errorCode: null, errorProvider: null }));
      let retryAmbiguous = true;
      try {
        attempt.idempotencyFingerprint ??= await attempt.fingerprintPromise;
        const res = await authenticatedFetch("/api/videos/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(attempt.body),
        });
        const d = await res.json().catch(() => null);
        if (!res.ok || !d?.jobId) {
          retryAmbiguous = res.status >= 500
            || res.ok
            || res.status === 429
            || d?.error === "too_many_jobs"
            || d?.error === "quota_exceeded";
          setJob((j) => ({ ...j, phase: "idle" }));
          return {
            ok: false,
            message: d?.message ?? d?.error ?? `ส่งงานไม่สำเร็จ (${res.status})`,
            code: isProviderErrorCode(d?.code) ? d.code : undefined,
            provider: typeof d?.provider === "string" ? d.provider : undefined,
            actions: Array.isArray(d?.actions) ? d.actions.filter(isHeygenProviderAction) : undefined,
          };
        }
        if (!responseMatchesAttempt(d, attempt, false)) {
          setJob((j) => ({ ...j, phase: "idle" }));
          return { ok: false, message: "ยังยืนยันตัวตนของงานที่สร้างไม่ได้ กรุณาลองคำขอเดิมอีกครั้ง" };
        }
        retryAmbiguous = false;
        try { browserStorage()?.setItem(storageKey(attempt.projectId), d.jobId); } catch {}
        setJob({ phase: "rendering", jobId: d.jobId, jobType: "create", projectId: attempt.projectId, currentStep: null, progress: 0, queuePosition: null, errorMessage: null, errorCode: null, errorProvider: null, output: null, mediaState: null });
        startPolling(d.jobId);
        return { ok: true, warning: typeof d?.warning === "string" ? d.warning : undefined };
      } catch {
        setJob((j) => ({ ...j, phase: "idle" }));
        return { ok: false, message: "เครือข่ายมีปัญหา — ลองใหม่อีกครั้ง" };
      } finally {
        if (submitAttemptRef.current === attempt) {
          if (retryAmbiguous) attempt.promise = null;
          else submitAttemptRef.current = null;
        }
      }
    })();
    attempt.promise = ownedPromise;
    submitAttemptRef.current = attempt;
    return ownedPromise;
  }, [p, startPolling]);

  /** ส่งออกแบบ background job: worker เป็นเจ้าของ burn + save Gallery + project status */
  const submitExport = useCallback(async (input: SubmitExportInput): Promise<SubmitResult> => {
    const existingAttempt = submitAttemptRef.current;
    if (existingAttempt?.kind !== undefined && existingAttempt.kind !== "export") {
      return { ok: false, message: "มีคำขอเรนเดอร์ก่อนหน้าที่ยังยืนยันผลไม่ได้ กรุณาลองเรนเดอร์ซ้ำ" };
    }
    if (existingAttempt && existingAttempt.projectId !== (p.projectId ?? null)) {
      return { ok: false, message: "มีคำขอส่งออกของโปรเจกต์ก่อนหน้าที่ยังยืนยันผลไม่ได้ กรุณากลับไปโปรเจกต์เดิมแล้วลองซ้ำ" };
    }
    if (existingAttempt?.promise) return existingAttempt.promise;
    if (!p.canRunProjectOperation()) return { ok: false, message: PROJECT_OPERATION_BLOCKED_MESSAGE };
    if (!input.sourceJobId) return { ok: false, message: "ไม่พบวิดีโอต้นฉบับ" };
    const idempotencyKey = existingAttempt?.idempotencyKey ?? createSubmitIdempotencyKey("export");
    const body: Record<string, unknown> = existingAttempt?.body ?? {
      idempotencyKey,
      mode: "export",
      sourceJobId: input.sourceJobId,
      subtitleOverlayConfig: input.subtitleOverlayConfig,
      ...(input.script ? { script: input.script } : {}),
      ...(typeof input.sceneCount === "number" ? { exportSceneCount: input.sceneCount } : {}),
    };
    const attempt: OwnedSubmitAttempt = existingAttempt ?? {
      kind: "export",
      projectId: p.projectId ?? null,
      idempotencyKey,
      idempotencyFingerprint: null,
      fingerprintPromise: fingerprintVideoJobRequest(operationForAttempt("export"), body),
      body,
      baselineActiveJobId: p.activeJobId ?? null,
      baselineActiveExportJobId: p.activeExportJobId ?? null,
      baselineStoredJobId: storedJobId(p.projectId),
      promise: null,
    };
    let ownedPromise!: Promise<SubmitResult>;
    ownedPromise = (async () => {
      setJob((j) => ({ ...j, phase: "submitting", errorMessage: null, errorCode: null, errorProvider: null }));
      let retryAmbiguous = true;
      try {
        attempt.idempotencyFingerprint ??= await attempt.fingerprintPromise;
        lastPreviewJobIdRef.current = typeof attempt.body.sourceJobId === "string"
          ? attempt.body.sourceJobId
          : input.sourceJobId;
        const res = await authenticatedFetch("/api/videos/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(attempt.body),
        });
        const d = await res.json().catch(() => null);
        if (!res.ok || !d?.jobId) {
          retryAmbiguous = res.status >= 500
            || res.ok
            || res.status === 429
            || d?.error === "too_many_jobs"
            || d?.error === "quota_exceeded";
          setJob((j) => ({ ...j, phase: jobIdRef.current ? "done" : "idle" }));
          return { ok: false, message: d?.message ?? d?.error ?? `ส่งออกไม่สำเร็จ (${res.status})` };
        }
        if (!responseMatchesAttempt(d, attempt, false)) {
          setJob((j) => ({ ...j, phase: jobIdRef.current ? "done" : "idle" }));
          return { ok: false, message: "ยังยืนยันตัวตนของงานส่งออกไม่ได้ กรุณาลองคำขอเดิมอีกครั้ง" };
        }
        retryAmbiguous = false;
        try { browserStorage()?.setItem(storageKey(attempt.projectId), d.jobId); } catch {}
        setJob({ phase: "rendering", jobId: d.jobId, jobType: "export", projectId: attempt.projectId, currentStep: null, progress: 0, queuePosition: null, errorMessage: null, errorCode: null, errorProvider: null, output: null, mediaState: null });
        startPolling(d.jobId);
        return { ok: true };
      } catch {
        setJob((j) => ({ ...j, phase: jobIdRef.current ? "done" : "idle" }));
        return { ok: false, message: "เครือข่ายมีปัญหา — ลองใหม่อีกครั้ง" };
      } finally {
        if (submitAttemptRef.current === attempt) {
          if (retryAmbiguous) attempt.promise = null;
          else submitAttemptRef.current = null;
        }
      }
    })();
    attempt.promise = ownedPromise;
    submitAttemptRef.current = attempt;
    return ownedPromise;
  }, [p.canRunProjectOperation, p.projectId, startPolling]);

  /** ยกเลิก — สำเร็จเฉพาะงานที่ยังอยู่ในคิว (ยังไม่เริ่มทำ) */
  const cancel = useCallback(async (): Promise<{ ok: boolean; message?: string }> => {
    const id = jobIdRef.current ?? job.jobId;
    if (!id) return { ok: false };
    try {
      const res = await authenticatedFetch(`/api/videos/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
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
  const adoptJob = useCallback((next: { id: string; projectId?: string | null; contentPreflightId?: string | null }) => {
    stopPolling();
    jobIdRef.current = next.id;
    lastPreviewJobIdRef.current = next.id;
    try { browserStorage()?.setItem(storageKey(next.projectId ?? p.projectId), next.id); } catch {}
    setJob((j) => ({
      ...j,
      jobId: next.id,
      jobType: j.jobType ?? "create",
      projectId: next.projectId ?? j.projectId,
      contentPreflightId: next.contentPreflightId ?? j.contentPreflightId ?? null,
    }));
  }, [p.projectId, stopPolling]);

  const resumeJob = useCallback((jobId: string) => {
    if (!jobId) return;
    try { browserStorage()?.setItem(storageKey(p.projectId), jobId); } catch {}
    startPolling(jobId);
  }, [p.projectId, startPolling]);

  const markPreviewMissing = useCallback(() => {
    // Invalidate any response that began before the player reported the incident.
    // Usually done jobs have already stopped polling, but this also closes the
    // overlap window during slow/out-of-order network responses.
    stopPolling();
    setJob((current) => current.phase === "done"
      ? { ...current, mediaState: previewMediaStateAfterVideoError(current.mediaState) }
      : current);
  }, [stopPolling]);

  return { job, submit, submitExport, cancel, reset, adoptJob, resumeJob, markPreviewMissing };
}
