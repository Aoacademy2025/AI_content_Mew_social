"use client";

/**
 * Editor v2 shell — เฟสตั้งค่า (จอ 5a/4a) + จอเรนเดอร์ (5b, background จริงผ่าน VideoJob
 * preview mode P4a/P4b) + done/failed placeholder (เฟสแต่งซับเต็มรูปแบบ = P6)
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { XCircle, ChevronLeft, BookOpen, RotateCcw, FolderOpen, Plus, Check, CheckCircle2, Download, Loader2, Trash2 } from "lucide-react";
import { color, font } from "./tokens";
import { v2FontClass } from "./fonts";
import { StepIndicator, BtnPrimary, BtnSecondary, BtnGhost } from "./ui";
import { AccountMenu } from "@/components/layout/account-menu";
import { NotificationBell } from "@/components/layout/notification-bell";
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
import { useV2Project } from "./useV2Project";
import { useV2Job, type SubmitResult, type V2JobState } from "./useV2Job";
import { Step1Script } from "./Step1Script";
import { Step2Elements } from "./Step2Elements";
import { RenderingScreen } from "./RenderingScreen";
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

export function EditorV2Shell() {
  const p = useV2Project();
  const downloadFilename = resolveVideoDownloadFilename({
    projectTitle: p.projectTitle,
    script: p.mode === "script" ? p.script : null,
  });
  const router = useRouter();
  const [step, setStep] = useState<0 | 1>(0);
  const { job, submit, submitExport, cancel, reset, adoptJob, resumeJob, markPreviewMissing } = useV2Job(p);
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

  function handleSubmitResult(result: SubmitResult) {
    if (result.ok) {
      if (result.warning) toast.warning(result.warning);
      return;
    }
    if (result.code === "quota" && result.provider === "heygen") {
      setHeygenQuotaAlert(result.message ?? "เครดิต HeyGen ไม่เพียงพอสำหรับสร้าง Avatar");
      return;
    }
    toast.error(result.message ?? "ส่งงานไม่สำเร็จ");
  }

  async function handleRender() {
    if (!p.canRunProjectOperation()) return;
    if (!CREDITS_LIVE_CLIENT) {
      const r = await submit();
      handleSubmitResult(r);
      return;
    }
    setReceiptOpen(true);
  }

  // Confirm from the receipt → the ONE real submit. Ref-guarded so a rapid double-click
  // can't fire submit twice before React re-renders the disabled button.
  async function handleConfirmRender() {
    if (!p.canRunProjectOperation()) return;
    if (confirmingRef.current) return;
    confirmingRef.current = true;
    setConfirmSubmitting(true);
    try {
      const r = await submit();
      handleSubmitResult(r);
    } finally {
      confirmingRef.current = false;
      setConfirmSubmitting(false);
      setReceiptOpen(false); // ok → shell already swapped to RenderingScreen; fail → back to Step2
    }
  }

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
      if (!res.ok) throw new Error(data?.message ?? data?.error ?? `ลบไม่สำเร็จ (${res.status})`);
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
    logoEligible: p.canUseLogoOverlay,
    projectSaveStatus: p.saveStatus,
    onRetryProjectSave: p.retryProjectSave,
  };
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
              <span>·</span>
              <a href="/video-editor?ui=v1" style={{ color: color.link }}>UI เดิม (รุ่นเก่า)</a>
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
          <div className="hidden items-center gap-3 lg:flex">
            <NotificationBell />
            <Link
              href="/docs"
              className="text-[13px] transition-opacity hover:opacity-80"
              style={{ color: color.textSecondary, fontFamily: font.body }}
            >
              วิธีใช้งาน
            </Link>
          </div>
          <AccountMenu
            extraItems={
              <>
                <DropdownMenuItem asChild className="cursor-pointer lg:hidden">
                  <Link href="/docs">
                    <BookOpen className="mr-2 h-4 w-4" />
                    วิธีใช้งาน
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild className="cursor-pointer lg:hidden">
                  <a href="/video-editor?ui=v1">
                    <RotateCcw className="mr-2 h-4 w-4" />
                    UI เดิม (รุ่นเก่า)
                  </a>
                </DropdownMenuItem>
              </>
            }
          />
        </div>
      </header>

      {emptyProjectState ? (
        <EmptyProjectView onCreate={() => void handleNewProject()} />
      ) : isRendering ? (
        <RenderingScreen job={job} hasAvatar={p.mode !== "upload" && p.useAvatar && !!p.avatarId} uploadMode={p.mode === "upload"} exportMode={job.jobType === "export"} onCancel={handleCancel} />
      ) : shouldShowUnavailablePreview(job.phase, job.mediaState) ? (
        <ExpiredPreviewView
          state={job.mediaState}
          onRerender={() => prepareExpiredPreviewRerender(reset, setStep)}
        />
      ) : job.phase === "done" ? (
        job.output?.preview ? (
          isMobile ? (
            <PostPhaseMobile {...postPhaseProjectProps} job={job} script={p.mode === "script" ? p.script : ""} onExportJob={submitExport} onAdoptJob={adoptJob} onNewProject={handleNewProject} onPreviewError={markPreviewMissing} brollRegionPreference={p.brollRegionPreference} brollVisualStyle={p.brollVisualStyle} downloadFilename={downloadFilename} />
          ) : (
            <PostPhase {...postPhaseProjectProps} job={job} script={p.mode === "script" ? p.script : ""} onExportJob={submitExport} onAdoptJob={adoptJob} onNewProject={handleNewProject} onPreviewError={markPreviewMissing} brollRegionPreference={p.brollRegionPreference} brollVisualStyle={p.brollVisualStyle} downloadFilename={downloadFilename} />
          )
        ) : (
          <ExportedView
            job={job}
            onNewProject={handleNewProject}
            onEditPreview={(job.output?.sourceJobId ?? p.activeJobId) ? () => resumeJob((job.output?.sourceJobId ?? p.activeJobId)!) : undefined}
            downloadFilename={downloadFilename}
          />
        )
      ) : job.phase === "failed" ? (
        <FailedView
          job={job}
          exportMode={job.jobType === "export"}
          onSwitchFaceless={() => {
            p.setUseAvatar(false);
            reset();
            setStep(1);
            toast.success("เปลี่ยนเป็น Faceless แล้ว — พร้อมลองสร้างใหม่");
          }}
          onBack={() => {
            if (job.jobType === "export" && p.activeJobId) {
              resumeJob(p.activeJobId);
              return;
            }
            reset();
            setStep(1);
          }}
        />
      ) : step === 0 ? (
        <Step1Script p={p} onNext={() => setStep(1)} />
      ) : (
        <Step2Elements p={p} onRender={handleRender} />
      )}

      {CREDITS_LIVE_CLIENT && (
        <RenderReceiptDialog
          p={p}
          open={receiptOpen && !editorBlocked}
          submitting={confirmSubmitting}
          onConfirm={() => void handleConfirmRender()}
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

function FailedView({ job, exportMode = false, onBack, onSwitchFaceless }: {
  job: V2JobState;
  exportMode?: boolean;
  onBack: () => void;
  onSwitchFaceless: () => void;
}) {
  const isHeygenQuota = job.errorProvider === "heygen" && job.errorCode === "quota";
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="flex max-w-[560px] flex-col items-center gap-4 text-center">
        <div className="flex items-center gap-2">
          <XCircle size={18} color={color.danger} />
          <span style={{ font: `600 16px ${font.heading}`, color: color.danger }}>{exportMode ? "ส่งออกไม่สำเร็จ" : "เรนเดอร์ไม่สำเร็จ"}</span>
        </div>
        <div style={{ fontSize: 12, color: color.textSecondary, lineHeight: 1.7 }}>
          {job.errorMessage ?? "เกิดข้อผิดพลาด — ลองใหม่อีกครั้ง"}
        </div>
        {isHeygenQuota ? (
          <div className="flex flex-wrap items-center justify-center gap-3">
            <a href="https://app.heygen.com/settings?nav=API" target="_blank" rel="noreferrer">
              <BtnSecondary>เติมเครดิต HeyGen</BtnSecondary>
            </a>
            <BtnPrimary onClick={onSwitchFaceless}>เปลี่ยนเป็น Faceless แล้วลองใหม่</BtnPrimary>
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
            <a href={videoUrl} download={downloadFilename}>
              <BtnPrimary><span className="flex items-center gap-2"><Download size={14} /> ดาวน์โหลด</span></BtnPrimary>
            </a>
          )}
          <a href="/videos"><BtnSecondary>ดูใน Gallery</BtnSecondary></a>
          {onEditPreview && <BtnGhost onClick={onEditPreview}>แก้ซับต่อ</BtnGhost>}
          <BtnGhost onClick={onNewProject}>เริ่มโปรเจกต์ใหม่</BtnGhost>
        </div>
      </div>
    </main>
  );
}
