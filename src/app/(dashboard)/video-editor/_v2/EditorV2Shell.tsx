"use client";

/**
 * Editor v2 shell — เฟสตั้งค่า (จอ 5a/4a) + จอเรนเดอร์ (5b, background จริงผ่าน VideoJob
 * preview mode P4a/P4b) + done/failed placeholder (เฟสแต่งซับเต็มรูปแบบ = P6)
 */

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { XCircle, ChevronLeft, BookOpen, RotateCcw } from "lucide-react";
import { color, font } from "./tokens";
import { v2FontClass } from "./fonts";
import { StepIndicator, BtnPrimary } from "./ui";
import { AccountMenu } from "@/components/layout/account-menu";
import { NotificationBell } from "@/components/layout/notification-bell";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
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

export function EditorV2Shell() {
  const p = useV2Project();
  const router = useRouter();
  const [step, setStep] = useState<0 | 1>(0);
  const { job, submit, cancel, reset, markExported } = useV2Job(p);
  const isMobile = useIsMobile();

  // Render Receipt (D5) — mandatory pre-render summary. Only interposed when the flag
  // is on; with it off handleRender submits directly (byte-identical to before).
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [confirmSubmitting, setConfirmSubmitting] = useState(false);
  const confirmingRef = useRef(false); // hard guard vs. double-click before re-render

  const isRendering = job.phase === "rendering" || job.phase === "submitting";
  const indicatorActive = job.phase === "done" ? 2 : isRendering ? 1 : step;
  const indicatorDone = job.phase === "done" ? [0, 1] : (isRendering || step === 1) ? [0] : [];

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

          <div className="flex min-w-0 flex-col leading-tight">
            <div className="truncate" style={{ font: `500 13.5px ${font.heading}` }}>New Project</div>
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
          <PostPhaseMobile job={job} script={p.mode === "script" ? p.script : ""} onExported={markExported} onNewProject={handleNewProject} />
        ) : (
          <PostPhase job={job} script={p.mode === "script" ? p.script : ""} onExported={markExported} onNewProject={handleNewProject} />
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
