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

/** override สี/สีเน้นรายการ์ด (key = index ของการ์ด) */
export type V2CardOverrides = Record<number, { textColor?: string; accentColor?: string }>;

// ── การ์ด: รวม / แยก / จัดกลุ่มความยาว ─────────────────────────────────────

/** รวมการ์ด i เข้ากับใบถัดไป (ข้อความต่อกัน เวลาคลุมทั้งคู่) */
export function mergeCaptionWithNext(caps: V2Caption[], i: number): V2Caption[] {
  if (i < 0 || i >= caps.length - 1) return caps;
  const merged: V2Caption = {
    ...caps[i],
    text: `${caps[i].text.trimEnd()} ${caps[i + 1].text.trimStart()}`,
    endMs: caps[i + 1].endMs,
  };
  return [...caps.slice(0, i), merged, ...caps.slice(i + 2)];
}

/**
 * แยกการ์ด i เป็น 2 ใบ ณ ขอบคำใกล้กึ่งกลางข้อความ (กันตัดกลางคำทับศัพท์ด้วย
 * loanwordSpans ชุดเดียวกับ pipeline) เวลาแบ่งตามสัดส่วนตัวอักษร
 */
export function splitCaption(caps: V2Caption[], i: number, loanSpans: { start: number; end: number }[]): V2Caption[] {
  const c = caps[i];
  if (!c || c.text.trim().length < 4) return caps;
  const text = c.text;
  const mid = text.length / 2;
  // จุดตัด candidate: ขอบคำจาก Intl.Segmenter ที่ไม่อยู่ในช่วง loanword
  const candidates: number[] = [];
  try {
    const seg = new Intl.Segmenter("th", { granularity: "word" });
    let pos = 0;
    for (const s of seg.segment(text)) {
      pos = s.index;
      if (pos > 0 && pos < text.length && !loanSpans.some((sp) => pos > sp.start && pos < sp.end)) candidates.push(pos);
    }
  } catch { /* Segmenter ไม่มี → ใช้ช่องว่าง */ }
  for (let p = 1; p < text.length; p++) if (text[p] === " ") candidates.push(p);
  if (!candidates.length) return caps;
  const cut = candidates.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a));
  const leftText = text.slice(0, cut).trim();
  const rightText = text.slice(cut).trim();
  if (!leftText || !rightText) return caps;
  const cutMs = c.startMs + Math.round(((c.endMs - c.startMs) * cut) / text.length);
  const left: V2Caption = { ...c, text: leftText, endMs: cutMs };
  const right: V2Caption = { ...c, text: rightText, startMs: cutMs };
  return [...caps.slice(0, i), left, right, ...caps.slice(i + 1)];
}

/** จัดกลุ่มการ์ดจากชุดต้นฉบับทีละ n ใบ (ความยาวการ์ด 1/2/3 ประโยค) */
export function groupCaptionsBy(original: V2Caption[], n: number): V2Caption[] {
  if (n <= 1) return original.map((c) => ({ ...c }));
  const out: V2Caption[] = [];
  for (let i = 0; i < original.length; i += n) {
    const chunk = original.slice(i, i + n);
    out.push({
      ...chunk[0],
      text: chunk.map((c) => c.text.trim()).join(" "),
      endMs: chunk[chunk.length - 1].endMs,
    });
  }
  return out;
}

/** subtitleOverlayConfig — key ครบเท่ากับ burn ของ v1 (page.tsx burnSubtitlesCore) */
export function buildV2BurnConfig(
  baseVideoUrl: string,
  captions: V2Caption[],
  audioDurationMs: number,
  cfg: V2SubConfig,
  fps = 30,
  overrides: V2CardOverrides = {},
) {
  const lastEnd = captions.length ? captions[captions.length - 1].endMs : audioDurationMs;
  const durMs = Math.max(audioDurationMs, lastEnd, 1000);
  const durationInFrames = Math.max(Math.round((durMs / 1000) * fps), fps);
  const fontWeight = cfg.bold ? 900 : 400;
  let frameCursor = 0;
  const keywordPopups = captions.flatMap((c, idx) => {
    if (frameCursor >= durationInFrames) return [];
    const ov = overrides[idx] ?? {};
    const textColor = ov.textColor ?? cfg.textColor;
    const accentColor = ov.accentColor ?? cfg.accentColor;
    const popup = {
      text: c.text,
      start: Math.round((c.startMs / 1000) * fps),
      end: Math.round((c.endMs / 1000) * fps),
      tag: c.tag ?? "body",
      isHighlight: c.tag === "hook",
      color: cfg.preset === "karaoke-box" ? textColor : c.tag === "hook" ? accentColor : textColor,
      accentColor,
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
