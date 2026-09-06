"use client";

import { compareNarrationDuration } from "@/lib/narration-target";
import { color, font } from "./tokens";
import { BtnSecondary } from "./ui";

/** Reads the delivered take only. Playback and review never request generation. */
export function NarrationDurationReview({ targetSec, audioDurationMs, voiceUrl, onEdit, onRegenerate }: {
  targetSec: unknown;
  audioDurationMs: number;
  voiceUrl: string;
  onEdit: () => void;
  onRegenerate: () => void;
}) {
  const comparison = compareNarrationDuration(targetSec, audioDurationMs);
  if (!comparison) return null;
  return (
    <section aria-label="ตรวจความยาวเสียง" className="shrink-0 border-b px-4 py-3 lg:px-7"
      style={{ borderColor: color.cardBorder, background: color.bg1, fontFamily: font.body }}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <p role="status" className="text-sm" style={{ color: color.text }}>
          เสียงจริง <strong>{comparison.actualSec.toFixed(2)}</strong> / เป้าหมาย {comparison.targetSec} วินาที
          <span className="ml-2 text-xs" style={{ color: comparison.withinTarget ? color.success : color.warning }}>
            {comparison.withinTarget ? "อยู่ในช่วง ±10%" : `${comparison.actualSec > comparison.targetSec ? "ยาว" : "สั้น"}กว่าเป้า ${Math.abs(comparison.deltaSec).toFixed(2)} วินาที · นอกช่วง ±10%`}
          </span>
        </p>
        {voiceUrl ? <audio key={voiceUrl} controls preload="none" src={voiceUrl} aria-label="ฟังเสียงที่สร้างแล้ว" className="h-9 w-full sm:w-64" /> :
          <p className="text-xs" style={{ color: color.textSecondary }}>ไม่มีไฟล์เสียงแยก ฟังจากตัวอย่างวิดีโอได้</p>}
        <div className="flex flex-wrap gap-2">
          <BtnSecondary onClick={onEdit}>แก้บทก่อนสร้างใหม่</BtnSecondary>
          <BtnSecondary onClick={onRegenerate}>ดูค่าใช้จ่ายและสร้างใหม่</BtnSecondary>
        </div>
      </div>
      <p className="mt-2 text-xs leading-relaxed" style={{ color: color.textSecondary }}>
        ใช้เสียงชุดนี้ต่อและส่งออกได้ หรือเลือกแก้บท/สร้างใหม่ด้วยตัวเอง การสร้างใหม่ใช้โควตาและอาจมีค่าบริการเพิ่ม โดยจะแสดงก่อนยืนยัน
      </p>
    </section>
  );
}
