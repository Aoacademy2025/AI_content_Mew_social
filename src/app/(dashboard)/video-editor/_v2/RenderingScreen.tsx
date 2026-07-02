"use client";

/**
 * ระหว่างเรนเดอร์ (จอ 5b): แผงแก้วกลางจอ + progress ring + เช็กลิสต์ pipeline ภาษาคน
 * background render ของจริง (P4a) — ปิดหน้าได้ งานทำต่อ กลับมา resume อัตโนมัติ
 */

import { Check, Loader2 } from "lucide-react";
import { color, font } from "./tokens";
import { GlassPanel, BtnGhost } from "./ui";
import type { V2JobState } from "./useV2Job";

// map currentStep (tts|captions|keywords|stock|config|render|avatar|burn|composite labels)
// → เช็กลิสต์ภาษาคน 4-5 ข้อตามดีไซน์
const CHECKLIST: { key: string; label: string; steps: string[]; optional?: boolean }[] = [
  { key: "voice", label: "สร้างเสียงพากย์", steps: ["tts"] },
  { key: "subs", label: "ถอดซับไทยให้ตรงเสียงเป๊ะ", steps: ["captions"] },
  { key: "broll", label: "กำลังหาบีโรลให้เข้ากับเนื้อหา", steps: ["keywords", "stock"] },
  { key: "assemble", label: "ประกอบวิดีโอ + เพลง + ซับ", steps: ["config", "render"] },
  { key: "avatar", label: "สร้างพิธีกร AI + วางบนวิดีโอ", steps: ["avatar"], optional: true },
];

function checklistIndex(currentStep: string | null): number {
  if (!currentStep) return 0;
  const i = CHECKLIST.findIndex((c) => c.steps.includes(currentStep));
  // step แปลก ๆ (composite ฯลฯ) → ถือว่าอยู่ท้าย pipeline
  return i === -1 ? CHECKLIST.length - 1 : i;
}

export function RenderingScreen({ job, hasAvatar, onCancel }: {
  job: V2JobState;
  hasAvatar: boolean;
  onCancel: () => void;
}) {
  const items = CHECKLIST.filter((c) => !c.optional || hasAvatar);
  const activeIdx = checklistIndex(job.currentStep);
  const pct = Math.max(0, Math.min(100, job.progress));
  const queued = job.currentStep === null && pct === 0;
  const etaLabel = hasAvatar ? "~15–25 นาที (มีพิธีกร AI)" : "~3–6 นาที";

  return (
    <main
      className="flex flex-1 items-center justify-center"
      style={{ background: "radial-gradient(ellipse 60% 50% at 50% 42%, rgba(139,92,246,.13), transparent 70%)" }}
    >
      <GlassPanel className="flex w-[520px] max-w-[92vw] flex-col items-center gap-5 px-10 py-8">
        {/* Progress ring (conic 54px) */}
        <div
          className="flex h-[54px] w-[54px] items-center justify-center rounded-full"
          style={{ background: `conic-gradient(${color.primary500} ${pct * 3.6}deg, rgba(255,255,255,.08) 0deg)` }}
        >
          <div
            className="flex h-[44px] w-[44px] items-center justify-center rounded-full"
            style={{ background: "#161624", font: `600 12px ${font.heading}` }}
          >
            {pct}%
          </div>
        </div>

        <div className="text-center">
          <div style={{ font: `600 18px ${font.heading}` }}>กำลังสร้างวิดีโอของคุณ</div>
          <div style={{ fontSize: 11.5, color: color.textSecondary, marginTop: 4 }}>
            {queued ? "อยู่ในคิว — เริ่มอัตโนมัติเมื่อถึงลำดับ" : `เวลาโดยประมาณ ${etaLabel}`}
          </div>
        </div>

        {/* เช็กลิสต์ภาษาคน */}
        <div className="flex w-full flex-col gap-2.5">
          {items.map((c, i) => {
            const isDone = i < activeIdx || job.phase === "done";
            const isActive = i === activeIdx && job.phase !== "done" && !queued;
            return (
              <div key={c.key} className="flex items-center gap-3">
                {isDone ? (
                  <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full" style={{ background: "rgba(52,211,153,.14)" }}>
                    <Check size={12} strokeWidth={2.5} color={color.success} />
                  </span>
                ) : isActive ? (
                  <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full" style={{ background: "rgba(139,92,246,.18)" }}>
                    <Loader2 size={12} strokeWidth={2.2} color={color.primary300} className="animate-spin" />
                  </span>
                ) : (
                  <span
                    className="flex h-[22px] w-[22px] items-center justify-center rounded-full"
                    style={{ border: "1px solid rgba(255,255,255,.12)", font: `500 10px ${font.heading}`, color: color.textFaintest }}
                  >
                    {i + 1}
                  </span>
                )}
                <span style={{ fontSize: 12.5, color: isDone ? color.textSecondary : isActive ? color.text : color.textFaintest }}>
                  {c.label}
                </span>
              </div>
            );
          })}
        </div>

        <div className="flex w-full items-center justify-between pt-1">
          <span style={{ fontSize: 10.5, color: color.textFaint, lineHeight: 1.6 }}>
            ปิดหน้านี้ได้เลย — งานทำต่อบนเซิร์ฟเวอร์<br />กลับเข้ามาเมื่อไหร่ก็เห็นสถานะล่าสุด
          </span>
          <BtnGhost
            onClick={onCancel}
            disabled={!queued}
            title={queued ? "ยกเลิกงานในคิว" : "งานเริ่มทำแล้ว — ยกเลิกไม่ได้"}
            style={!queued ? { opacity: 0.4, cursor: "not-allowed", padding: "8px 16px" } : { padding: "8px 16px" }}
          >
            ยกเลิก
          </BtnGhost>
        </div>
      </GlassPanel>
    </main>
  );
}
