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

function checklistIndex(list: { steps: string[] }[], currentStep: string | null): number {
  if (!currentStep) return 0;
  const i = list.findIndex((c) => c.steps.includes(currentStep));
  // step แปลก ๆ → ถือว่าอยู่ท้าย pipeline
  return i === -1 ? list.length - 1 : i;
}

// เช็กลิสต์โหมดอัปคลิปเอง (cutaway): ไม่มีเสียงพากย์ · ปิดท้ายด้วยการวางคลิปสลับบีโรล
const UPLOAD_CHECKLIST: { key: string; label: string; steps: string[]; optional?: boolean }[] = [
  { key: "subs", label: "ถอดซับไทยจากเสียงในคลิป", steps: ["captions"] },
  { key: "broll", label: "กำลังหาบีโรลให้เข้ากับเนื้อหา", steps: ["keywords", "stock"] },
  { key: "assemble", label: "ประกอบม้วนบีโรล", steps: ["config", "render"] },
  { key: "cutaway", label: "วางคลิปของคุณสลับกับบีโรล", steps: ["composite"] },
];

const EXPORT_CHECKLIST: { key: string; label: string; steps: string[]; optional?: boolean }[] = [
  { key: "burn", label: "ฝังซับลงวิดีโอจริง", steps: ["burn"] },
  { key: "save", label: "บันทึกวิดีโอเข้า Gallery", steps: ["save"] },
];

export function RenderingScreen({ job, hasAvatar, uploadMode = false, exportMode = false, onCancel }: {
  job: V2JobState;
  hasAvatar: boolean;
  uploadMode?: boolean;
  exportMode?: boolean;
  onCancel: () => void;
}) {
  const baseList = exportMode ? EXPORT_CHECKLIST : uploadMode ? UPLOAD_CHECKLIST : CHECKLIST;
  const items = baseList.filter((c) => !c.optional || hasAvatar);
  const activeIdx = checklistIndex(items, job.currentStep);
  const pct = Math.max(0, Math.min(100, job.progress));
  const queued = job.currentStep === null && pct === 0;
  const queueLabel = job.queuePosition
    ? `อยู่ในคิว #${job.queuePosition} — เริ่มอัตโนมัติเมื่อถึงลำดับ`
    : "อยู่ในคิว — เริ่มอัตโนมัติเมื่อถึงลำดับ";
  const etaLabel = exportMode ? "~1–3 นาที" : hasAvatar ? "~15–25 นาที (มีพิธีกร AI)" : "~3–6 นาที";

  return (
    <main
      className="flex flex-1 items-center justify-center"
      style={{ background: "radial-gradient(ellipse 60% 50% at 50% 42%, rgba(139,92,246,.13), transparent 70%)" }}
    >
      <GlassPanel className="flex w-[520px] max-w-[92vw] flex-col items-center gap-5 px-10 py-8 max-lg:px-6">
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
          <div style={{ font: `600 18px ${font.heading}` }}>{exportMode ? "กำลังส่งออกวิดีโอ" : "กำลังสร้างวิดีโอของคุณ"}</div>
          <div
            role="status"
            aria-live="polite"
            style={{ fontSize: 11.5, color: color.textSecondary, marginTop: 4 }}
          >
            {queued ? queueLabel : `เวลาโดยประมาณ ${etaLabel}`}
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
            title={queued ? "ยกเลิกงานในคิว" : "หยุดหลังจบขั้นตอนปัจจุบัน"}
            style={{ padding: "8px 16px" }}
          >
            ยกเลิก
          </BtnGhost>
        </div>
      </GlassPanel>
    </main>
  );
}
