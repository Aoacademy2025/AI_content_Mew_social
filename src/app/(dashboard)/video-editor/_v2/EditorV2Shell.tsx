"use client";

/**
 * Editor v2 shell (P0) — โครงเปล่าตามดีไซน์ handoff (จอ 5a/4a/5b/4b, Design System v1.1)
 * ยังไม่มีเนื้อ: topbar + step indicator เท่านั้น เนื้อแต่ละเฟสมาใน P3/P5/P6
 * Token อ้างอิง: README ใน design_handoff_editor_redesign (สี/ระยะ/ฟอนต์)
 */

import { Check } from "lucide-react";

const STEPS = [
  { num: "01", label: "สคริปต์" },
  { num: "02", label: "องค์ประกอบ" },
  { num: "03", label: "แต่งซับ" },
] as const;

function StepIndicator({ active = 0, done = [] as number[] }) {
  return (
    <div
      className="flex items-center gap-1 rounded-full p-[5px]"
      style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)" }}
    >
      {STEPS.map((s, i) => {
        const isActive = i === active;
        const isDone = done.includes(i);
        return (
          <div
            key={s.num}
            className="flex items-center gap-1.5 rounded-full px-3 py-1"
            style={isActive ? { background: "linear-gradient(180deg,#8B66F8,#6C4CF4)" } : undefined}
          >
            {isDone ? (
              <Check size={12} strokeWidth={2.5} color="#34D399" />
            ) : (
              <span
                className="text-[10.5px] font-semibold"
                style={{ fontFamily: "Kanit, 'Noto Sans Thai', sans-serif", color: isActive ? "rgba(255,255,255,.75)" : "#55556E" }}
              >
                {s.num}
              </span>
            )}
            <span
              className="text-[12px]"
              style={{
                fontFamily: "Kanit, 'Noto Sans Thai', sans-serif",
                fontWeight: 500,
                color: isActive ? "#fff" : isDone ? "#9C9CB4" : "#55556E",
              }}
            >
              {s.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function EditorV2Shell() {
  return (
    <div className="flex h-screen flex-col" style={{ background: "#0A0A10", color: "#F2F2F8" }}>
      {/* Topbar 58px */}
      <header
        className="flex h-[58px] shrink-0 items-center justify-between px-4"
        style={{ borderBottom: "1px solid rgba(255,255,255,.08)" }}
      >
        <div className="flex items-center gap-3">
          <div
            className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] text-[15px] font-semibold text-white"
            style={{ background: "linear-gradient(180deg,#8B66F8,#6C4CF4)", fontFamily: "Kanit, sans-serif" }}
          >
            H
          </div>
          <div className="leading-tight">
            <div className="text-[13.5px]" style={{ fontFamily: "Kanit, 'Noto Sans Thai', sans-serif", fontWeight: 500 }}>
              New Project
            </div>
            <div className="text-[10.5px]" style={{ color: "#6A6A85" }}>
              ยังไม่ได้บันทึก
            </div>
          </div>
        </div>

        <StepIndicator active={0} />

        <div
          className="h-[30px] w-[30px] rounded-full"
          style={{ background: "#1C1C2B", border: "1px solid rgba(255,255,255,.10)" }}
          aria-label="บัญชีผู้ใช้"
        />
      </header>

      {/* Content placeholder — P3 (จอ 5a) มาแทนที่ตรงนี้ */}
      <main className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <div className="text-[19px]" style={{ fontFamily: "Kanit, 'Noto Sans Thai', sans-serif", fontWeight: 500 }}>
            Editor v2 — อยู่ระหว่างพัฒนา
          </div>
          <div className="mt-2 text-[13px]" style={{ color: "#9C9CB4" }}>
            โครง P0 เท่านั้น · กลับ UI ปัจจุบันได้ที่{" "}
            <a href="/video-editor?ui=v1" className="underline" style={{ color: "#9B7DFF" }}>
              ?ui=v1
            </a>
          </div>
        </div>
      </main>
    </div>
  );
}
