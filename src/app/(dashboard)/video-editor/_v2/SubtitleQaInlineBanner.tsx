"use client";

import { isInlineFixableSubtitleCode, subtitleQualityInlineCopy } from "@/lib/mcp/subtitle-quality";
import type { ParsedVideoJobOutput } from "@/lib/mcp/video-job";
import { color } from "./tokens";

export function SubtitleQaInlineBanner({ output }: { output: ParsedVideoJobOutput | null }) {
  const report = output?.subtitleQa;
  const acoustic = output?.subtitleEvidence?.verification?.acoustic;
  const partialTiming = acoustic?.applied && acoustic.status === "partial";
  // ADR 0056: a finding is a report. `warning` and (legacy) `failed` both render the
  // same inline hint — neither ever blocks the export.
  const repairHint = report && report.status !== "passed" && isInlineFixableSubtitleCode(report.code)
    ? subtitleQualityInlineCopy(report.code) : null;
  if (!partialTiming && !repairHint) return null;
  return (
    <div
      role="status"
      className="px-5 py-2"
      style={{
        fontSize: 11.5,
        color: color.warningText,
        borderBottom: `1px solid ${color.cardBorder}`,
        background: "rgba(251,191,36,.08)",
      }}
    >
      คลิปส่งออกได้แล้ว — {partialTiming
        ? "ซับบางช่วงยังใช้เวลาโดยประมาณ กรุณาดูตัวอย่างและตรวจซับกับเสียงก่อนดาวน์โหลด"
        : repairHint}
    </div>
  );
}
