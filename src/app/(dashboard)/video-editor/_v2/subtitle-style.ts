/**
 * v2 subtitle styling (จอ 4b) — 4 สไตล์ตามดีไซน์ map ลง preset/effect จริงของ renderer
 * + ตัวประกอบ burn config (mirror ของ buildBurnConfig ฝั่ง MCP แต่รับ style เต็ม)
 */

import type { VideoJobPreviewData } from "@/lib/mcp/video-job";

export type V2StyleKey = "viral" | "shadow" | "outline" | "clean";

export const V2_STYLES: { key: V2StyleKey; label: string; desc: string; preset: string; effect: string }[] = [
  { key: "viral", label: "เด้งไวรัล", desc: "ขอบดำ + เด้งเข้า", preset: "stroke", effect: "pop" },
  { key: "shadow", label: "เงาเข้ม", desc: "Shadow นุ่ม อ่านง่าย", preset: "stroke", effect: "fade" },
  { key: "outline", label: "ขอบหนา", desc: "Outline คมชัด", preset: "sharp-outline", effect: "quick" },
  { key: "clean", label: "มินิมอล", desc: "กล่องเรียบ Clean", preset: "box-rounded", effect: "fade" },
];

export const V2_FONTS = ["Kanit", "Sarabun", "Prompt", "Mitr", "Noto Sans Thai", "Bai Jamjuree"] as const;

export const V2_TEXT_COLORS = ["#FFFFFF", "#FFE500", "#38BDF8", "#F472B6", "#000000"] as const;
export const V2_ACCENT_COLORS = ["#FFE500", "#F87171", "#34D399", "#38BDF8"] as const;

export interface V2SubConfig {
  style: V2StyleKey;
  fontFamily: string;
  bold: boolean;
  textColor: string;
  accentColor: string;
  /** % จากขอบบน (10–95) */
  verticalPos: number;
}

export const DEFAULT_V2_SUB: V2SubConfig = {
  style: "viral",
  fontFamily: "Kanit",
  bold: true,
  textColor: "#FFFFFF",
  accentColor: "#FFE500",
  verticalPos: 82,
};

export type V2Caption = VideoJobPreviewData["captions"][number];

/** subtitleOverlayConfig สำหรับ /api/videos/render — โครงเดียวกับ buildBurnConfig (MCP) */
export function buildV2BurnConfig(
  baseVideoUrl: string,
  captions: V2Caption[],
  audioDurationMs: number,
  cfg: V2SubConfig,
  fps = 30,
) {
  const styleDef = V2_STYLES.find((s) => s.key === cfg.style) ?? V2_STYLES[0];
  const lastEnd = captions.length ? captions[captions.length - 1].endMs : audioDurationMs;
  const durMs = Math.max(audioDurationMs, lastEnd);
  const fontWeight = cfg.bold ? 900 : 400;
  const keywordPopups = captions.map((c) => ({
    text: c.text,
    start: Math.round((c.startMs / 1000) * fps),
    end: Math.round((c.endMs / 1000) * fps),
    tag: c.tag,
    isHighlight: c.tag === "hook",
    color: c.tag === "hook" ? cfg.accentColor : cfg.textColor,
    accentColor: cfg.accentColor,
    fontWeight,
    topPercent: cfg.verticalPos,
    size: 80,
    stylePreset: styleDef.preset,
  }));
  return {
    videoUrl: baseVideoUrl,
    keywordPopups,
    durationInFrames: Math.round((durMs / 1000) * fps),
    fontFamily: cfg.fontFamily,
    subtitleStylePreset: styleDef.preset,
    subtitleTextEffect: styleDef.effect,
    subtitleAccentColor: cfg.accentColor,
  };
}
