"use client";

/**
 * Editor v2 shell — เฟสตั้งค่า (สเต็ป 1–2 = จอ 5a/4a) · จอเรนเดอร์ (5b) มาใน P5,
 * เฟสแต่งซับ (4b) มาใน P6. editorPhase: 'setup' | 'rendering' | 'post' (ตอนนี้มีแต่ setup)
 */

import { useState } from "react";
import { color, font } from "./tokens";
import { v2FontClass } from "./fonts";
import { StepIndicator } from "./ui";
import { useV2Project } from "./useV2Project";
import { Step1Script } from "./Step1Script";
import { Step2Elements } from "./Step2Elements";

export function EditorV2Shell() {
  const p = useV2Project();
  const [step, setStep] = useState<0 | 1>(0);

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
              v2 preview · ยังไม่บันทึกอัตโนมัติ ·{" "}
              <a href="/video-editor?ui=v1" style={{ color: color.link }}>กลับ UI ปัจจุบัน</a>
            </div>
          </div>
        </div>

        <StepIndicator
          active={step}
          done={step === 1 ? [0] : []}
          onStepClick={(i) => { if (i < step) setStep(i as 0 | 1); }}
        />

        <div
          className="h-[30px] w-[30px] rounded-full"
          style={{ background: "#1C1C2B", border: "1px solid rgba(255,255,255,.10)" }}
          aria-label="บัญชีผู้ใช้"
        />
      </header>

      {step === 0
        ? <Step1Script p={p} onNext={() => setStep(1)} />
        : <Step2Elements p={p} />}
    </div>
  );
}
