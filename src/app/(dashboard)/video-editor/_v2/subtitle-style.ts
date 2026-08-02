/**
 * v2 subtitle styling (จอ 4b) — ใช้ preset/effect/font ชุดเดียวกับ v1 (import จาก
 * _components/constants — ห้าม hardcode ซ้ำ) + โปรไฟล์ด่วน 4 แบบตามดีไซน์
 * + ตัวประกอบ burn config ที่ mirror payload ของ v1 ทุก key
 */

import type { VideoJobPreviewData } from "@/lib/mcp/video-job";
import {
  normalizeLogoOverlayConfig,
  type LogoOverlayConfig,
} from "@/lib/logo-overlay";
import type { SubPreset, SubTextEffect } from "../_components/types";
import type { SubtitleCardLen } from "@/lib/editor-style-preset-contract";
import { PRESETS_DATA, EFFECTS_DATA, FONTS_LIST } from "../_components/constants";
import {
  DEFAULT_EDITOR_LAYER_VISIBILITY,
  normalizeEditorLayerVisibility,
  type EditorLayerVisibility,
} from "@/lib/editor-layer-visibility";

export { PRESETS_DATA, EFFECTS_DATA, FONTS_LIST };

/** โปรไฟล์ด่วน 4 แบบตามดีไซน์ 4b — ทางลัดไปยัง preset+effect จริง
 *  (เด้งไวรัล vs เงาเข้ม ต้องต่างกันทั้ง preset และ effect — QA 07-03) */
export const V2_QUICK_STYLES: { key: string; label: string; desc: string; preset: SubPreset; effect: SubTextEffect }[] = [
  { key: "viral", label: "เด้งไวรัล", desc: "ขอบดำ + เด้งเข้า", preset: "stroke", effect: "bounce" },
  { key: "shadow", label: "เงาเข้ม", desc: "Shadow นุ่ม อ่านง่าย", preset: "shadow", effect: "fade" },
  { key: "outline", label: "ขอบหนา", desc: "Outline คมชัด", preset: "sharp-outline", effect: "quick" },
  { key: "clean", label: "มินิมอล", desc: "กล่องเรียบ Clean", preset: "box-rounded", effect: "fade" },
];

// กฎล็อกเดียวกับ v1 (RightSettingsPanel.tsx:197/262-263 — คัดลอกไว้พร้อม pointer;
// ถ้าแก้ที่โน่นต้องแก้ที่นี่ด้วย)
export const LOCKED_EFFECT_PRESETS: SubPreset[] = ["classic-yellow", "hormozi", "beast", "neon-green", "neon-red", "neon-blue", "pastel", "retro", "box-white", "box-yellow", "news"];
export const LOCKED_COLOR_PRESETS: string[] = ["classic-yellow", "hormozi", "beast", "neon-green", "neon-red", "neon-blue", "pastel", "retro", "box-white", "box-yellow", "news"];
export const LOCKED_ACCENT_PRESETS: string[] = ["neon-green", "neon-red", "neon-blue", "pastel", "classic-yellow", "hormozi", "beast", "box-white", "box-yellow", "retro", "news", "karaoke-box"];

export const EDITABLE_EFFECT_PRESETS_DATA = PRESETS_DATA.filter((p) => !LOCKED_EFFECT_PRESETS.includes(p.value));
export const BUILT_IN_EFFECT_PRESETS_DATA = PRESETS_DATA.filter((p) => LOCKED_EFFECT_PRESETS.includes(p.value));

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

function isThaiCharacter(ch: string): boolean {
  return /[฀-๿]/.test(ch);
}

function joinCaptionText(left: string, right: string): string {
  const trimmedLeft = left.trimEnd();
  const trimmedRight = right.trimStart();
  if (!trimmedLeft) return trimmedRight;
  if (!trimmedRight) return trimmedLeft;
  const joinsThaiWord = isThaiCharacter(trimmedLeft[trimmedLeft.length - 1])
    && isThaiCharacter(trimmedRight[0]);
  return joinsThaiWord ? `${trimmedLeft}${trimmedRight}` : `${trimmedLeft} ${trimmedRight}`;
}

/** รวมการ์ด i เข้ากับใบถัดไป (ข้อความต่อกัน เวลาคลุมทั้งคู่) */
export function mergeCaptionWithNext(caps: V2Caption[], i: number): V2Caption[] {
  if (i < 0 || i >= caps.length - 1) return caps;
  const merged: V2Caption = {
    ...caps[i],
    text: joinCaptionText(caps[i].text, caps[i + 1].text),
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

/** ความยาวการ์ดแบบเดียวกับ v1 (page.tsx splitMode): 1 ประโยค หรือซับสั้นแบบ TikTok ≤N คำ */
export type V2CardLen = SubtitleCardLen;

export const V2_CARD_LEN_OPTIONS: { value: V2CardLen; label: string }[] = [
  { value: "sentence", label: "1 ประโยค" },
  { value: "4", label: "≤4 คำ" },
  { value: "3", label: "≤3 คำ" },
  { value: "2", label: "≤2 คำ" },
  { value: "1", label: "1 คำ" },
];

type V2TimedWord = { word: string; startMs: number; endMs: number; startChar: number; endChar: number };

// A gap (in fullText, between two consecutive words) that contains a line break or a
// sentence-final punctuation mark is a HARD card boundary — never pair words across it.
// LOCKSTEP with the server copy in src/lib/mcp/orchestrator-steps.ts
// (SENTENCE_BOUNDARY_RE / cardsByWordCount) — แก้ที่นึงต้องแก้อีกที่.
const SENTENCE_BOUNDARY_RE = /[\n,.!?…ฯ;:，；：]/;

// LOCKSTEP with src/lib/mcp/orchestrator-steps.ts. Thai word segmentation is
// much finer than what a viewer perceives as a phrase, so permit a bounded
// N+1 (or mode-2 N+2 closing auxiliary) rather than stranding a function word.
const THAI_BINDS_NEXT = new Set([
  "ไม่", "ได้", "จะ", "กำลัง", "ต้อง", "ควร", "อยาก", "ให้", "ใน", "จาก",
  "ของ", "กับ", "เพื่อ", "โดย", "เพราะ", "ถ้า", "เมื่อ", "คือ", "เป็น", "อย่าง", "ทุก",
  "ช่วง", "ซับ", "นำ", "งาน",
]);
const THAI_BINDS_PREVIOUS = new Set([
  "เดียว", "แล้ว", "อยู่", "ไว้", "มาก", "ขึ้น", "ลง", "ก่อน", "หลัง", "ทันที", "เสมอ", "ได้",
]);
const THAI_FINAL_CLOSING_TOKENS = new Set(["ได้"]);

function completesNaturalThaiPhrase(previous: string, current: string): boolean {
  return THAI_BINDS_NEXT.has(previous) || THAI_BINDS_PREVIOUS.has(current);
}

function tagCards(cards: V2Caption[]): V2Caption[] {
  return cards.map((c, i) => ({ ...c, tag: i === 0 ? "hook" : i === cards.length - 1 ? "cta" : "body" }));
}

function segmentWords(text: string): string[] {
  try {
    const seg = new Intl.Segmenter("th", { granularity: "word" });
    return Array.from(seg.segment(text)).map((s) => s.segment).filter((w) => w.trim().length > 0);
  } catch {
    return text.split(/\s+/).filter(Boolean);
  }
}

/**
 * จัดกลุ่มการ์ดใหม่ตามความยาว — semantics เดียวกับ v1:
 * - "sentence" → ชุดต้นฉบับจาก pipeline
 * - "1"–"4"  → การ์ด ≤N คำ: มี `words` (word timeline จาก TTS ใน preview payload)
 *   → ตัดด้วย timing เป๊ะ, text slice จาก fullText (สูตรเดียวกับ orchestrator-steps.ts
 *   cardsByWordCount — คัดลอกไว้เพราะไฟล์นั้นอยู่ฝั่ง server; แก้ที่โน่นต้องแก้ที่นี่ด้วย);
 *   ไม่มี words (งานเก่า/cutaway) → แบ่งตามสัดส่วนตัวอักษรรายการ์ด (fallback เดียวกับ v1)
 */
export function regroupCaptions(
  original: V2Caption[],
  len: V2CardLen,
  words?: V2TimedWord[] | null,
  fullText?: string | null,
): V2Caption[] {
  if (len === "sentence") return original.map((c) => ({ ...c }));
  const n = parseInt(len, 10);
  if (words?.length && fullText) {
    const ft = fullText;
    const out: V2Caption[] = [];
    let grp: V2TimedWord[] = [];
    const flush = () => {
      if (!grp.length) return;
      // FIX A: collapse any interior whitespace/newline sliced into the card (a script
      // line break) to a single space so a card never stacks two lines.
      const text = ft.slice(grp[0].startChar, grp[grp.length - 1].endChar).replace(/\s+/g, " ").trim();
      if (text) out.push({ text, startMs: grp[0].startMs, endMs: grp[grp.length - 1].endMs, tag: "body" });
      grp = [];
    };
    for (let i = 0; i < words.length; i++) {
      if (grp.length > 0) {
        // FIX B: never cross a sentence/line boundary (gap between words in fullText).
        const hardBoundary = SENTENCE_BOUNDARY_RE.test(
          ft.slice(grp[grp.length - 1].endChar, words[i].startChar),
        );
        if (hardBoundary) {
          flush();
        } else if (grp.length >= n) {
          const allowOneNaturalToken = n <= 3 && grp.length === n
            && completesNaturalThaiPhrase(grp[grp.length - 1].word, words[i].word);
          const allowFinalClosingToken = n <= 2 && grp.length === n + 1
            && THAI_FINAL_CLOSING_TOKENS.has(words[i].word);
          if (!allowOneNaturalToken && !allowFinalClosingToken) flush();
        }
      }
      grp.push(words[i]);
    }
    flush();
    return tagCards(out);
  }
  // fallback: interpolate เวลาในการ์ดเดิมตามสัดส่วนคำ (v1 page.tsx:3546-3561)
  const out: V2Caption[] = [];
  for (const cap of original) {
    const ws = segmentWords(cap.text.trim());
    if (!ws.length) continue;
    const dur = cap.endMs - cap.startMs;
    for (let i = 0; i < ws.length; i += n) {
      const chunk = ws.slice(i, i + n);
      const s = cap.startMs + (i / ws.length) * dur;
      const e = cap.startMs + (Math.min(i + n, ws.length) / ws.length) * dur;
      out.push({ text: joinThaiWords(chunk), startMs: Math.round(s), endMs: Math.round(e), tag: "body" });
    }
  }
  return tagCards(out);
}

/** ต่อคำไทยไม่แทรกช่องว่าง แทรกเฉพาะรอยต่อที่มีละติน/ตัวเลข (เหมือน joinWords ของ v1) */
function joinThaiWords(ws: string[]): string {
  let out = "";
  for (const w of ws) {
    if (!out) { out = w; continue; }
    const noSpace = isThaiCharacter(out[out.length - 1]) && isThaiCharacter(w[0]);
    out += noSpace ? w : ` ${w}`;
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
  logoOverlay?: LogoOverlayConfig,
  layerVisibility: EditorLayerVisibility = DEFAULT_EDITOR_LAYER_VISIBILITY,
) {
  const lastEnd = captions.length ? captions[captions.length - 1].endMs : audioDurationMs;
  const durMs = Math.max(audioDurationMs, lastEnd, 1000);
  const durationInFrames = Math.max(Math.round((durMs / 1000) * fps), fps);
  const fontWeight = cfg.bold ? 900 : 400;
  let frameCursor = 0;
  const layers = normalizeEditorLayerVisibility(layerVisibility);
  const keywordPopups = layers.subtitles ? captions.flatMap((c, idx) => {
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
  }) : [];
  const normalizedLogo = normalizeLogoOverlayConfig(logoOverlay);
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
    ...(normalizedLogo?.enabled ? { logoOverlay: normalizedLogo } : {}),
  };
}
