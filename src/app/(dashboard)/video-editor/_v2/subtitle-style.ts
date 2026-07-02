/**
 * v2 subtitle styling (จอ 4b) — ใช้ preset/effect/font ชุดเดียวกับ v1 (import จาก
 * _components/constants — ห้าม hardcode ซ้ำ) + โปรไฟล์ด่วน 4 แบบตามดีไซน์
 * + ตัวประกอบ burn config ที่ mirror payload ของ v1 ทุก key
 */

import type { VideoJobPreviewData } from "@/lib/mcp/video-job";
import type { SubPreset, SubTextEffect } from "../_components/types";
import { PRESETS_DATA, EFFECTS_DATA, FONTS_LIST } from "../_components/constants";

export { PRESETS_DATA, EFFECTS_DATA, FONTS_LIST };

/** โปรไฟล์ด่วน 4 แบบตามดีไซน์ 4b — ทางลัดไปยัง preset+effect จริง */
export const V2_QUICK_STYLES: { key: string; label: string; desc: string; preset: SubPreset; effect: SubTextEffect }[] = [
  { key: "viral", label: "เด้งไวรัล", desc: "ขอบดำ + เด้งเข้า", preset: "stroke", effect: "pop" },
  { key: "shadow", label: "เงาเข้ม", desc: "Shadow นุ่ม อ่านง่าย", preset: "stroke", effect: "fade" },
  { key: "outline", label: "ขอบหนา", desc: "Outline คมชัด", preset: "sharp-outline", effect: "quick" },
  { key: "clean", label: "มินิมอล", desc: "กล่องเรียบ Clean", preset: "box-rounded", effect: "fade" },
];

// กฎล็อกเดียวกับ v1 (RightSettingsPanel.tsx:197/262-263 — คัดลอกไว้พร้อม pointer;
// ถ้าแก้ที่โน่นต้องแก้ที่นี่ด้วย)
export const LOCKED_EFFECT_PRESETS: SubPreset[] = ["classic-yellow", "hormozi", "beast", "neon-green", "neon-red", "neon-blue", "pastel", "retro", "box-white", "box-yellow", "news"];
export const LOCKED_COLOR_PRESETS: string[] = ["classic-yellow", "hormozi", "beast", "neon-green", "neon-red", "neon-blue", "pastel", "retro", "box-white", "box-yellow", "news"];
export const LOCKED_ACCENT_PRESETS: string[] = ["neon-green", "neon-red", "neon-blue", "pastel", "classic-yellow", "hormozi", "beast", "box-white", "box-yellow", "retro", "news", "karaoke-box"];

export const V2_TEXT_COLORS = ["#FFFFFF", "#FFE500", "#38BDF8", "#F472B6", "#000000"] as const;
export const V2_ACCENT_COLORS = ["#FFE500", "#F87171", "#34D399", "#38BDF8"] as const;

export interface V2SubConfig {
  preset: SubPreset;
  effect: SubTextEffect;
  fontFamily: string;
  bold: boolean;
  /** px บนเฟรม 1080×1920 (เท่ากับ subFontSize ของ v1: 30–160) */
  fontSize: number;
  textColor: string;
  accentColor: string;
  shadow: boolean;
  outline: boolean;
  outlineSize: number;
  /** % จากขอบบน (10–95) */
  verticalPos: number;
}

export const DEFAULT_V2_SUB: V2SubConfig = {
  preset: "stroke",
  effect: "pop",
  fontFamily: "Kanit",
  bold: true,
  fontSize: 80,
  textColor: "#FFFFFF",
  accentColor: "#FFE500",
  shadow: true,
  outline: false,
  outlineSize: 2,
  verticalPos: 82,
};

export type V2Caption = VideoJobPreviewData["captions"][number];

/** subtitleOverlayConfig — key ครบเท่ากับ burn ของ v1 (page.tsx burnSubtitlesCore) */
export function buildV2BurnConfig(
  baseVideoUrl: string,
  captions: V2Caption[],
  audioDurationMs: number,
  cfg: V2SubConfig,
  fps = 30,
) {
  const lastEnd = captions.length ? captions[captions.length - 1].endMs : audioDurationMs;
  const durMs = Math.max(audioDurationMs, lastEnd, 1000);
  const durationInFrames = Math.max(Math.round((durMs / 1000) * fps), fps);
  const fontWeight = cfg.bold ? 900 : 400;
  let frameCursor = 0;
  const keywordPopups = captions.flatMap((c) => {
    if (frameCursor >= durationInFrames) return [];
    const popup = {
      text: c.text,
      start: Math.round((c.startMs / 1000) * fps),
      end: Math.round((c.endMs / 1000) * fps),
      tag: c.tag ?? "body",
      isHighlight: c.tag === "hook",
      color: cfg.preset === "karaoke-box" ? cfg.textColor : c.tag === "hook" ? cfg.accentColor : cfg.textColor,
      accentColor: cfg.accentColor,
      fontWeight,
      topPercent: cfg.verticalPos,
      size: cfg.fontSize,
      stylePreset: cfg.preset,
    };
    const start = Math.min(Math.max(frameCursor, popup.start), durationInFrames - 1);
    const end = Math.min(Math.max(popup.end, start + 1), durationInFrames);
    frameCursor = end;
    return [{ ...popup, start, end }];
  });
  return {
    videoUrl: baseVideoUrl,
    keywordPopups,
    durationInFrames,
    fontFamily: cfg.fontFamily,
    subtitleStylePreset: cfg.preset,
    subtitleTextEffect: cfg.effect,
    subtitleAccentColor: cfg.accentColor,
    subtitleShadow: cfg.shadow,
    subtitleOutline: cfg.outline,
    subtitleOutlineSize: cfg.outlineSize,
  };
}
