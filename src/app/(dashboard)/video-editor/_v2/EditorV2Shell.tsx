"use client";

/**
 * Editor v2 shell — เฟสตั้งค่า (จอ 5a/4a) + จอเรนเดอร์ (5b, background จริงผ่าน VideoJob
 * preview mode P4a/P4b) + done/failed placeholder (เฟสแต่งซับเต็มรูปแบบ = P6)
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { XCircle, ChevronLeft, BookOpen, FolderOpen, Plus, Check, CheckCircle2, Download, Loader2, Trash2 } from "lucide-react";
import { color, font } from "./tokens";
import { v2FontClass } from "./fonts";
import { StepIndicator, BtnPrimary, BtnSecondary, BtnGhost } from "./ui";
import { AccountMenu } from "@/components/layout/account-menu";
import { NotificationBell } from "@/components/layout/notification-bell";
import { QuotaStatus } from "@/components/quota-status";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useV2Project, type V2VoiceEngine } from "./useV2Project";
import { useV2Job, type SubmitResult, type V2JobState } from "./useV2Job";
import { ApiKeyModal, type RequiredKeyType } from "@/components/ui/api-key-modal";
import { UpgradeModal } from "@/components/ui/upgrade-modal";
import { trackEvent } from "@/lib/client-telemetry";
import {
  QUOTA_BUY_CREDITS_HREF,
  QUOTA_PRICING_HREF,
  quotaExceededText,
  type QuotaExceededInfo,
} from "@/lib/quota-error";
import { Step1Script } from "./Step1Script";
import { Step2Elements } from "./Step2Elements";
import { RenderingScreen } from "./RenderingScreen";
import { FirstClipExportedViewSignal } from "@/components/convert/first-clip-exported-view-signal";
import { emitFirstClipViewed } from "@/lib/first-clip-convert-events";
import { PostPhase } from "./PostPhase";
import { PostPhaseMobile } from "./PostPhaseMobile";
import { ExpiredPreviewView, prepareExpiredPreviewRerender, shouldShowUnavailablePreview } from "./ExpiredPreviewView";
import { RenderReceiptDialog } from "./RenderReceiptDialog";
import { EditorProjectRecoveryDialog } from "./EditorProjectRecoveryDialog";
import { useIsMobile } from "./useIsMobile";
import { CREDITS_LIVE_CLIENT } from "../_hooks/useCreditsQuota";
import {
  PROJECT_STATUS_FILTER_LABEL,
  fetchRecentProjectMenu,
  filterProjectMenuItems,
  projectDeleteBlocked,
  projectMenuDate,
  projectStatusLabel,
  type ProjectMenuItem,
  type ProjectStatusFilter,
} from "./project-menu";
import { resolveVideoDownloadFilename } from "@/lib/video-export-name";
import { customerApiErrorMessage } from "@/lib/customer-api-error";
import { classifyFailure, failureViewCopy } from "./failure-view";
import { fetchMe } from "@/lib/use-me";

// Which submit path a missing-key error interrupted, so the retry (after saving a key,
// or after switching to Gemini) re-runs exactly that path — mirrors v1's
// `retryStep: keyof StepState | "runAll"` at video-editor/page.tsx:480.
type RetryAction = { kind: "render" } | { kind: "confirm"; minutes: number };

export function EditorV2Shell() {
  const p = useV2Project();
  const downloadFilename = resolveVideoDownloadFilename({
    projectTitle: p.projectTitle,
    script: p.mode === "script" ? p.script : null,
  });
  const router = useRouter();
  const [step, setStep] = useState<0 | 1>(0);
  const [firstClipPath, setFirstClipPath] = useState(false);
  const {
    job,
    submit,
    submitExport,
    cancel,
    reset,
    adoptJob,
    resumeJob,
    resumeFailedExportPreview,
    resumeExportEditSnapshot,
    markPreviewMissing,
  } = useV2Job(p);
  const isMobile = useIsMobile();
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectMenuItem[]>([]);
  const [projectTotal, setProjectTotal] = useState(0);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectsReloadRevision, setProjectsReloadRevision] = useState(0);
  const [projectFilter, setProjectFilter] = useState<ProjectStatusFilter>("all");
  const [deleteProject, setDeleteProject] = useState<ProjectMenuItem | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const emptyProjectState = p.projectInitialization === "empty";
  const editorBlocked = (p.projectInitialization !== "ready" && !emptyProjectState)
    || p.recovery.status !== "none";

  // Render Receipt (D5) — mandatory pre-render summary. Only interposed when the flag
  // is on; with it off handleRender submits directly (byte-identical to before).
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [confirmSubmitting, setConfirmSubmitting] = useState(false);
  const [heygenQuotaAlert, setHeygenQuotaAlert] = useState<string | null>(null);
  // Missing-key preflight (Task 2): jobs/route.ts answers a Render/Confirm submit with
  // { error: "missing_key", missingKey } BEFORE creating any VideoJob — no client-side
  // key rules here, just open the modal from the response and retry the same submit path.
  const [missingKeyModal, setMissingKeyModal] = useState<{ type: RequiredKeyType; retry: RetryAction } | null>(null);
  // One step behind missingKey: the user HAS a key/engine picked but no Voice ID set —
  // jobs/route.ts returns this same { error: "missing_voice_id" } shape for BOTH
  // ElevenLabs (no voiceId) and OmniVoice/Hero Voice (no omniVoiceId), with no
  // discriminating field. `engine` is captured off p.voiceEngine at failure time (inside
  // handleSubmitResult, not read live at render) so the dialog can't drift if the user
  // later switches engines — ApiKeyModal is the wrong surface either way (nothing to
  // paste a key into), so this reuses the heygenQuotaAlert AlertDialog shape instead.
  const [missingVoiceIdAlert, setMissingVoiceIdAlert] = useState<{ message: string; retry: RetryAction; engine: V2VoiceEngine } | null>(null);
  // Plan quota ran out (issue #298). The submit response used to fall through to a toast
  // that stringified the error envelope — this holds the parsed facts so the modal can
  // show the Thai reason plus the route out (upgrade, and top-up when credits are live).
  const [quotaModal, setQuotaModal] = useState<QuotaExceededInfo | null>(null);
  // "ใช้เสียง Gemini แทน" switches voiceEngine (React state, applies next render) then
  // must resubmit — this ref+effect defers the resubmit until p.voiceEngine actually
  // reflects "gemini", since calling submit() synchronously would still close over the
  // pre-switch value.
  const pendingGeminiRetryRef = useRef<RetryAction | null>(null);
  const confirmingRef = useRef(false); // hard guard vs. double-click before re-render
  const activeProjectIdRef = useRef(p.projectId);
  const mountedRef = useRef(false);
  const archiveGenerationRef = useRef(0);
  const archiveAttemptRef = useRef<{
    token: symbol;
    generation: number;
    projectId: string;
  } | null>(null);
  activeProjectIdRef.current = p.projectId;

  useEffect(() => {
    mountedRef.current = true;
    archiveGenerationRef.current += 1;
    return () => {
      mountedRef.current = false;
      archiveGenerationRef.current += 1;
      archiveAttemptRef.current = null;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    fetchMe()
      .then((data) => {
        if (!alive) return;
        setFirstClipPath(data?.firstClipPath === true);
      })
      .catch(() => {
        if (alive) setFirstClipPath(false);
      });
    return () => { alive = false; };
  }, []);

  const isRendering = job.phase === "rendering" || job.phase === "submitting";
  const indicatorActive = job.phase === "done" ? 2 : isRendering ? 1 : step;
  const indicatorDone = job.phase === "done" ? [0, 1] : (isRendering || step === 1) ? [0] : [];

  useEffect(() => {
    if (!projectMenuOpen) return;
    let alive = true;
    setProjectsLoading(true);
    setProjectsError(null);
    fetchRecentProjectMenu()
      .then((snapshot) => {
        if (!alive) return;
        setProjects(snapshot.projects);
        setProjectTotal(snapshot.total);
      })
      .catch((error) => {
        if (!alive) return;
        setProjectsError(error instanceof Error ? error.message : "โหลดรายการโปรเจกต์ไม่สำเร็จ กรุณาลองใหม่");
      })
      .finally(() => { if (alive) setProjectsLoading(false); });
    return () => { alive = false; };
  }, [projectMenuOpen, p.projectId, projectsReloadRevision]);

  useEffect(() => {
    if (!editorBlocked) return;
    setProjectMenuOpen(false);
    setDeleteProject(null);
    setReceiptOpen(false);
  }, [editorBlocked]);

  function handleSubmitResult(result: SubmitResult, retry: RetryAction) {
    if (result.ok) {
      if (result.warning) toast.warning(result.warning);
      return;
    }
    if (result.code === "quota" && result.provider === "heygen") {
      setHeygenQuotaAlert(result.message ?? "เครดิต HeyGen ไม่เพียงพอสำหรับสร้าง Avatar");
      return;
    }
    if (result.missingKey) {
      setMissingKeyModal({ type: result.missingKey, retry });
      return;
    }
    if (result.missingVoiceId) {
      // Capture the engine NOW, off the request that just failed — not later via
      // p.voiceEngine at render time, which the Gemini-switch escape hatch mutates.
      setMissingVoiceIdAlert({ message: result.message ?? "ต้องระบุ Voice ID", retry, engine: p.voiceEngine });
      return;
    }
    if (result.quota) {
      trackEvent("quota_hit", {
        category: "product",
        status: "info",
        properties: {
          kind: "minutes",
          plan: p.plan ?? null,
          onTrial: p.isActiveTrial,
          canBuyCredits: result.quota.canBuyCredits,
        },
      });
      setQuotaModal(result.quota);
      return;
    }
    toast.error(result.message ?? "ส่งงานไม่สำเร็จ");
  }

  async function handleRender() {
    if (!p.canRunProjectOperation()) return;
    if (!CREDITS_LIVE_CLIENT) {
      const r = await submit();
      handleSubmitResult(r, { kind: "render" });
      return;
    }
    setReceiptOpen(true);
  }

  // Confirm from the receipt → the ONE real submit. Ref-guarded so a rapid double-click
  // can't fire submit twice before React re-renders the disabled button.
  async function handleConfirmRender(confirmedMeteredMinutes: number) {
    if (!p.canRunProjectOperation()) return;
    if (confirmingRef.current) return;
    confirmingRef.current = true;
    setConfirmSubmitting(true);
    try {
      const r = await submit(confirmedMeteredMinutes);
      handleSubmitResult(r, { kind: "confirm", minutes: confirmedMeteredMinutes });
    } finally {
      confirmingRef.current = false;
      setConfirmSubmitting(false);
      setReceiptOpen(false); // ok → shell already swapped to RenderingScreen; fail → back to Step2
    }
  }

  function runRetryAction(retry: RetryAction) {
    if (retry.kind === "confirm") void handleConfirmRender(retry.minutes);
    else void handleRender();
  }

  // Fires once p.voiceEngine actually reads back "gemini" after the modal's
  // "ใช้เสียง Gemini แทน" click called p.setVoiceEngine("gemini") — state updates are
  // async, so resubmitting synchronously in the click handler would still submit with
  // the pre-switch (ElevenLabs) engine.
  useEffect(() => {
    if (p.voiceEngine !== "gemini") return;
    const retry = pendingGeminiRetryRef.current;
    if (!retry) return;
    pendingGeminiRetryRef.current = null;
    runRetryAction(retry);
  }, [p.voiceEngine]);

  async function handleCancel() {
    const r = await cancel();
    if (!r.ok && r.message) toast.error(r.message);
  }

  async function handleNewProject() {
    if (!p.canRunProjectOperation() && !emptyProjectState) return;
    reset();
    setStep(0);
    const projectId = await p.resetProject();
    if (!projectId) return;
    const url = new URL(window.location.href);
    url.pathname = "/video-editor";
    url.searchParams.set("ui", "v2");
    url.searchParams.set("projectId", projectId);
    url.searchParams.delete("empty");
    window.history.replaceState({}, "", `${url.pathname}?${url.searchParams.toString()}`);
  }

  function openProject(projectId: string) {
    if (!p.canRunProjectOperation() && !emptyProjectState) return;
    if (!projectId || projectId === p.projectId) return;
    const url = new URL(window.location.href);
    url.pathname = "/video-editor";
    url.searchParams.set("ui", "v2");
    url.searchParams.set("projectId", projectId);
    url.searchParams.delete("empty");
    window.location.assign(`${url.pathname}?${url.searchParams.toString()}`);
  }

  function navigateAfterArchivedProject(projectId?: string) {
    const url = new URL(window.location.href);
    url.pathname = "/video-editor";
    url.searchParams.set("ui", "v2");
    if (projectId) {
      url.searchParams.set("projectId", projectId);
      url.searchParams.delete("empty");
    } else {
      url.searchParams.delete("projectId");
      url.searchParams.set("empty", "1");
    }
    window.location.assign(`${url.pathname}?${url.searchParams.toString()}`);
  }

  function requestDeleteProject(project: ProjectMenuItem) {
    if (!p.canRunProjectOperation() && !emptyProjectState) return;
    if (projectDeleteBlocked(project.status)) {
      toast.error("โปรเจกต์นี้กำลังทำงานอยู่ — รอให้เสร็จก่อนลบ");
      return;
    }
    setDeleteProject(project);
    setProjectMenuOpen(false);
  }

  async function handleDeleteProject() {
    if (!p.canRunProjectOperation() && !emptyProjectState) return;
    const project = deleteProject;
    if (!project || deletingProjectId) return;
    if (projectDeleteBlocked(project.status)) {
      setDeleteProject(null);
      toast.error("โปรเจกต์นี้กำลังทำงานอยู่ — รอให้เสร็จก่อนลบ");
      return;
    }
    const attempt = {
      token: Symbol("archive-project"),
      generation: archiveGenerationRef.current,
      projectId: project.id,
    };
    const ownsAttempt = () => (
      mountedRef.current
      && archiveGenerationRef.current === attempt.generation
      && archiveAttemptRef.current?.token === attempt.token
      && archiveAttemptRef.current.projectId === attempt.projectId
    );
    archiveAttemptRef.current = attempt;
    setDeletingProjectId(project.id);
    try {
      const res = await fetch(`/api/editor-projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
      if (!ownsAttempt()) return;
      const data = await res.json().catch(() => null);
      if (!ownsAttempt()) return;
      if (!res.ok) throw new Error(customerApiErrorMessage(data, "นำโปรเจกต์ออกไม่สำเร็จ กรุณาลองใหม่"));
      const fallbackProjects = projects.filter((item) => item.id !== project.id);
      let remainingProjects = fallbackProjects;
      let remainingTotal = Math.max(0, projectTotal - 1);
      try {
        const snapshot = await fetchRecentProjectMenu();
        remainingProjects = snapshot.projects.filter((item) => item.id !== project.id);
        remainingTotal = snapshot.total;
      } catch {
        toast.error("นำโปรเจกต์ออกแล้ว แต่โหลดรายการล่าสุดไม่สำเร็จ — กำลังใช้รายการที่มีอยู่");
      }
      if (!ownsAttempt()) return;
      setProjects(remainingProjects);
      setProjectTotal(remainingTotal);
      setDeleteProject(null);
      if (activeProjectIdRef.current === project.id) {
        if (!ownsAttempt()) return;
        if (!p.completeArchivedProject(project.id)) return;
        if (!ownsAttempt() || activeProjectIdRef.current !== project.id) return;
        const nextProject = remainingProjects[0];
        if (nextProject) {
          toast.success(`นำโปรเจกต์ออกแล้ว กำลังเปิด ${nextProject.title || "โปรเจกต์ถัดไป"}`);
          navigateAfterArchivedProject(nextProject.id);
        } else {
          toast.success("นำโปรเจกต์ออกแล้ว ตอนนี้ไม่มีโปรเจกต์ค้างอยู่");
          navigateAfterArchivedProject();
        }
        return;
      }
      toast.success("นำโปรเจกต์ออกจากรายการแล้ว");
    } catch (error) {
      if (!ownsAttempt()) return;
      toast.error(error instanceof Error ? error.message : "นำโปรเจกต์ออกไม่สำเร็จ");
    } finally {
      if (ownsAttempt()) {
        archiveAttemptRef.current = null;
        setDeletingProjectId(null);
      }
    }
  }

  const visibleProjects = filterProjectMenuItems(projects, projectFilter);
  const postPhaseProjectProps = {
    projectId: p.projectId,
    logoOverlay: p.logoOverlay,
    onLogoOverlayChange: p.setLogoOverlay,
    initialSubtitleConfig: p.brandSubtitleDefault,
    brandVisualAllowed: p.brandVisualAllowed,
    layerVisibility: p.layerVisibility,
    onLayerVisibilityChange: p.setLayerVisibility,
    headlineHook: p.headlineHook,
    onHeadlineHookChange: p.setHeadlineHook,
    logoEligible: p.canUseLogoOverlay,
    projectSaveStatus: p.saveStatus,
    onRetryProjectSave: p.retryProjectSave,
    // M2: lets the style-preset "apply" toast check readiness before claiming success
    // for a logo change that p.setLogoOverlay would otherwise drop silently.
    canRunProjectOperation: p.canRunProjectOperation,
  };
  // jobs/route.ts sends the identical { error: "missing_voice_id" } shape for
  // ElevenLabs (no voiceId, :514) and OmniVoice/Hero Voice (no omniVoiceId, :493) —
  // discriminate on the engine captured at failure time so the title/copy never
  // names a provider the user didn't actually pick, and only the ElevenLabs cost
  // pitch gets appended for the ElevenLabs case.
  const missingVoiceIdCopy = missingVoiceIdAlert ? {
    title: missingVoiceIdAlert.engine === "elevenlabs"
      ? "ต้องระบุ ElevenLabs Voice ID"
      : missingVoiceIdAlert.engine === "omnivoice"
        ? "ต้องเลือกเสียง Hero Voice"
        : "ต้องระบุ Voice ID",
    description: missingVoiceIdAlert.engine === "elevenlabs"
      ? `${missingVoiceIdAlert.message} — เสียง ElevenLabs ต้องใช้คีย์ของคุณเองและมีค่าใช้จ่าย — เสียง Gemini ใช้ได้ทันที ไม่ต้องตั้งค่า`
      : missingVoiceIdAlert.message,
  } : null;
  return (
    <div
      className={`${v2FontClass} flex h-screen flex-col`}
      style={{ background: color.bg0, color: color.text }}
    >
      {p.projectInitialization !== "ready" && !emptyProjectState && p.recovery.status === "none" ? (
        <div role="status" aria-live="polite" className="sr-only">
          กำลังเตรียมโปรเจกต์
        </div>
      ) : null}
      <div
        inert={editorBlocked ? true : undefined}
        aria-hidden={editorBlocked ? "true" : undefined}
        className="contents"
      >
      {/* Topbar 58px — single unified bar (full-screen editor: no dashboard chrome) */}
      <header
        className="flex h-[58px] shrink-0 items-center justify-between gap-2 px-4"
        style={{ borderBottom: `1px solid ${color.cardBorder}` }}
      >
        {/* ── Left: back → dashboard + (desktop) H logo + project name + subline ── */}
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            data-editor-recovery-focus-fallback="true"
            onClick={() => {
              if (!p.canRunProjectOperation() && !emptyProjectState) return;
              router.push("/dashboard");
            }}
            aria-label="กลับแดชบอร์ด"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[9px] transition-colors hover:brightness-125 lg:h-[34px] lg:w-[34px]"
            style={{ background: "rgba(255,255,255,.05)", color: color.textSecondary }}
          >
            <ChevronLeft size={20} strokeWidth={2.25} />
          </button>

          <div
            className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-[9px] text-[14px] font-semibold text-white lg:flex"
            style={{ background: color.gradientPrimary, fontFamily: font.heading }}
          >
            H
          </div>

          <DropdownMenu
            open={projectMenuOpen && !editorBlocked}
            onOpenChange={(open) => {
              if (open && !p.canRunProjectOperation() && !emptyProjectState) return;
              setProjectMenuOpen(open);
            }}
          >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="เปิดรายการโปรเจกต์"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[9px] transition-colors hover:brightness-125 lg:h-[34px] lg:w-[34px]"
                style={{ background: "rgba(255,255,255,.05)", color: color.textSecondary }}
              >
                <FolderOpen size={16} strokeWidth={2.1} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-[292px] rounded-[10px] p-1.5"
              style={{ background: color.bg1, border: `1px solid ${color.cardBorder}`, color: color.text }}
            >
              <DropdownMenuLabel className="flex items-center justify-between gap-3 px-2 py-1.5" style={{ font: `600 11px ${font.heading}`, color: color.textFaint }}>
                <span>โปรเจกต์ล่าสุด</span>
                <span style={{ fontWeight: 400 }}>
                  {projectTotal > projects.length ? `${projects.length} จาก ${projectTotal}` : `${projectTotal} รายการ`}
                </span>
              </DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={() => void handleNewProject()}
                className="rounded-[8px] px-2.5 py-2"
                style={{ color: color.primary300, cursor: "pointer" }}
              >
                <Plus size={14} />
                <span style={{ fontSize: 12 }}>โปรเจกต์ใหม่</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator style={{ background: color.cardBorder }} />
              <div className="flex gap-1 px-1 py-1.5">
                {(Object.keys(PROJECT_STATUS_FILTER_LABEL) as ProjectStatusFilter[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setProjectFilter(key);
                    }}
                    className="rounded-[7px] px-2 py-1"
                    style={{
                      background: projectFilter === key ? color.selectedBg : "transparent",
                      border: `1px solid ${projectFilter === key ? color.selectedBorder : "transparent"}`,
                      color: projectFilter === key ? color.primary300 : color.textFaint,
                      cursor: "pointer",
                      fontSize: 10.5,
                    }}
                  >
                    {PROJECT_STATUS_FILTER_LABEL[key]}
                  </button>
                ))}
              </div>
              <DropdownMenuSeparator style={{ background: color.cardBorder }} />
              {projectsLoading ? (
                <DropdownMenuItem disabled className="rounded-[8px] px-2.5 py-2" style={{ color: color.textFaint }}>
                  <span style={{ fontSize: 12 }}>กำลังโหลด…</span>
                </DropdownMenuItem>
              ) : projectsError ? (
                <div className="flex items-center justify-between gap-3 rounded-[8px] px-2.5 py-2" role="alert">
                  <span style={{ fontSize: 11, color: color.danger }}>โหลดรายการไม่สำเร็จ</span>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setProjectsReloadRevision((value) => value + 1);
                    }}
                    className="rounded-[7px] px-2 py-1 focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ color: color.link, background: color.selectedBg, border: `1px solid ${color.selectedBorder}`, fontSize: 11 }}
                  >
                    ลองใหม่
                  </button>
                </div>
              ) : visibleProjects.length === 0 ? (
                <DropdownMenuItem disabled className="rounded-[8px] px-2.5 py-2" style={{ color: color.textFaint }}>
                  <span style={{ fontSize: 12 }}>ไม่มีโปรเจกต์ในตัวกรองนี้</span>
                </DropdownMenuItem>
              ) : visibleProjects.map((project) => {
                const active = project.id === p.projectId;
                const deleteBlocked = projectDeleteBlocked(project.status);
                const deleting = deletingProjectId === project.id;
                const activityDate = projectMenuDate(project);
                return (
                  <DropdownMenuItem
                    key={project.id}
                    onSelect={(event) => {
                      event.preventDefault();
                      openProject(project.id);
                    }}
                    className="rounded-[8px] px-2.5 py-2"
                    style={{ color: active ? color.primary300 : color.textSecondary, cursor: active ? "default" : "pointer" }}
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                      {active ? <Check size={13} strokeWidth={2.4} /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate" style={{ fontSize: 12 }}>{project.title || "New Project"}</span>
                      {activityDate ? (
                        <span className="mt-0.5 block truncate" style={{ fontSize: 9.5, color: color.textFaintest }}>
                          แก้ไข {activityDate}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0" style={{ fontSize: 10, color: color.textFaint }}>
                      {projectStatusLabel(project.status)}
                    </span>
                    <button
                      type="button"
                      aria-label="นำโปรเจกต์ออกจากรายการ"
                      aria-disabled={deleteBlocked || deleting}
                      title={deleteBlocked ? "รอให้งานเสร็จก่อนนำออก" : "นำออกจากรายการ"}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (deleting) return;
                        requestDeleteProject(project);
                      }}
                      className="ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-[7px] transition-colors lg:h-7 lg:w-7"
                      style={{
                        color: deleteBlocked ? color.textFaintest : color.textFaint,
                        cursor: deleteBlocked ? "not-allowed" : "pointer",
                        opacity: deleteBlocked ? 0.45 : 1,
                        background: "transparent",
                        border: "none",
                      }}
                    >
                      {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} strokeWidth={2} />}
                    </button>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="flex min-w-0 flex-col leading-tight">
            {emptyProjectState ? (
              <span style={{ font: `500 13.5px ${font.heading}`, color: color.text }}>ยังไม่มีโปรเจกต์</span>
            ) : (
              <input
                aria-label="ชื่อโปรเจกต์"
                value={p.projectTitle}
                onChange={(event) => p.setProjectTitle(event.target.value.slice(0, 80))}
                onBlur={() => {
                  const trimmed = p.projectTitle.trim();
                  p.setProjectTitle(trimmed || "New Project");
                }}
                className="-mx-1.5 min-w-0 truncate rounded-[6px] border-0 bg-transparent px-1.5 py-0 outline-none transition-colors focus:bg-white/[.06] focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{ font: `500 13.5px ${font.heading}`, color: color.text }}
              />
            )}
            <div className="hidden items-center gap-1.5 lg:flex" style={{ fontSize: 10.5, color: color.textFaint }}>
              {emptyProjectState ? <span>ระบบจะสร้างเมื่อมิวกดเริ่ม</span> : <SaveStatus status={p.saveStatus} onRetry={p.retryProjectSave} />}
            </div>
          </div>
        </div>

        {/* ── Center: step indicator — desktop labels / mobile dots (logic unchanged) ── */}
        {/* desktop (≥lg): full step labels — เหมือนเดิมทุก px */}
        <div className="hidden lg:flex">
          <StepIndicator
            active={indicatorActive}
            done={indicatorDone}
            onStepClick={(i) => { if (!isRendering && job.phase !== "done" && i < step) setStep(i as 0 | 1); }}
          />
        </div>
        {/* mobile (<lg): compact numbered dots */}
        <div className="flex lg:hidden">
          <StepIndicator
            active={indicatorActive}
            done={indicatorDone}
            onStepClick={(i) => { if (!isRendering && job.phase !== "done" && i < step) setStep(i as 0 | 1); }}
            compact
          />
        </div>

        {/* ── Right: bell + help (desktop) + account menu (always; folds help/escape on mobile) ── */}
        <div className="flex shrink-0 items-center gap-3">
          <div className="hidden lg:flex">
            <QuotaStatus variant="chip" refreshKey={job.phase === "done" ? 1 : 0} />
          </div>
          <div className="hidden items-center gap-3 lg:flex">
            <NotificationBell />
            {!firstClipPath ? (
              <Link
                href="/docs"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[13px] transition-opacity hover:opacity-80"
                style={{ color: color.textSecondary, fontFamily: font.body }}
              >
                วิธีใช้งาน
              </Link>
            ) : null}
          </div>
          <AccountMenu
            extraItems={firstClipPath ? undefined : (
              <>
                <DropdownMenuItem asChild className="cursor-pointer lg:hidden">
                  <Link href="/docs" target="_blank" rel="noopener noreferrer">
                    <BookOpen className="mr-2 h-4 w-4" />
                    วิธีใช้งาน
                  </Link>
                </DropdownMenuItem>
              </>
            )}
          />
        </div>
      </header>

      <div
        className="flex min-h-9 shrink-0 items-center justify-center px-2 py-1 lg:hidden"
        style={{ borderBottom: `1px solid ${color.cardBorder}`, background: color.bg1 }}
      >
        <QuotaStatus variant="chip" refreshKey={job.phase === "done" ? 1 : 0} />
      </div>

      {firstClipPath && !emptyProjectState && !isRendering && job.phase !== "done" && job.phase !== "failed" ? (
        <div
          className="shrink-0 px-7 py-2.5 text-[13px]"
          style={{
            background: color.selectedBg,
            borderBottom: `1px solid ${color.selectedBorder}`,
            color: color.primary300,
            fontFamily: font.body,
          }}
        >
          คลิปแรก: วางสคริปต์แล้วกดสร้าง — ระบบใช้แบรนด์เดียวกันให้อัตโนมัติ
        </div>
      ) : null}

      {emptyProjectState ? (
        <EmptyProjectView onCreate={() => void handleNewProject()} />
      ) : isRendering ? (
        <RenderingScreen
          job={job}
          hasAvatar={p.mode !== "upload" && p.useAvatar && !!p.avatarId}
          uploadMode={p.mode === "upload"}
          exportMode={job.jobType === "export"}
          visualMode={p.brollSource === "kie-image" ? "ai-image" : p.brollSource === "automix" ? "automix" : "stock"}
          onCancel={handleCancel}
        />
      ) : shouldShowUnavailablePreview(job.phase, job.mediaState) ? (
        <ExpiredPreviewView
          state={job.mediaState}
          onRerender={() => prepareExpiredPreviewRerender(reset, setStep)}
        />
      ) : job.phase === "done" ? (
        job.output?.preview ? (
          isMobile ? (
            <PostPhaseMobile {...postPhaseProjectProps} job={job} script={p.mode === "script" ? p.script : ""} onExportJob={submitExport} onAdoptJob={adoptJob} onNewProject={handleNewProject} onPreviewError={markPreviewMissing} internalAiTester={p.internalAiTester} sceneRerollEnabled={job.sceneRerollCapability?.available === true} sceneRerollUnavailableReason={job.sceneRerollCapability?.message ?? undefined} starterImageAllowance={p.starterAiImageAllowance} downloadFilename={downloadFilename} />
          ) : (
            <PostPhase {...postPhaseProjectProps} job={job} script={p.mode === "script" ? p.script : ""} onExportJob={submitExport} onAdoptJob={adoptJob} onNewProject={handleNewProject} onPreviewError={markPreviewMissing} internalAiTester={p.internalAiTester} sceneRerollEnabled={job.sceneRerollCapability?.available === true} sceneRerollUnavailableReason={job.sceneRerollCapability?.message ?? undefined} starterImageAllowance={p.starterAiImageAllowance} downloadFilename={downloadFilename} />
          )
        ) : (
          <ExportedView
            job={job}
            onNewProject={handleNewProject}
            onEditPreview={(job.output?.sourceJobId ?? p.activeJobId)
              ? job.output?.editSnapshot
                ? resumeExportEditSnapshot
                : () => resumeJob((job.output?.sourceJobId ?? p.activeJobId)!)
              : undefined}
            downloadFilename={downloadFilename}
          />
        )
      ) : job.phase === "failed" ? (
        <FailedView
          job={job}
          exportMode={job.jobType === "export"}
          plan={p.plan ?? null}
          onTrial={p.isActiveTrial}
          onSwitchFaceless={() => {
            p.setUseAvatar(false);
            reset();
            setStep(1);
            toast.success("เปลี่ยนเป็น Faceless แล้ว — พร้อมลองสร้างใหม่");
          }}
          onBack={() => {
            if (job.jobType === "export") {
              resumeFailedExportPreview();
              return;
            }
            reset();
            setStep(1);
          }}
        />
      ) : step === 0 ? (
        <Step1Script p={p} onNext={() => setStep(1)} firstClipPath={firstClipPath} />
      ) : (
        <Step2Elements p={p} onRender={handleRender} />
      )}

      {CREDITS_LIVE_CLIENT && (
        <RenderReceiptDialog
          p={p}
          open={receiptOpen && !editorBlocked}
          submitting={confirmSubmitting}
          onConfirm={(confirmedMeteredMinutes) => void handleConfirmRender(confirmedMeteredMinutes)}
          onCancel={() => { if (!confirmSubmitting) setReceiptOpen(false); }}
        />
      )}

      <AlertDialog open={!!heygenQuotaAlert} onOpenChange={(open) => { if (!open) setHeygenQuotaAlert(null); }}>
        <AlertDialogContent className="border" style={{ background: color.bg1, borderColor: color.cardBorder, color: color.text }}>
          <AlertDialogHeader>
            <AlertDialogTitle style={{ color: color.text }}>เครดิต HeyGen ไม่เพียงพอ</AlertDialogTitle>
            <AlertDialogDescription style={{ color: color.textSecondary }}>
              {heygenQuotaAlert} ระบบยังไม่ได้เริ่มสร้างคลิปและยังไม่ได้หักนาทีของแพ็กเกจ
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setHeygenQuotaAlert(null)}>ยกเลิก</AlertDialogCancel>
            <AlertDialogAction asChild>
              <a href="https://app.heygen.com/settings?nav=API" target="_blank" rel="noreferrer">ไปที่ HeyGen</a>
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => {
                p.setUseAvatar(false);
                setHeygenQuotaAlert(null);
                toast.success("เปลี่ยนเป็น Faceless แล้ว — กดเริ่มสร้างอีกครั้งได้เลย");
              }}
            >
              ใช้แบบ Faceless
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!missingVoiceIdAlert} onOpenChange={(open) => { if (!open) setMissingVoiceIdAlert(null); }}>
        <AlertDialogContent className="border" style={{ background: color.bg1, borderColor: color.cardBorder, color: color.text }}>
          <AlertDialogHeader>
            <AlertDialogTitle style={{ color: color.text }}>{missingVoiceIdCopy?.title}</AlertDialogTitle>
            <AlertDialogDescription style={{ color: color.textSecondary }}>
              {missingVoiceIdCopy?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {/* Dismiss = go pick a Voice ID in Step2's own picker (ElevenLabs or Hero
                Voice, whichever engine failed). No retry is pending (only the
                Gemini-switch action below arms pendingGeminiRetryRef),
                so closing here leaves the editor idle on Step2 with nothing queued. */}
            <AlertDialogCancel onClick={() => setMissingVoiceIdAlert(null)}>ยกเลิก</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!missingVoiceIdAlert) return;
                pendingGeminiRetryRef.current = missingVoiceIdAlert.retry;
                setMissingVoiceIdAlert(null);
                p.setVoiceEngine("gemini");
              }}
            >
              ใช้เสียง Gemini แทน (ฟรี)
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {missingKeyModal && (
        <ApiKeyModal
          keyType={missingKeyModal.type}
          onClose={() => setMissingKeyModal(null)}
          onSaved={() => {
            const retry = missingKeyModal.retry;
            setMissingKeyModal(null);
            runRetryAction(retry);
          }}
          {...(missingKeyModal.type === "elevenlabs" ? {
            secondaryAction: {
              label: "ใช้เสียง Gemini แทน (ฟรี)",
              description: "เสียง ElevenLabs ต้องใช้คีย์ของคุณเองและมีค่าใช้จ่าย — เสียง Gemini ใช้ได้ทันที ไม่ต้องตั้งค่า",
              onClick: () => {
                pendingGeminiRetryRef.current = missingKeyModal.retry;
                p.setVoiceEngine("gemini");
                setMissingKeyModal(null);
              },
            },
          } : {})}
        />
      )}

      <UpgradeModal
        open={!!quotaModal}
        onClose={() => setQuotaModal(null)}
        title="โควต้าเรนเดอร์รอบนี้ใช้ครบแล้ว"
        message={quotaModal
          ? quotaExceededText(quotaModal, "โควต้าเรนเดอร์รอบนี้ใช้ครบแล้ว — อัปเกรดแพ็กเกจเพื่อสร้างคลิปต่อ")
          : undefined}
        minuteQuota
        ctaLabel="ดูแผนราคา — อัปเกรดเลย"
        pricingHref={QUOTA_PRICING_HREF}
        secondaryCta={quotaModal?.canBuyCredits
          ? { label: "เติมเครดิต", href: QUOTA_BUY_CREDITS_HREF }
          : undefined}
      />

      <AlertDialog
        open={!!deleteProject && !editorBlocked}
        onOpenChange={(open) => {
          if (open && !p.canRunProjectOperation() && !emptyProjectState) return;
          if (!open && !deletingProjectId) setDeleteProject(null);
        }}
      >
        <AlertDialogContent className="border" style={{ background: color.bg1, borderColor: color.cardBorder, color: color.text }}>
          <AlertDialogHeader>
            <AlertDialogTitle style={{ font: `600 16px ${font.heading}`, color: color.text }}>
              {deleteProject?.id === p.projectId ? "นำโปรเจกต์ที่เปิดอยู่ออกจากรายการ?" : "นำโปรเจกต์นี้ออกจากรายการ?"}
            </AlertDialogTitle>
            <AlertDialogDescription style={{ color: color.textSecondary, lineHeight: 1.7 }}>
              {deleteProject?.id === p.projectId
                ? "โปรเจกต์จะหายจากรายการนี้ ระบบจะเปิดโปรเจกต์ถัดไปให้ ถ้าไม่เหลือ จะหยุดที่หน้าว่างโดยไม่สร้าง New Project เพิ่ม วิดีโอใน Gallery จะยังอยู่"
                : "โปรเจกต์จะหายจากรายการนี้ แต่วิดีโอใน Gallery จะยังอยู่"}
              {deleteProject?.title ? `: ${deleteProject.title}` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={!!deletingProjectId}
              className="border hover:opacity-80"
              style={{ borderColor: color.cardBorder, background: "transparent", color: color.textSecondary }}
            >
              ยกเลิก
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={!!deletingProjectId}
              onClick={(event) => {
                event.preventDefault();
                void handleDeleteProject();
              }}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {deletingProjectId ? <span className="flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> กำลังนำออก…</span> : "นำออกจากรายการ"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </div>
      <EditorProjectRecoveryDialog
        recovery={p.recovery}
        onRetryLoad={p.retryProjectBootstrap}
        onRetryConflictRefresh={p.retryConflictServerRefresh}
        onChooseLocal={p.chooseLocalProjectDraft}
        onChooseServer={p.chooseServerProjectDraft}
      />
    </div>
  );
}

function EmptyProjectView({ onCreate }: { onCreate: () => void }) {
  return (
    <main className="flex flex-1 items-center px-6 py-12 sm:px-10" aria-labelledby="empty-project-title">
      <div className="mx-auto w-full max-w-[620px]">
        <div className="mb-7 h-px w-16" style={{ background: color.primary500 }} />
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: color.primary300 }}>
          พื้นที่ทำงานว่าง
        </p>
        <h1
          id="empty-project-title"
          className="max-w-[520px] text-[clamp(1.75rem,5vw,3rem)] font-semibold leading-[1.08] tracking-[-0.035em]"
          style={{ color: color.text, fontFamily: font.heading }}
        >
          ไม่มีโปรเจกต์ค้างอยู่แล้ว
        </h1>
        <p className="mt-4 max-w-[500px] text-sm leading-7" style={{ color: color.textSecondary }}>
          โปรเจกต์ที่นำออกจะไม่เด้งกลับมาในรายการ และระบบจะยังไม่สร้าง New Project จนกว่ามิวจะพร้อมเริ่มงานถัดไป
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-4">
          <BtnPrimary onClick={onCreate} style={{ minHeight: 46 }}>
            <span className="flex items-center gap-2"><Plus size={15} /> สร้างโปรเจกต์ใหม่</span>
          </BtnPrimary>
          <Link href="/videos" className="text-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4" style={{ color: color.link }}>
            ดูงานใน Gallery
          </Link>
        </div>
      </div>
    </main>
  );
}

/** Autosave hint in the topbar subline — reflects useV2Project's debounced persist. */
function SaveStatus({ status, onRetry }: {
  status: "idle" | "saving" | "saved" | "error";
  onRetry: () => void;
}) {
  if (status === "saving") {
    return <span>กำลังบันทึก…</span>;
  }
  if (status === "saved") {
    return (
      <span className="inline-flex items-center gap-1" style={{ color: color.textSecondary }}>
        <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color.success }} />
        บันทึกแล้ว
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1.5" style={{ color: color.danger }}>
        ยังไม่ได้บันทึก
        <button
          type="button"
          onClick={onRetry}
          style={{ color: color.link, background: "none", border: "none", padding: 0, cursor: "pointer" }}
        >
          ลองใหม่
        </button>
      </span>
    );
  }
  return <span>บันทึกอัตโนมัติ</span>;
}

function FailedView({ job, exportMode = false, plan, onTrial, onBack, onSwitchFaceless }: {
  job: V2JobState;
  exportMode?: boolean;
  plan: string | null;
  onTrial: boolean;
  onBack: () => void;
  onSwitchFaceless: () => void;
}) {
  // Classification + copy live in failure-view.ts (pure, unit-tested in
  // scripts/verify-hero-image-disclosure.ts) so the exact-code matching that fixed the
  // OMNIVOICE_PROVIDER_RATE_LIMITED false-positive stays covered by real fixtures,
  // not just a regex over this component's source.
  const kind = classifyFailure(job);
  const isHeygenQuota = kind === "heygen-quota";
  const isProviderKey = kind === "provider-key";
  const isProviderQuota = kind === "provider-quota";
  const isHeygenKey = isProviderKey && job.errorProvider === "heygen";
  const isInsufficientCredits = kind === "insufficient-credits";
  const isPlanQuota = kind === "plan-quota";
  const { heading, body } = failureViewCopy(kind, job, exportMode);
  // Same funnel event as the submit-time refusal, so both quota dead-ends land in one
  // series. Keyed on the job id so a re-render of this screen can't inflate the count.
  const quotaTrackedJobRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isPlanQuota) return;
    const key = job.jobId ?? "unknown";
    if (quotaTrackedJobRef.current === key) return;
    quotaTrackedJobRef.current = key;
    trackEvent("quota_hit", {
      category: "product",
      status: "info",
      step: "failed-job",
      properties: { kind: "minutes", plan, onTrial, canBuyCredits: CREDITS_LIVE_CLIENT },
    });
  }, [isPlanQuota, job.jobId, plan, onTrial]);
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="flex max-w-[560px] flex-col items-center gap-4 text-center">
        <div className="flex items-center gap-2">
          <XCircle size={18} color={color.danger} />
          <span style={{ font: `600 16px ${font.heading}`, color: color.danger }}>{heading}</span>
        </div>
        <div style={{ fontSize: 12, color: color.textSecondary, lineHeight: 1.7 }}>
          {body}
        </div>
        {isHeygenQuota ? (
          <div className="flex flex-wrap items-center justify-center gap-3">
            <a href="https://app.heygen.com/settings?nav=API" target="_blank" rel="noreferrer">
              <BtnSecondary>เติมเครดิต HeyGen</BtnSecondary>
            </a>
            <BtnPrimary onClick={onSwitchFaceless}>เปลี่ยนเป็น Faceless แล้วลองใหม่</BtnPrimary>
          </div>
        ) : isProviderKey || isProviderQuota ? (
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link href="/settings">
              <BtnSecondary>{isProviderKey ? "ตรวจสอบ API Key" : "ตรวจสอบบัญชีที่เชื่อม"}</BtnSecondary>
            </Link>
            {isHeygenKey
              ? <BtnPrimary onClick={onSwitchFaceless}>ปิด Avatar แล้วลองใหม่</BtnPrimary>
              : <BtnPrimary onClick={onBack}>{exportMode ? "กลับไปลองส่งออกใหม่" : "กลับไปตั้งค่า"}</BtnPrimary>}
          </div>
        ) : isPlanQuota ? (
          <div className="flex flex-wrap items-center justify-center gap-3">
            {CREDITS_LIVE_CLIENT && (
              <Link href={QUOTA_BUY_CREDITS_HREF}>
                <BtnSecondary>เติมเครดิต</BtnSecondary>
              </Link>
            )}
            <Link href={QUOTA_PRICING_HREF}>
              <BtnSecondary>ดูแผนราคา</BtnSecondary>
            </Link>
            <BtnPrimary onClick={onBack}>{exportMode ? "กลับไปแก้ซับ แล้วลองส่งออกใหม่" : "กลับไปตั้งค่า แล้วลองใหม่"}</BtnPrimary>
          </div>
        ) : isInsufficientCredits ? (
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link href="/pricing?from=editor">
              <BtnSecondary>เติมเครดิต</BtnSecondary>
            </Link>
            <BtnPrimary onClick={onBack}>{exportMode ? "กลับไปแก้ซับ แล้วลองส่งออกใหม่" : "กลับไปตั้งค่า แล้วลองใหม่"}</BtnPrimary>
          </div>
        ) : (
          <BtnPrimary onClick={onBack}>{exportMode ? "กลับไปแก้ซับ แล้วลองส่งออกใหม่" : "กลับไปตั้งค่า แล้วลองใหม่"}</BtnPrimary>
        )}
      </div>
    </main>
  );
}

function ExportedView({ job, onNewProject, onEditPreview, downloadFilename }: {
  job: V2JobState;
  onNewProject: () => void;
  onEditPreview?: () => void;
  downloadFilename: string;
}) {
  const videoUrl = job.output?.videoUrl ?? "";

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="flex w-[520px] max-w-[92vw] flex-col items-center gap-4 text-center">
        <FirstClipExportedViewSignal />
        <div className="flex items-center gap-2">
          <CheckCircle2 size={18} color={color.success} />
          <span style={{ font: `600 16px ${font.heading}`, color: color.success }}>ส่งออกสำเร็จ — อยู่ใน Gallery แล้ว</span>
        </div>
        {videoUrl ? (
          <video
            src={videoUrl}
            controls
            playsInline
            className="max-h-[52vh]"
            style={{ borderRadius: 12, border: `1px solid ${color.cardBorder}`, aspectRatio: "9/16" }}
          />
        ) : (
          <div style={{ fontSize: 12, color: color.textSecondary }}>ส่งออกเสร็จแล้ว แต่ไม่พบ URL วิดีโอในสถานะงาน</div>
        )}
        <div className="flex flex-wrap items-center justify-center gap-3">
          {videoUrl && (
            <a href={videoUrl} download={downloadFilename} onClick={emitFirstClipViewed}>
              <BtnPrimary><span className="flex items-center gap-2"><Download size={14} /> ดาวน์โหลด</span></BtnPrimary>
            </a>
          )}
          <a href="/videos" onClick={emitFirstClipViewed}><BtnSecondary>ดูใน Gallery</BtnSecondary></a>
          {onEditPreview && <BtnGhost onClick={onEditPreview}>แก้ซับต่อ</BtnGhost>}
          <BtnGhost onClick={onNewProject}>เริ่มโปรเจกต์ใหม่</BtnGhost>
        </div>
      </div>
    </main>
  );
}
