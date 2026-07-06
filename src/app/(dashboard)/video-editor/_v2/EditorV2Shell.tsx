"use client";

/**
 * Editor v2 shell — เฟสตั้งค่า (จอ 5a/4a) + จอเรนเดอร์ (5b, background จริงผ่าน VideoJob
 * preview mode P4a/P4b) + done/failed placeholder (เฟสแต่งซับเต็มรูปแบบ = P6)
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { XCircle, ChevronLeft, BookOpen, RotateCcw, FolderOpen, Plus, Check } from "lucide-react";
import { color, font } from "./tokens";
import { v2FontClass } from "./fonts";
import { StepIndicator, BtnPrimary } from "./ui";
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
import { useV2Project } from "./useV2Project";
import { useV2Job, type V2JobState } from "./useV2Job";
import { Step1Script } from "./Step1Script";
import { Step2Elements } from "./Step2Elements";
import { RenderingScreen } from "./RenderingScreen";
import { PostPhase } from "./PostPhase";
import { PostPhaseMobile } from "./PostPhaseMobile";
import { RenderReceiptDialog } from "./RenderReceiptDialog";
import { useIsMobile } from "./useIsMobile";
import { CREDITS_LIVE_CLIENT } from "../_hooks/useCreditsQuota";

type ProjectMenuItem = {
  id: string;
  title: string;
  status: string;
};

const PROJECT_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  rendering: "Rendering",
  post: "Post",
  exported: "Exported",
};

export function EditorV2Shell() {
  const p = useV2Project();
  const router = useRouter();
  const [step, setStep] = useState<0 | 1>(0);
  const { job, submit, cancel, reset, markExported, adoptJob } = useV2Job(p);
  const isMobile = useIsMobile();
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectMenuItem[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);

  // Render Receipt (D5) — mandatory pre-render summary. Only interposed when the flag
  // is on; with it off handleRender submits directly (byte-identical to before).
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [confirmSubmitting, setConfirmSubmitting] = useState(false);
  const confirmingRef = useRef(false); // hard guard vs. double-click before re-render

  const isRendering = job.phase === "rendering" || job.phase === "submitting";
  const indicatorActive = job.phase === "done" ? 2 : isRendering ? 1 : step;
  const indicatorDone = job.phase === "done" ? [0, 1] : (isRendering || step === 1) ? [0] : [];

  useEffect(() => {
    if (!projectMenuOpen) return;
    let alive = true;
    setProjectsLoading(true);
    fetch("/api/editor-projects", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!alive) return;
        setProjects(Array.isArray(data?.projects) ? data.projects.slice(0, 8) : []);
      })
      .catch(() => { if (alive) setProjects([]); })
      .finally(() => { if (alive) setProjectsLoading(false); });
    return () => { alive = false; };
  }, [projectMenuOpen, p.projectId]);

  async function handleRender() {
    if (!CREDITS_LIVE_CLIENT) {
      const r = await submit();
      if (!r.ok) toast.error(r.message ?? "ส่งงานไม่สำเร็จ");
      return;
    }
    setReceiptOpen(true);
  }

  // Confirm from the receipt → the ONE real submit. Ref-guarded so a rapid double-click
  // can't fire submit twice before React re-renders the disabled button.
  async function handleConfirmRender() {
    if (confirmingRef.current) return;
    confirmingRef.current = true;
    setConfirmSubmitting(true);
    try {
      const r = await submit();
      if (!r.ok) toast.error(r.message ?? "ส่งงานไม่สำเร็จ");
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

  function handleNewProject() {
    reset();
    p.resetProject();
    setStep(0);
  }

  function openProject(projectId: string) {
    if (!projectId || projectId === p.projectId) return;
    const url = new URL(window.location.href);
    url.pathname = "/video-editor";
    url.searchParams.set("ui", "v2");
    url.searchParams.set("projectId", projectId);
    window.location.assign(`${url.pathname}?${url.searchParams.toString()}`);
  }

  return (
    <div
      className={`${v2FontClass} flex h-screen flex-col`}
      style={{ background: color.bg0, color: color.text }}
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
            onClick={() => router.push("/dashboard")}
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

          <DropdownMenu open={projectMenuOpen} onOpenChange={setProjectMenuOpen}>
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
              <DropdownMenuLabel className="px-2 py-1.5" style={{ font: `600 11px ${font.heading}`, color: color.textFaint }}>
                โปรเจกต์ล่าสุด
              </DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={() => handleNewProject()}
                className="rounded-[8px] px-2.5 py-2"
                style={{ color: color.primary300, cursor: "pointer" }}
              >
                <Plus size={14} />
                <span style={{ fontSize: 12 }}>โปรเจกต์ใหม่</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator style={{ background: color.cardBorder }} />
              {projectsLoading ? (
                <DropdownMenuItem disabled className="rounded-[8px] px-2.5 py-2" style={{ color: color.textFaint }}>
                  <span style={{ fontSize: 12 }}>กำลังโหลด…</span>
                </DropdownMenuItem>
              ) : projects.length === 0 ? (
                <DropdownMenuItem disabled className="rounded-[8px] px-2.5 py-2" style={{ color: color.textFaint }}>
                  <span style={{ fontSize: 12 }}>ยังไม่มีโปรเจกต์อื่น</span>
                </DropdownMenuItem>
              ) : projects.map((project) => {
                const active = project.id === p.projectId;
                return (
                  <DropdownMenuItem
                    key={project.id}
                    onSelect={() => openProject(project.id)}
                    className="rounded-[8px] px-2.5 py-2"
                    style={{ color: active ? color.primary300 : color.textSecondary, cursor: active ? "default" : "pointer" }}
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                      {active ? <Check size={13} strokeWidth={2.4} /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate" style={{ fontSize: 12 }}>{project.title || "New Project"}</span>
                    <span className="shrink-0" style={{ fontSize: 10, color: color.textFaint }}>
                      {PROJECT_STATUS_LABEL[project.status] ?? project.status}
                    </span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="flex min-w-0 flex-col leading-tight">
            <input
              aria-label="ชื่อโปรเจกต์"
              value={p.projectTitle}
              onChange={(event) => p.setProjectTitle(event.target.value.slice(0, 80))}
              onBlur={() => {
                const trimmed = p.projectTitle.trim();
                p.setProjectTitle(trimmed || "New Project");
              }}
              className="-mx-1.5 min-w-0 truncate rounded-[6px] border-0 bg-transparent px-1.5 py-0 outline-none transition-colors focus:bg-white/[.06]"
              style={{ font: `500 13.5px ${font.heading}`, color: color.text }}
            />
            <div className="hidden items-center gap-1.5 lg:flex" style={{ fontSize: 10.5, color: color.textFaint }}>
              <SaveStatus status={p.saveStatus} />
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

      {isRendering ? (
        <RenderingScreen job={job} hasAvatar={p.mode !== "upload" && p.useAvatar && !!p.avatarId} uploadMode={p.mode === "upload"} onCancel={handleCancel} />
      ) : job.phase === "done" ? (
        isMobile ? (
          <PostPhaseMobile job={job} script={p.mode === "script" ? p.script : ""} onExported={markExported} onAdoptJob={adoptJob} onNewProject={handleNewProject} brollRegionPreference={p.brollRegionPreference} brollVisualStyle={p.brollVisualStyle} />
        ) : (
          <PostPhase job={job} script={p.mode === "script" ? p.script : ""} onExported={markExported} onAdoptJob={adoptJob} onNewProject={handleNewProject} brollRegionPreference={p.brollRegionPreference} brollVisualStyle={p.brollVisualStyle} />
        )
      ) : job.phase === "failed" ? (
        <FailedView job={job} onBack={() => { reset(); setStep(1); }} />
      ) : step === 0 ? (
        <Step1Script p={p} onNext={() => setStep(1)} />
      ) : (
        <Step2Elements p={p} onRender={handleRender} />
      )}

      {CREDITS_LIVE_CLIENT && (
        <RenderReceiptDialog
          p={p}
          open={receiptOpen}
          submitting={confirmSubmitting}
          onConfirm={() => void handleConfirmRender()}
          onCancel={() => { if (!confirmSubmitting) setReceiptOpen(false); }}
        />
      )}
    </div>
  );
}

/** Autosave hint in the topbar subline — reflects useV2Project's debounced persist. */
function SaveStatus({ status }: { status: "idle" | "saving" | "saved" }) {
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
  return <span>บันทึกอัตโนมัติ</span>;
}

function FailedView({ job, onBack }: { job: V2JobState; onBack: () => void }) {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="flex max-w-[560px] flex-col items-center gap-4 text-center">
        <div className="flex items-center gap-2">
          <XCircle size={18} color={color.danger} />
          <span style={{ font: `600 16px ${font.heading}`, color: color.danger }}>เรนเดอร์ไม่สำเร็จ</span>
        </div>
        <div style={{ fontSize: 12, color: color.textSecondary, lineHeight: 1.7 }}>
          {job.errorMessage ?? "เกิดข้อผิดพลาด — ลองใหม่อีกครั้ง"}
        </div>
        <BtnPrimary onClick={onBack}>กลับไปตั้งค่า แล้วลองใหม่</BtnPrimary>
      </div>
    </main>
  );
}
