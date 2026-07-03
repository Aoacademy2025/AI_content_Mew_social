"use client";

/**
 * Editor v2 shell — เฟสตั้งค่า (จอ 5a/4a) + จอเรนเดอร์ (5b, background จริงผ่าน VideoJob
 * preview mode P4a/P4b) + done/failed placeholder (เฟสแต่งซับเต็มรูปแบบ = P6)
 */

import { useState } from "react";
import { toast } from "sonner";
import { XCircle } from "lucide-react";
import { color, font } from "./tokens";
import { v2FontClass } from "./fonts";
import { StepIndicator, BtnPrimary } from "./ui";
import { useV2Project } from "./useV2Project";
import { useV2Job, type V2JobState } from "./useV2Job";
import { Step1Script } from "./Step1Script";
import { Step2Elements } from "./Step2Elements";
import { RenderingScreen } from "./RenderingScreen";
import { PostPhase } from "./PostPhase";

export function EditorV2Shell() {
  const p = useV2Project();
  const [step, setStep] = useState<0 | 1>(0);
  const { job, submit, cancel, reset, markExported } = useV2Job(p);

  const isRendering = job.phase === "rendering" || job.phase === "submitting";
  const indicatorActive = job.phase === "done" ? 2 : isRendering ? 1 : step;
  const indicatorDone = job.phase === "done" ? [0, 1] : (isRendering || step === 1) ? [0] : [];

  async function handleRender() {
    const r = await submit();
    if (!r.ok) toast.error(r.message ?? "ส่งงานไม่สำเร็จ");
  }

  async function handleCancel() {
    const r = await cancel();
    if (!r.ok && r.message) toast.error(r.message);
  }

  return (
    <div
      className={`${v2FontClass} flex h-screen flex-col`}
      style={{ background: color.bg0, color: color.text }}
    >
      {/* Topbar 58px */}
      <header
        className="flex h-[58px] shrink-0 items-center justify-between px-4"
        style={{ borderBottom: `1px solid ${color.cardBorder}` }}
      >
        <div className="flex items-center gap-3">
          <div
            className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] text-[15px] font-semibold text-white"
            style={{ background: color.gradientPrimary, fontFamily: font.heading }}
          >
            H
          </div>
          <div className="leading-tight">
            <div style={{ font: `500 13.5px ${font.heading}` }}>New Project</div>
            <div style={{ fontSize: 10.5, color: color.textFaint }}>
              v2 preview ·{" "}
              <a href="/video-editor?ui=v1" style={{ color: color.link }}>กลับ UI ปัจจุบัน</a>
            </div>
          </div>
        </div>

        <StepIndicator
          active={indicatorActive}
          done={indicatorDone}
          onStepClick={(i) => { if (!isRendering && job.phase !== "done" && i < step) setStep(i as 0 | 1); }}
        />

        <div
          className="h-[30px] w-[30px] rounded-full"
          style={{ background: "#1C1C2B", border: "1px solid rgba(255,255,255,.10)" }}
          aria-label="บัญชีผู้ใช้"
        />
      </header>

      {isRendering ? (
        <RenderingScreen job={job} hasAvatar={p.mode !== "upload" && p.useAvatar && !!p.avatarId} uploadMode={p.mode === "upload"} onCancel={handleCancel} />
      ) : job.phase === "done" ? (
        <PostPhase job={job} script={p.mode === "script" ? p.script : ""} onExported={markExported} onNewProject={() => { reset(); setStep(0); }} />
      ) : job.phase === "failed" ? (
        <FailedView job={job} onBack={() => { reset(); setStep(1); }} />
      ) : step === 0 ? (
        <Step1Script p={p} onNext={() => setStep(1)} />
      ) : (
        <Step2Elements p={p} onRender={handleRender} />
      )}
    </div>
  );
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
