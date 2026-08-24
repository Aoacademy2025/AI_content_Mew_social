"use client";

import { isInlineFixableSubtitleCode, subtitleQualityInlineCopy } from "@/lib/mcp/subtitle-quality";
import type { ParsedVideoJobOutput } from "@/lib/mcp/video-job";
import { color } from "./tokens";

export function SubtitleQaInlineBanner({ output }: { output: ParsedVideoJobOutput | null }) {
  const report = output?.subtitleQa;
  if (!report || report.status !== "failed" || !isInlineFixableSubtitleCode(report.code)) return null;
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
      คลิปส่งออกได้แล้ว — {subtitleQualityInlineCopy(report.code)}
    </div>
  );
}
