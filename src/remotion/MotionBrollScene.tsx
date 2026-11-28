import React, { useLayoutEffect, useRef } from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { cardCutBoundaries } from "../lib/tts-timing";
import {
  DEFAULT_THEME_BRAND_CI,
  motionTemplateEntry,
  normalizeMotionBrandCi,
  normalizeMotionSceneProps,
  trimPhraseAtWordBoundary,
  type CueBoardStyle,
  type MotionTemplateConfig,
  type MotionTemplateId,
} from "../lib/motion-broll-catalog";

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function easeOutBack(x: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const t = clamp01(x);
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function easeOutCubic(x: number): number {
  const t = clamp01(x);
  return 1 - Math.pow(1 - t, 3);
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = (hex || "").trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return `rgba(56, 189, 248, ${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const THAI_SCRIPT_RE = /[\u0E00-\u0E7F]/u;

function cleanDisplayString(raw: string): string {
  return (raw || "")
    .replace(/[\u2060\u200B\uFEFF]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Optically calibrates font weight on 2D Canvas so Thai vowels and loop counters stay crisp
 * and open (600–700 instead of 800–900 Black which smudges Thai tone marks).
 */
function opticalCanvasWeight(requestedWeight: number, text: string): number {
  if (!THAI_SCRIPT_RE.test(text)) return requestedWeight;
  if (requestedWeight >= 800) return 700;
  if (requestedWeight >= 700) return 600;
  return requestedWeight;
}

/**
 * Draws a single line of Thai/English text, scaling font size smoothly down to `minSize`
 * when needed instead of chopping Thai words mid-syllable or accordion-squishing glyphs.
 */
function drawFittedText(
  ctx: CanvasRenderingContext2D,
  rawText: string,
  x: number,
  y: number,
  maxWidth: number,
  baseSize: number,
  minSize: number,
  weight: number,
  fontStack: string,
  align: CanvasTextAlign = "center",
  color?: string,
): { width: number; fontSize: number } {
  const text = cleanDisplayString(rawText);
  if (!text) return { width: 0, fontSize: baseSize };
  const w = opticalCanvasWeight(weight, text);
  let size = baseSize;
  ctx.font = `${w} ${size}px ${fontStack}`;
  let measured = ctx.measureText(text).width;
  if (measured > maxWidth && measured > 0) {
    size = Math.max(minSize, Math.floor(baseSize * (maxWidth / measured)));
    ctx.font = `${w} ${size}px ${fontStack}`;
    measured = ctx.measureText(text).width;
  }
  ctx.textAlign = align;
  if (color) ctx.fillStyle = color;
  if (measured > maxWidth * 1.04) {
    ctx.fillText(text, x, y, maxWidth);
    return { width: maxWidth, fontSize: size };
  }
  ctx.fillText(text, x, y);
  return { width: measured, fontSize: size };
}

/**
 * Splits Thai/English text onto at most `maxLines` balanced word-boundary lines that fit
 * `maxWidth`, then draws them cleanly with proper Thai vertical spacing.
 */
function wrapCanvasTextLines(
  ctx: CanvasRenderingContext2D,
  rawText: string,
  maxWidth: number,
  fontSize: number,
  weight: number,
  fontStack: string,
  maxLines = 2,
): { lines: string[]; fontSize: number; weight: number } {
  const text = cleanDisplayString(rawText);
  const w = opticalCanvasWeight(weight, text);
  if (!text) return { lines: [], fontSize, weight: w };

  const tryWrapAtSize = (sz: number): string[] => {
    ctx.font = `${w} ${sz}px ${fontStack}`;
    if (ctx.measureText(text).width <= maxWidth || maxLines <= 1) {
      return [text];
    }
    const cuts = cardCutBoundaries(text);
    if (cuts.length === 0) return [text];

    if (maxLines === 2) {
      // Pick the most balanced cut where line 1 fits maxWidth (preferring both <= maxWidth)
      const valid = cuts.filter((c) => {
        const l1 = text.slice(0, c).trim();
        const l2 = text.slice(c).trim();
        return l1.length > 0 && l2.length > 0 && ctx.measureText(l1).width <= maxWidth && ctx.measureText(l2).width <= maxWidth;
      });
      const pool = valid.length > 0 ? valid : cuts;
      let bestCut = pool[0]!;
      let bestDiff = Infinity;
      for (const c of pool) {
        const w1 = ctx.measureText(text.slice(0, c).trim()).width;
        const w2 = ctx.measureText(text.slice(c).trim()).width;
        const diff = Math.abs(w1 - w2);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestCut = c;
        }
      }
      const l1 = text.slice(0, bestCut).trim();
      const l2 = text.slice(bestCut).trim();
      return l1 && l2 ? [l1, l2] : [text];
    }

    const edges = [0, ...cuts, text.length];
    const segments: string[] = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const seg = text.slice(edges[i], edges[i + 1]);
      if (seg) segments.push(seg);
    }
    const lines: string[] = [];
    let current = "";
    for (const seg of segments) {
      const candidate = (current + seg).trim();
      if (current && ctx.measureText(candidate).width > maxWidth && lines.length < maxLines - 1) {
        lines.push(current.trim());
        current = seg.trimStart();
      } else {
        current += seg;
      }
    }
    if (current.trim()) lines.push(current.trim());
    return lines;
  };

  let sz = fontSize;
  let lines = tryWrapAtSize(sz);
  const minSz = Math.max(13, Math.floor(fontSize * 0.74));
  while (
    sz > minSz &&
    lines.some((line) => {
      ctx.font = `${w} ${sz}px ${fontStack}`;
      return ctx.measureText(line).width > maxWidth;
    })
  ) {
    sz -= 1;
    lines = tryWrapAtSize(sz);
  }
  return { lines, fontSize: sz, weight: w };
}

function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  rawText: string,
  x: number,
  y: number,
  maxWidth: number,
  baseSize: number,
  weight: number,
  fontStack: string,
  align: CanvasTextAlign = "left",
  color = "#FFFFFF",
  maxLines = 2,
  lineHeightMultiplier = 1.38,
): number {
  const { lines, fontSize, weight: w } = wrapCanvasTextLines(
    ctx,
    rawText,
    maxWidth,
    baseSize,
    weight,
    fontStack,
    maxLines,
  );
  if (lines.length === 0) return 0;
  ctx.font = `${w} ${fontSize}px ${fontStack}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  const lineH = Math.round(fontSize * lineHeightMultiplier);
  const startY = y - ((lines.length - 1) * lineH) / 2;
  lines.forEach((line, idx) => {
    const measured = ctx.measureText(line).width;
    const ly = startY + idx * lineH;
    if (measured > maxWidth * 1.04) {
      ctx.fillText(line, x, ly, maxWidth);
    } else {
      ctx.fillText(line, x, ly);
    }
  });
  return lines.length * lineH;
}

const STACK_PILL_PALETTE = [
  "#F8FAFC",
  "#A3E635",
  "#38BDF8",
  "#FACC15",
  "#F472B6",
  "#C084FC",
  "#FB923C",
  "#34D399",
  "#60A5FA",
] as const;

/**
 * Pure 2D Canvas renderer for a Motion B-Roll scene at normalized `progress` (0..1).
 * Shared by Remotion's `<MotionBrollScene />` (1080×1920) and the interactive Studio Editor
 * preview so both surfaces render pixel-identically.
 */
export function paintMotionBrollCanvas(
  canvas: HTMLCanvasElement | null,
  config: MotionTemplateConfig,
  progress: number,
  options?: { suppressTopHeader?: boolean },
) {
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  const s = W / 540; // Base coordinate space = 540x960 (scales cleanly to 1080x1920)
  const p = clamp01(progress);
  const suppressTopHeader = options?.suppressTopHeader === true;
  const topShift = suppressTopHeader ? 78 : 0;

  const entry = motionTemplateEntry(config.templateId);
  const brand = normalizeMotionBrandCi(config.brandCi, config.themeId);
  const props = normalizeMotionSceneProps(config, config.templateId);
  const font = `'${brand.fontFamily}', 'Kanit', 'Noto Sans Thai', sans-serif`;
  const monoFont = `'JetBrains Mono', 'SFMono-Regular', 'Menlo', monospace, ${font}`;

  ctx.save();
  ctx.clearRect(0, 0, W, H);
  ctx.scale(s, s);

  const bw = 540;
  const bh = 960;
  // Subtle continuous ambient camera drift across p ∈ [0, 1] so scenes stay alive
  const camScale = 1 + 0.024 * p;
  const camDriftX = Math.sin(p * Math.PI * 1.5) * 3;
  const camDriftY = -4 * Math.sin(p * Math.PI);
  ctx.translate(bw / 2 + camDriftX, bh / 2 + camDriftY);
  ctx.scale(camScale, camScale);
  ctx.translate(-bw / 2, -bh / 2);

  // 1. Background layer
  const bgVariant = props.backgroundVariant ?? entry.defaultBackgroundVariant;
  if (bgVariant === "sky-desert") {
    const skyGrad = ctx.createLinearGradient(0, 0, 0, bh * 0.64);
    skyGrad.addColorStop(0, "#4CB5F5");
    skyGrad.addColorStop(1, "#79D0FA");
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, bw, bh * 0.64);

    // Rotating Sun with crisp rays
    ctx.save();
    ctx.translate(bw * 0.82, bh * 0.18 + topShift * 0.4);
    ctx.rotate(p * Math.PI * 0.45);
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 40, Math.sin(a) * 40);
      ctx.lineTo(Math.cos(a) * 54, Math.sin(a) * 54);
      ctx.stroke();
    }
    ctx.fillStyle = "#FACC15";
    ctx.beginPath();
    ctx.arc(0, 0, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Floating Cloud
    const cloudX = 92 + Math.sin(p * Math.PI * 2) * 14;
    const cloudY = 182 + topShift * 0.3;
    ctx.save();
    ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
    ctx.beginPath();
    ctx.arc(cloudX, cloudY, 22, 0, Math.PI * 2);
    ctx.arc(cloudX + 24, cloudY - 8, 28, 0, Math.PI * 2);
    ctx.arc(cloudX + 50, cloudY, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Layered Sand Dunes
    ctx.fillStyle = "#E7BC91";
    ctx.beginPath();
    ctx.moveTo(0, bh * 0.61);
    ctx.quadraticCurveTo(bw * 0.48, bh * 0.585, bw, bh * 0.62);
    ctx.lineTo(bw, bh);
    ctx.lineTo(0, bh);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 3.6;
    ctx.stroke();

    ctx.fillStyle = "#C69C72";
    ctx.beginPath();
    ctx.moveTo(0, bh * 0.69);
    ctx.quadraticCurveTo(bw * 0.42, bh * 0.675, bw, bh * 0.705);
    ctx.lineTo(bw, bh);
    ctx.lineTo(0, bh);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#8B5E34";
    ctx.fillRect(0, bh * 0.76, bw, bh * 0.24);
    ctx.beginPath();
    ctx.moveTo(0, bh * 0.76);
    ctx.lineTo(bw, bh * 0.76);
    ctx.stroke();
  } else if (bgVariant === "dark-grid") {
    const bgGrad = ctx.createLinearGradient(0, 0, 0, bh);
    bgGrad.addColorStop(0, "#080D1A");
    bgGrad.addColorStop(0.62, brand.backgroundColor || "#0F172A");
    bgGrad.addColorStop(1, "#16141B");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, bw, bh);

    ctx.fillStyle = "rgba(148, 163, 184, 0.10)";
    for (let y = 28; y < bh * 0.76; y += 34) {
      for (let x = 28; x < bw; x += 34) {
        ctx.beginPath();
        ctx.arc(x, y, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const glow = ctx.createRadialGradient(bw * 0.52, bh * 0.4, 18, bw * 0.52, bh * 0.4, 340);
    glow.addColorStop(0, hexToRgba(brand.primaryColor, 0.24));
    glow.addColorStop(0.55, hexToRgba(brand.primaryColor, 0.08));
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, bw, bh);
  } else {
    // cream-dots (Doodle editorial dot-grid paper)
    ctx.fillStyle = brand.backgroundColor || "#FDF8EC";
    ctx.fillRect(0, 0, bw, bh);
    ctx.fillStyle = "rgba(180, 165, 140, 0.32)";
    for (let y = 28; y < bh; y += 38) {
      for (let x = 28; x < bw; x += 38) {
        ctx.beginPath();
        ctx.arc(x, y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Helper: Soft rounded card/pill with clean ink outline + subtle shadow
  const drawCard = (
    x: number,
    y: number,
    w: number,
    h: number,
    fill: string,
    radius = 16,
    strokeColor = "#111827",
    lineWidth = 3.6,
  ) => {
    ctx.save();
    ctx.fillStyle = "rgba(17, 24, 39, 0.14)";
    ctx.beginPath();
    ctx.roundRect(x + 4, y + 6, w, h, radius);
    ctx.fill();

    ctx.fillStyle = fill;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  };

  // Helper: Expressive Stickman / Mascot character (Ref 1 & Ref 2 signature presenter)
  const drawStickman = (
    x: number,
    y: number,
    scale: number,
    walkPhase: number,
    surprised: boolean,
    pointTarget: "none" | "left" | "right" | "up" = "none",
  ) => {
    const mascot = props.mascot ?? config.mascot ?? "stickman-scarf";
    const headBob = Math.sin(p * Math.PI * 6) * 2.5;
    const headTilt = Math.sin(p * Math.PI * 3) * 0.04;
    const isBlinking = (p > 0.36 && p < 0.40) || (p > 0.78 && p < 0.82);

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 4.6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const swing = Math.sin(walkPhase * Math.PI * 4) * 15;

    ctx.fillStyle = "rgba(17, 24, 39, 0.16)";
    ctx.beginPath();
    ctx.ellipse(2, 128, 34, 7, 0, 0, Math.PI * 2);
    ctx.fill();

    // Legs
    ctx.beginPath();
    ctx.moveTo(-10, 58);
    ctx.lineTo(-14 + swing, 124);
    ctx.lineTo(-2 + swing, 127);
    ctx.moveTo(10, 58);
    ctx.lineTo(14 - swing, 124);
    ctx.lineTo(26 - swing, 127);
    ctx.stroke();

    // Torso
    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath();
    ctx.roundRect(-22, -6, 44, 66, 12);
    ctx.fill();
    ctx.stroke();

    // Left Arm
    ctx.beginPath();
    ctx.moveTo(-22, 8);
    if (pointTarget === "left") {
      ctx.lineTo(-56, -12);
    } else {
      ctx.lineTo(-36 - swing * 0.4, 50);
    }
    ctx.stroke();

    // Right Arm
    ctx.beginPath();
    ctx.moveTo(22, 8);
    if (pointTarget === "right") {
      ctx.lineTo(58, -14);
    } else if (pointTarget === "up") {
      ctx.lineTo(46, -42);
    } else {
      ctx.lineTo(36 + swing * 0.4, 50);
    }
    ctx.stroke();

    // Brand CI Scarf / Collar
    ctx.fillStyle = brand.primaryColor || "#EF4444";
    ctx.beginPath();
    ctx.roundRect(-26, -12, 52, 16, 6);
    ctx.fill();
    ctx.stroke();
    if (mascot === "stickman-scarf") {
      const scarfWave = Math.sin(p * Math.PI * 4) * 4;
      ctx.beginPath();
      ctx.moveTo(8, 2);
      ctx.lineTo(22 + scarfWave, 34);
      ctx.lineTo(7 + scarfWave * 0.5, 36);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    ctx.save();
    ctx.translate(0, headBob);
    ctx.rotate(headTilt);

    if (mascot === "ai-bot") {
      ctx.beginPath();
      ctx.moveTo(0, -124);
      ctx.lineTo(0, -146);
      ctx.stroke();
      ctx.fillStyle = brand.accentColor || "#FACC15";
      ctx.beginPath();
      ctx.arc(0, -152, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#FFFFFF";
      ctx.beginPath();
      ctx.roundRect(-56, -124, 112, 98, 22);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#0F172A";
      ctx.beginPath();
      ctx.roundRect(-42, -104, 84, 54, 12);
      ctx.fill();

      ctx.fillStyle = brand.primaryColor || "#38BDF8";
      if (isBlinking) {
        ctx.fillRect(-24, -79, 16, 4);
        ctx.fillRect(8, -79, 16, 4);
      } else {
        ctx.beginPath();
        ctx.arc(-16, -78, 7, 0, Math.PI * 2);
        ctx.arc(16, -78, 7, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      ctx.fillStyle = "#FFFFFF";
      ctx.beginPath();
      ctx.arc(0, -68, 56, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.clip();
      ctx.fillStyle = "rgba(17, 24, 39, 0.08)";
      ctx.beginPath();
      ctx.arc(10, -68, 56, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(0, -68, 56, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = "#111827";
      if (isBlinking) {
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(-18, -76);
        ctx.lineTo(-6, -76);
        ctx.moveTo(12, -76);
        ctx.lineTo(24, -76);
        ctx.stroke();
        ctx.lineWidth = 4.6;
      } else {
        ctx.beginPath();
        ctx.arc(-12, -76, 4.5, 0, Math.PI * 2);
        ctx.arc(18, -76, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }

      if (mascot === "stickman-glasses") {
        ctx.strokeStyle = brand.primaryColor || "#111827";
        ctx.lineWidth = 3.8;
        ctx.beginPath();
        ctx.arc(-12, -76, 13, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(18, -76, 13, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(1, -76);
        ctx.lineTo(5, -76);
        ctx.stroke();
        ctx.strokeStyle = "#111827";
        ctx.lineWidth = 4.6;
      } else if (mascot === "stickman-cap") {
        ctx.fillStyle = brand.primaryColor || "#3B82F6";
        ctx.beginPath();
        ctx.arc(0, -88, 54, Math.PI, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.roundRect(-10, -94, 76, 14, 7);
        ctx.fill();
        ctx.stroke();
      }

      if (surprised) {
        ctx.beginPath();
        ctx.moveTo(-22, -92);
        ctx.lineTo(-4, -96);
        ctx.moveTo(8, -96);
        ctx.lineTo(26, -92);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(4, -52, 6.5, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = "#EF4444";
        ctx.lineWidth = 3.6;
        ctx.beginPath();
        ctx.moveTo(-78, -95);
        ctx.lineTo(-64, -104);
        ctx.lineTo(-70, -86);
        ctx.lineTo(-56, -92);
        ctx.moveTo(64, -92);
        ctx.lineTo(78, -104);
        ctx.lineTo(72, -86);
        ctx.lineTo(86, -95);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(4, -60, 15, 0.15 * Math.PI, 0.85 * Math.PI);
        ctx.stroke();
      }
    }
    ctx.restore();
    ctx.restore();
  };

  // ── THEME A: CUE STEP BOARD & HYPERFRAME KINETIC (Ref 2 Studio Presenter + Open Visual Stage) ──
  if (config.themeId === "cue-step-board" || config.themeId === "hyperframe-kinetic") {
    const boardStyle: CueBoardStyle =
      props.boardStyle ??
      (entry.archetypeId === "price-slash-cta"
        ? "comment-cta"
        : entry.archetypeId === "chart-vs-reality"
          ? "lufs-meter"
          : entry.archetypeId === "before-after-split"
            ? "pronounce-map"
            : "terminal-spec");

    const stageEnter = easeOutCubic(clamp01(p / 0.16));
    const stageTopY = suppressTopHeader ? -118 : -210;
    const stageHeight = suppressTopHeader ? 320 : 412;
    ctx.save();
    ctx.translate(bw / 2, suppressTopHeader ? 364 : 286);
    ctx.scale(0.94 + 0.06 * stageEnter, 0.94 + 0.06 * stageEnter);

    // Subtle open glass stage (delicate hairline instead of heavy thick rectangular box)
    const stageGrad = ctx.createLinearGradient(0, stageTopY, 0, 210);
    stageGrad.addColorStop(0, "rgba(15, 23, 42, 0.72)");
    stageGrad.addColorStop(1, "rgba(15, 23, 42, 0.32)");
    ctx.fillStyle = stageGrad;
    ctx.strokeStyle = hexToRgba(brand.primaryColor, 0.35);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(-232, stageTopY, 464, stageHeight, 28);
    ctx.fill();
    ctx.stroke();

    if (!suppressTopHeader) {
      // Minimal step indicator dots + tag
      const stepText = trimPhraseAtWordBoundary(props.headerText ?? "STEP 1/4", 18);
      ctx.fillStyle = hexToRgba(brand.primaryColor, 0.18);
      ctx.strokeStyle = hexToRgba(brand.primaryColor, 0.6);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.roundRect(-202, -184, 114, 28, 14);
      ctx.fill();
      ctx.stroke();
      drawFittedText(ctx, stepText, -145, -165, 96, 13.5, 11, 700, monoFont, "center", brand.primaryColor);

      const stepMatch = stepText.match(/(\d+)\s*\/\s*(\d+)/);
      const totalSegs = stepMatch ? Math.min(8, Math.max(3, parseInt(stepMatch[2]!, 10))) : 5;
      const activeSegs = stepMatch ? Math.min(totalSegs, Math.max(1, parseInt(stepMatch[1]!, 10))) : Math.ceil(p * totalSegs);
      for (let i = 0; i < totalSegs; i++) {
        ctx.fillStyle = i < activeSegs ? brand.primaryColor : "rgba(255,255,255,0.14)";
        ctx.beginPath();
        ctx.roundRect(-72 + i * 32, -173, 24, 6, 3);
        ctx.fill();
      }

      // Main Visual Title (hidden when HeadlineHookOverlay already leads at top of screen)
      drawFittedText(
        ctx,
        props.title ?? "สรุปประเด็นสำคัญ",
        0,
        -122,
        412,
        28,
        19,
        700,
        font,
        "center",
        "#F8FAFC",
      );
    }

    const items =
      props.items && props.items.length > 0
        ? props.items
        : ["สรุปประเด็นสำคัญ", "ขั้นตอนที่นำไปใช้ได้จริง", "ผลลัพธ์ที่ตรวจสอบได้"];

    if (boardStyle === "comment-cta") {
      // Interactive Floating Search / Comment Capsule with Live Typing
      const kw = cleanDisplayString(props.rightText ?? "สนใจ");
      const typedLen = Math.max(1, Math.floor(clamp01((p - 0.08) / 0.42) * kw.length));
      const shownKw = kw.slice(0, typedLen);

      ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
      ctx.strokeStyle = brand.primaryColor;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(-192, -52, 384, 78, 39);
      ctx.fill();
      ctx.stroke();

      const { width: kwW } = drawFittedText(
        ctx,
        `💬  พิมพ์ "${shownKw}"`,
        -156,
        -4,
        290,
        27,
        18,
        700,
        font,
        "left",
        "#0F172A",
      );

      if (Math.floor(p * 12) % 2 === 0) {
        ctx.fillStyle = brand.primaryColor;
        ctx.fillRect(Math.min(132, -152 + kwW + 4), -26, 3.5, 30);
      }

      // Send Circle Button
      ctx.fillStyle = brand.primaryColor;
      ctx.beginPath();
      ctx.arc(152, -13, 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#090D16";
      ctx.font = `700 20px ${font}`;
      ctx.textAlign = "center";
      ctx.fillText("➤", 154, -6);

      if (p > 0.28) {
        const bp = easeOutBack(clamp01((p - 0.28) / 0.18));
        ctx.save();
        ctx.translate(0, 92);
        ctx.scale(bp, bp);
        ctx.fillStyle = hexToRgba(brand.primaryColor, 0.2);
        ctx.strokeStyle = hexToRgba(brand.primaryColor, 0.65);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(-178, -24, 356, 48, 24);
        ctx.fill();
        ctx.stroke();
        drawFittedText(
          ctx,
          props.badgeText ?? "ส่งรายละเอียดให้ในแชตทันที",
          0,
          6,
          324,
          19,
          14,
          600,
          font,
          "center",
          "#F8FAFC",
        );
        ctx.restore();
      }
    } else if (boardStyle === "audio-waveform") {
      // Open Symmetrical Voice Spectrum + Floating Rhythm Nodes
      const totalBars = 48;
      const activeBars = Math.floor(clamp01((p - 0.04) / 0.65) * totalBars);
      for (let i = 0; i < totalBars; i++) {
        const bx = -188 + i * 8;
        const wave =
          (Math.sin(i * 0.58 + p * 8) * 0.45 + Math.cos(i * 1.15) * 0.35 + 0.38) *
          (i % 8 === 0 ? 20 : 58);
        const hBar = Math.max(6, Math.min(64, wave));
        ctx.fillStyle = i <= activeBars ? brand.primaryColor : "rgba(148,163,184,0.22)";
        ctx.beginPath();
        ctx.roundRect(bx, 2 - hBar, 4.5, hBar * 2, 2.2);
        ctx.fill();
      }

      // Clean floating pills below spectrum
      items.slice(0, 2).forEach((item, idx) => {
        const cx = idx === 0 ? -98 : 98;
        ctx.fillStyle = "rgba(30, 41, 59, 0.85)";
        ctx.strokeStyle = "rgba(255,255,255,0.14)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.roundRect(cx - 90, 98, 180, 42, 21);
        ctx.fill();
        ctx.stroke();
        drawFittedText(ctx, item, cx, 125, 160, 16, 12, 600, font, "center", "#E2E8F0");
      });
    } else if (boardStyle === "lufs-meter") {
      // Visual Radial Speedometer / Efficiency Arc + Clean Comparison Bars
      const sweep = easeOutCubic(clamp01(p / 0.55));
      ctx.save();
      ctx.translate(-112, 22);
      ctx.lineWidth = 12;
      ctx.lineCap = "round";
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.beginPath();
      ctx.arc(0, 0, 68, Math.PI * 0.75, Math.PI * 2.25);
      ctx.stroke();

      ctx.strokeStyle = brand.primaryColor;
      ctx.beginPath();
      ctx.arc(0, 0, 68, Math.PI * 0.75, Math.PI * (0.75 + 1.5 * sweep));
      ctx.stroke();

      drawFittedText(
        ctx,
        props.badgeText ?? "100%",
        0,
        8,
        104,
        24,
        15,
        700,
        font,
        "center",
        "#FFFFFF",
      );
      ctx.restore();

      // Right side clean progress bars
      items.slice(0, 3).forEach((item, idx) => {
        const y = -28 + idx * 54;
        const barP = easeOutCubic(clamp01((p - 0.08 - idx * 0.1) / 0.35));
        drawFittedText(ctx, item, -20, y - 8, 214, 17, 13, 600, font, "left", "#F1F5F9");
        ctx.fillStyle = "rgba(255,255,255,0.10)";
        ctx.beginPath();
        ctx.roundRect(-20, y + 4, 212, 10, 5);
        ctx.fill();
        ctx.fillStyle = idx === 0 ? brand.primaryColor : idx === 1 ? (brand.accentColor || "#38BDF8") : "#34D399";
        ctx.beginPath();
        ctx.roundRect(-20, y + 4, (204 - idx * 24) * barP, 10, 5);
        ctx.fill();
      });
    } else {
      // Connected Visual Step Nodes (① ──▶ ② ──▶ ③) instead of nested rectangular markdown boxes!
      const nodeCount = Math.min(3, Math.max(2, items.length));
      const startY = -46;
      const gapY = 78;

      // Vertical glowing spine connecting step circles
      const spineP = easeOutCubic(clamp01((p - 0.08) / 0.5));
      ctx.strokeStyle = hexToRgba(brand.primaryColor, 0.45);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-162, startY);
      ctx.lineTo(-162, startY + gapY * (nodeCount - 1) * spineP);
      ctx.stroke();

      items.slice(0, nodeCount).forEach((item, idx) => {
        const at = 0.06 + idx * 0.14;
        if (p < at) return;
        const np = easeOutBack(clamp01((p - at) / 0.18));
        const y = startY + idx * gapY;

        ctx.save();
        ctx.translate(0, y);
        ctx.scale(np, np);

        // Glowing numbered circle node
        ctx.fillStyle = idx === nodeCount - 1 ? brand.primaryColor : "#1E293B";
        ctx.strokeStyle = brand.primaryColor;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(-162, 0, 22, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = idx === nodeCount - 1 ? "#090D16" : "#F8FAFC";
        ctx.font = `700 16px ${monoFont}`;
        ctx.textAlign = "center";
        ctx.fillText(`0${idx + 1}`, -162, 6);

        // Clean frameless text with subtle bottom accent divider
        drawFittedText(ctx, item, -124, 7, 318, 21, 15, 600, font, "left", "#F8FAFC");

        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(-124, 24);
        ctx.lineTo(188, 24);
        ctx.stroke();
        ctx.restore();
      });
    }

    ctx.restore();

    // 2. Studio Desk + Lamp + Brand Mug + Presenter + Stacking Step Pills (Ref 2 signature)
    const deskTopY = 760;

    ctx.save();
    ctx.strokeStyle = "#64748B";
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(82, deskTopY);
    ctx.lineTo(64, 690);
    ctx.lineTo(95, 640);
    ctx.stroke();
    ctx.fillStyle = "#475569";
    ctx.beginPath();
    ctx.roundRect(62, deskTopY - 8, 44, 10, 5);
    ctx.fill();
    ctx.fillStyle = "#64748B";
    ctx.beginPath();
    ctx.arc(104, 642, 22, Math.PI * 0.85, Math.PI * 2.15);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.shadowColor = brand.primaryColor;
    ctx.shadowBlur = 14;
    drawStickman(
      bw / 2,
      718,
      0.86,
      p * 1.5,
      false,
      boardStyle === "comment-cta" ? "right" : p > 0.45 ? "up" : "none",
    );
    ctx.restore();

    const stackLabels = props.stackLabels ?? ["ไอเดีย", "บท", "เสียง", "โพสต์"];
    stackLabels.slice(0, 7).forEach((lbl, idx) => {
      const sy = deskTopY - 26 - idx * 28;
      const isTop = idx === stackLabels.length - 1;
      const pop = isTop ? easeOutBack(clamp01((p - 0.1) / 0.2)) : 1;
      const pillColor = isTop ? brand.primaryColor : STACK_PILL_PALETTE[idx % STACK_PILL_PALETTE.length]!;
      ctx.save();
      ctx.translate(454, sy);
      ctx.scale(pop, pop);
      ctx.fillStyle = pillColor;
      ctx.strokeStyle = "#0F172A";
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.roundRect(-52, -12, 104, 24, 8);
      ctx.fill();
      ctx.stroke();
      drawFittedText(ctx, lbl, 0, 5, 90, 13.5, 10, 600, font, "center", "#090D16");
      ctx.restore();
    });

    // Coffee Mug
    ctx.save();
    ctx.fillStyle = brand.primaryColor;
    ctx.strokeStyle = "#0F172A";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(122, deskTopY - 42, 36, 42, 6);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(122, deskTopY - 21, 10, Math.PI * 0.5, Math.PI * 1.5);
    ctx.stroke();
    ctx.restore();

    // Desk Surface
    ctx.fillStyle = "#4A3728";
    ctx.fillRect(0, deskTopY, bw, bh - deskTopY);
    ctx.fillStyle = "#5C4433";
    ctx.fillRect(0, deskTopY, bw, 14);
    ctx.strokeStyle = "#271C15";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, deskTopY);
    ctx.lineTo(bw, deskTopY);
    ctx.stroke();

    ctx.fillStyle = "#1E293B";
    ctx.strokeStyle = "#0F172A";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.roundRect(bw / 2 - 78, deskTopY - 14, 156, 20, 5);
    ctx.fill();
    ctx.stroke();
    for (let k = 0; k < 10; k++) {
      ctx.fillStyle = k === 4 ? brand.primaryColor : "#475569";
      ctx.fillRect(bw / 2 - 68 + k * 14, deskTopY - 9, 10, 8);
    }
  } else if (config.themeId === "paper-cutout-doc") {
    // ── THEME C: PAPER CUTOUT DOCUMENTARY (Tactile Editorial Collage + Marker Sweep) ──
    ctx.fillStyle = "#ECE4D5";
    ctx.fillRect(0, 0, bw, bh);

    // Subtle warm paper dot texture (no dense grid lines)
    ctx.fillStyle = "rgba(120, 108, 90, 0.16)";
    for (let y = 36; y < bh; y += 36) {
      for (let x = 36; x < bw; x += 36) {
        ctx.beginPath();
        ctx.arc(x, y, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const drawPaperClipping = (
      cx: number,
      cy: number,
      w: number,
      h: number,
      tiltRad: number,
      paperColor = "#FAF6EE",
      showTape = true,
    ) => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(tiltRad);

      ctx.fillStyle = "rgba(28, 25, 23, 0.18)";
      ctx.beginPath();
      ctx.roundRect(-w / 2 + 6, -h / 2 + 9, w, h, 6);
      ctx.fill();

      ctx.fillStyle = paperColor;
      ctx.strokeStyle = "rgba(41, 37, 36, 0.78)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-w / 2, -h / 2);
      ctx.lineTo(w / 2, -h / 2);
      ctx.lineTo(w / 2, h / 2 - 7);
      const zigSteps = 18;
      for (let i = zigSteps; i >= 0; i--) {
        const zx = -w / 2 + (w * i) / zigSteps;
        const zy = h / 2 - (i % 2 === 0 ? 7 : 0);
        ctx.lineTo(zx, zy);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      if (showTape) {
        ctx.save();
        ctx.translate(0, -h / 2 - 2);
        ctx.rotate(-0.035);
        ctx.fillStyle = "rgba(234, 215, 167, 0.85)";
        ctx.fillRect(-52, -11, 104, 22);
        ctx.restore();
      }
      ctx.restore();
    };

    if (!suppressTopHeader && props.headerText) {
      const headerTag = trimPhraseAtWordBoundary(props.headerText, 26);
      ctx.save();
      ctx.translate(bw / 2, 74);
      ctx.rotate(-0.012);
      ctx.fillStyle = "#1C1917";
      ctx.beginPath();
      ctx.roundRect(-165, -20, 330, 40, 8);
      ctx.fill();
      drawFittedText(ctx, headerTag, 0, 6, 300, 16, 12, 600, font, "center", "#FAF6EE");
      ctx.restore();
    }

    const items =
      props.items && props.items.length > 0
        ? props.items
        : ["คนดูตัดสินใน 3 วินาทีแรก", "เปิดคลิปช้าคนปัดทิ้งทันที", "ขึ้นภาพตรงเนื้อหาอัตโนมัติ"];

    if (config.templateId === "paper.evidence-dossier") {
      const p1 = easeOutBack(clamp01((p - 0.04) / 0.18));
      const p2 = easeOutBack(clamp01((p - 0.18) / 0.18));

      // Left Polaroid
      ctx.save();
      ctx.translate(158, 295 + topShift);
      ctx.scale(p1, p1);
      ctx.rotate(-0.05);
      drawPaperClipping(0, 0, 216, 244, 0, "#FFFFFF", false);
      ctx.fillStyle = "#1E293B";
      ctx.fillRect(-92, -104, 184, 138);
      ctx.strokeStyle = "#EF4444";
      ctx.lineWidth = 4.5;
      ctx.beginPath();
      ctx.moveTo(-72, -70);
      ctx.lineTo(-20, -48);
      ctx.lineTo(18, -12);
      ctx.lineTo(72, 20);
      ctx.stroke();
      drawFittedText(ctx, props.leftText ?? "วิธีเดิม", 0, 68, 188, 19, 14, 700, font, "center", "#1C1917");
      drawFittedText(ctx, items[0] ?? "ใช้เวลานาน", 0, 96, 188, 15.5, 12, 600, font, "center", "#DC2626");
      ctx.fillStyle = "#DC2626";
      ctx.beginPath();
      ctx.arc(0, -114, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Right Polaroid
      if (p > 0.16) {
        ctx.save();
        ctx.translate(382, 425 + topShift);
        ctx.scale(p2, p2);
        ctx.rotate(0.045);
        drawPaperClipping(0, 0, 216, 244, 0, "#FFFFFF", false);
        ctx.fillStyle = "#0F172A";
        ctx.fillRect(-92, -104, 184, 138);
        ctx.strokeStyle = brand.primaryColor;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(-72, 16);
        ctx.lineTo(-20, -24);
        ctx.lineTo(24, -42);
        ctx.lineTo(72, -78);
        ctx.stroke();
        drawFittedText(ctx, props.rightText ?? "แนวทางใหม่", 0, 68, 188, 19, 14, 700, font, "center", "#1C1917");
        drawFittedText(ctx, items[1] ?? "เห็นผลลัพธ์ไว", 0, 96, 188, 15.5, 12, 600, font, "center", "#15803D");
        ctx.fillStyle = "#DC2626";
        ctx.beginPath();
        ctx.arc(0, -114, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // Red thread connecting pushpins
      if (p > 0.28) {
        const sp = clamp01((p - 0.28) / 0.22);
        ctx.save();
        ctx.strokeStyle = "#DC2626";
        ctx.lineWidth = 3.2;
        ctx.setLineDash([7, 4]);
        ctx.beginPath();
        ctx.moveTo(158, 181 + topShift);
        ctx.quadraticCurveTo(270, 265 + topShift, 158 + (382 - 158) * sp, 181 + topShift + 130 * sp);
        ctx.stroke();
        ctx.restore();
      }
    } else if (config.templateId === "paper.quote-stamp") {
      const clipEnter = easeOutBack(clamp01(p / 0.18));
      ctx.save();
      ctx.translate(bw / 2, 345 + topShift);
      ctx.scale(clipEnter, clipEnter);
      drawPaperClipping(0, 0, 456, 330, -0.016, "#FAF6EE", true);

      ctx.fillStyle = "rgba(220, 38, 38, 0.15)";
      ctx.font = `900 108px Georgia, serif`;
      ctx.textAlign = "left";
      ctx.fillText("“", -200, -48);

      const hlSweep = easeOutCubic(clamp01((p - 0.12) / 0.32));
      ctx.fillStyle = "rgba(250, 204, 21, 0.72)";
      ctx.beginPath();
      ctx.roundRect(-190, -82, 380 * hlSweep, 44, 6);
      ctx.fill();

      drawFittedText(ctx, props.title ?? "หัวใจสำคัญของคลิปสั้น", 0, -52, 376, 26, 18, 700, font, "center", "#1C1917");

      items.slice(0, 2).forEach((line, idx) => {
        drawFittedText(ctx, `•  ${line}`, 0, 14 + idx * 46, 390, 20, 15, 600, font, "center", "#292524");
      });
      ctx.restore();

      if (p > 0.34) {
        const rawStamp = clamp01((p - 0.34) / 0.14);
        const stampScale = rawStamp < 1 ? 1.9 - 0.9 * rawStamp : 1.0;
        ctx.save();
        ctx.translate(bw / 2 + 68, 535 + topShift * 0.5);
        ctx.rotate(-0.14);
        ctx.scale(stampScale, stampScale);
        ctx.fillStyle = "rgba(254, 242, 242, 0.94)";
        ctx.strokeStyle = "#DC2626";
        ctx.lineWidth = 4.5;
        ctx.beginPath();
        ctx.roundRect(-138, -36, 276, 72, 12);
        ctx.fill();
        ctx.stroke();
        drawFittedText(ctx, props.badgeText ?? "นำไปใช้ได้ทันที", 0, 8, 246, 22, 15, 700, font, "center", "#DC2626");
        ctx.restore();
      }
    } else {
      // paper.headline-highlighter: Clean Editorial Cutout Strips + Marker Sweep (zero fake English newspaper boilerplate)
      const clipEnter = easeOutBack(clamp01(p / 0.16));
      ctx.save();
      ctx.translate(bw / 2, 360 + topShift);
      ctx.scale(clipEnter, clipEnter);
      drawPaperClipping(0, 0, 462, 390, -0.015, "#FAF6EE", true);

      // Headline marker sweep
      const sweep1 = easeOutCubic(clamp01((p - 0.1) / 0.28));
      ctx.fillStyle = "rgba(250, 204, 21, 0.82)";
      ctx.beginPath();
      ctx.roundRect(-198, -138, 396 * sweep1, 52, 8);
      ctx.fill();

      drawFittedText(
        ctx,
        props.title ?? "ทำไมคนเลื่อนผ่านใน 3 วิแรก?",
        0,
        -104,
        384,
        26,
        18,
        700,
        font,
        "center",
        "#1C1917",
      );

      items.slice(0, 3).forEach((item, idx) => {
        const at = 0.2 + idx * 0.14;
        if (p < at) return;
        const rowSweep = easeOutCubic(clamp01((p - at) / 0.22));
        const y = -22 + idx * 72;

        ctx.fillStyle = idx === 1 ? hexToRgba(brand.primaryColor, 0.24) : "rgba(254, 240, 138, 0.72)";
        ctx.beginPath();
        ctx.roundRect(-192, y - 20, 384 * rowSweep, 42, 8);
        ctx.fill();

        drawFittedText(
          ctx,
          `${idx + 1}.  ${item}`,
          -176,
          y + 8,
          352,
          20,
          14,
          600,
          font,
          "left",
          "#1C1917",
        );

        if (idx === 2 && rowSweep > 0.5) {
          ctx.strokeStyle = "#DC2626";
          ctx.lineWidth = 3.2;
          ctx.beginPath();
          ctx.moveTo(-176, y + 20);
          ctx.quadraticCurveTo(0, y + 26, -176 + 340 * rowSweep, y + 18);
          ctx.stroke();
        }
      });
      ctx.restore();
    }
  } else if (config.themeId === "social-chat-sim") {
    // ── THEME D: SOCIAL CHAT CONVERSATION (Frameless Organic Floating Bubbles, Readable Medium Thai) ──
    const bgGrad = ctx.createLinearGradient(0, 0, 0, bh);
    bgGrad.addColorStop(0, "#080C16");
    bgGrad.addColorStop(0.5, "#0F172A");
    bgGrad.addColorStop(1, "#080C16");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, bw, bh);

    const orb1 = ctx.createRadialGradient(110, 230, 10, 110, 230, 280);
    orb1.addColorStop(0, hexToRgba(brand.primaryColor, 0.28));
    orb1.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = orb1;
    ctx.fillRect(0, 0, bw, bh);

    const orb2 = ctx.createRadialGradient(430, 500, 10, 430, 500, 280);
    orb2.addColorStop(0, hexToRgba(brand.accentColor, 0.20));
    orb2.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = orb2;
    ctx.fillRect(0, 0, bw, bh);

    const items =
      props.items && props.items.length > 0
        ? props.items
        : [
            "ทำไมลงคลิปทุกวันแต่ยอดวิวนิ่ง?",
            "เพราะ 3 วิแรกยังไม่ได้บอกคำตอบที่คนดูอยากรู้ครับ",
            "ลองเปิดด้วยผลลัพธ์ชัดๆ ตั้งแต่วินาทีแรกดูครับ",
          ];

    // Floating Profile Pill at top (no giant outer phone rectangle!)
    if (!suppressTopHeader) {
      const headerEnter = easeOutCubic(clamp01(p / 0.14));
      ctx.save();
      ctx.translate(bw / 2, 102);
      ctx.scale(headerEnter, headerEnter);
      ctx.fillStyle = "rgba(30, 41, 59, 0.76)";
      ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.roundRect(-195, -28, 390, 56, 28);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = brand.primaryColor;
      ctx.beginPath();
      ctx.arc(-158, 0, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#22C55E";
      ctx.beginPath();
      ctx.arc(-144, 13, 5, 0, Math.PI * 2);
      ctx.fill();

      drawFittedText(
        ctx,
        props.title ?? "บทสนทนาจากลูกค้าจริง",
        -126,
        7,
        296,
        19,
        14,
        600,
        font,
        "left",
        "#F8FAFC",
      );
      ctx.restore();
    }

    const drawSpeechBubble = (
      side: "left" | "right",
      cy: number,
      text: string,
      appearAt: number,
      accentFill = false,
      reaction?: string,
    ) => {
      if (p < appearAt) return;
      const bp = easeOutBack(clamp01((p - appearAt) / 0.18));
      const bubbleW = 382;
      const wrapped = wrapCanvasTextLines(ctx, text, bubbleW - 52, 19.5, 500, font, 2);
      const lineH = Math.round(wrapped.fontSize * 1.42);
      const bubbleH = Math.max(74, wrapped.lines.length * lineH + 34);
      const cx = side === "left" ? 246 : 294;

      ctx.save();
      ctx.translate(cx, cy + topShift);
      ctx.scale(bp, bp);

      // Avatar dot beside bubble
      const avatarX = side === "left" ? -bubbleW / 2 - 24 : bubbleW / 2 + 24;
      ctx.fillStyle = side === "left" ? "#334155" : brand.primaryColor;
      ctx.beginPath();
      ctx.arc(avatarX, bubbleH / 2 - 18, 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = side === "left" ? "#E2E8F0" : "#090D16";
      ctx.font = `600 13px ${font}`;
      ctx.textAlign = "center";
      ctx.fillText(side === "left" ? "?" : "✓", avatarX, bubbleH / 2 - 13);

      // Soft elevation shadow
      ctx.fillStyle = "rgba(0, 0, 0, 0.32)";
      ctx.beginPath();
      ctx.roundRect(-bubbleW / 2, -bubbleH / 2 + 8, bubbleW, bubbleH, 24);
      ctx.fill();

      // Bubble body
      ctx.fillStyle = accentFill ? brand.primaryColor : "rgba(30, 41, 59, 0.90)";
      ctx.strokeStyle = accentFill ? hexToRgba("#FFFFFF", 0.25) : "rgba(255, 255, 255, 0.14)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(-bubbleW / 2, -bubbleH / 2, bubbleW, bubbleH, 24);
      ctx.fill();
      ctx.stroke();

      // Readable medium-weight (500-600) wrapped Thai text — NEVER heavy 900 or truncated!
      const textColor = accentFill ? "#090D16" : "#F8FAFC";
      drawWrappedText(
        ctx,
        text,
        -bubbleW / 2 + 26,
        4,
        bubbleW - 52,
        19.5,
        accentFill ? 600 : 500,
        font,
        "left",
        textColor,
        2,
        1.42,
      );

      if (reaction) {
        ctx.fillStyle = "#0F172A";
        ctx.strokeStyle = "rgba(255,255,255,0.22)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.roundRect(bubbleW / 2 - 96, bubbleH / 2 - 14, 78, 28, 14);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#F8FAFC";
        ctx.font = `600 13.5px ${font}`;
        ctx.textAlign = "center";
        ctx.fillText(reaction, bubbleW / 2 - 57, bubbleH / 2 + 5);
      }
      ctx.restore();
    };

    if (config.templateId === "chat.viral-comment-reply") {
      drawSpeechBubble("left", 250, items[0] ?? "อยากได้ระบบนี้ ต้องเริ่มยังไงครับ?", 0.05, false, "❤️ 1.4K");

      if (p > 0.22) {
        const c2 = easeOutBack(clamp01((p - 0.22) / 0.18));
        const kw = cleanDisplayString(props.rightText ?? "สนใจ");
        ctx.save();
        ctx.translate(bw / 2, 435 + topShift);
        ctx.scale(c2, c2);
        ctx.fillStyle = brand.primaryColor;
        ctx.beginPath();
        ctx.roundRect(-210, -58, 420, 116, 28);
        ctx.fill();

        drawFittedText(ctx, `💬  พิมพ์คอมเมนต์ "${kw}"`, 0, -6, 376, 28, 19, 700, font, "center", "#090D16");
        drawFittedText(
          ctx,
          props.badgeText ?? "ส่งรายละเอียดให้ในแชตทันที",
          0,
          30,
          376,
          18,
          14,
          600,
          font,
          "center",
          "rgba(9, 13, 22, 0.85)",
        );
        ctx.restore();
      }
    } else {
      // Both dm-conversation & notification-stack use clean staggered organic conversation bubbles
      drawSpeechBubble("left", 225, items[0] ?? "ลูกค้าทักถามข้อมูลเข้ามาพร้อมกัน", 0.05, false);
      drawSpeechBubble("right", 365, items[1] ?? "ตอบกลับครบทุกคำถามทันทีแบบเป็นธรรมชาติ", 0.20, true);
      drawSpeechBubble("left", 505, items[2] ?? "ปิดการขายได้ไวขึ้นแม้ไม่ได้เฝ้าหน้าจอ", 0.36, false, "🔥 99+");

      // Live subtle typing pulse
      const dotBounce = (idx: number) => Math.sin(p * Math.PI * 8 + idx * 1.1) * 3.5;
      ctx.save();
      ctx.translate(116, 608 + topShift * 0.5);
      ctx.fillStyle = "rgba(30, 41, 59, 0.78)";
      ctx.beginPath();
      ctx.roundRect(-42, -16, 84, 32, 16);
      ctx.fill();
      for (let d = 0; d < 3; d++) {
        ctx.fillStyle = d === 1 ? brand.primaryColor : "#94A3B8";
        ctx.beginPath();
        ctx.arc(-18 + d * 18, dotBounce(d), 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  } else if (config.themeId === "apple-bento-glass") {
    // ── THEME E: APPLE KEYNOTE GLASS (Open Luminous Visual Metaphors — De-Boxified!) ──
    const bgGrad = ctx.createLinearGradient(0, 0, bw, bh);
    bgGrad.addColorStop(0, "#050811");
    bgGrad.addColorStop(0.5, "#0B1120");
    bgGrad.addColorStop(1, "#090D16");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, bw, bh);

    const mesh1 = ctx.createRadialGradient(145, 220, 10, 145, 220, 290);
    mesh1.addColorStop(0, hexToRgba(brand.primaryColor, 0.32));
    mesh1.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = mesh1;
    ctx.fillRect(0, 0, bw, bh);

    const mesh2 = ctx.createRadialGradient(405, 470, 10, 405, 470, 290);
    mesh2.addColorStop(0, hexToRgba(brand.accentColor, 0.24));
    mesh2.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = mesh2;
    ctx.fillRect(0, 0, bw, bh);

    const drawGlassCapsule = (
      x: number,
      y: number,
      w: number,
      h: number,
      activeGlow = false,
      radius = 24,
    ) => {
      ctx.save();
      ctx.fillStyle = "rgba(0, 0, 0, 0.34)";
      ctx.beginPath();
      ctx.roundRect(x + 2, y + 8, w, h, radius);
      ctx.fill();

      const grad = ctx.createLinearGradient(x, y, x, y + h);
      grad.addColorStop(0, activeGlow ? hexToRgba(brand.primaryColor, 0.24) : "rgba(30, 41, 59, 0.66)");
      grad.addColorStop(1, "rgba(15, 23, 42, 0.82)");
      ctx.fillStyle = grad;
      ctx.strokeStyle = activeGlow ? hexToRgba(brand.primaryColor, 0.72) : "rgba(255, 255, 255, 0.14)";
      ctx.lineWidth = activeGlow ? 2 : 1.2;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };

    if (!suppressTopHeader && props.headerText) {
      const topTag = trimPhraseAtWordBoundary(props.headerText, 28);
      ctx.save();
      ctx.translate(bw / 2, 76);
      drawGlassCapsule(-160, -19, 320, 38, false, 19);
      drawFittedText(ctx, `✦  ${topTag}`, 0, 5, 290, 13.5, 11, 600, monoFont, "center", brand.primaryColor);
      ctx.restore();
    }

    const items =
      props.items && props.items.length > 0
        ? props.items
        : ["สคริปต์เปิดฮุกชัด", "เสียงพากย์ไทยธรรมชาติ", "ภาพประกอบเข้าเนื้อหา", "ซับภาษาไทยตัดคำเป๊ะ"];

    if (config.templateId === "bento.feature-matrix") {
      // Connected Orbital Hub & 4 Floating Circular Glass Nodes (NO 2x2 rectangular mockup boxes!)
      const centerX = bw / 2;
      const centerY = 345 + topShift;
      const nodePositions = [
        { x: 138, y: 215 + topShift, icon: "✦" },
        { x: 402, y: 215 + topShift, icon: "🎙️" },
        { x: 138, y: 475 + topShift, icon: "🎬" },
        { x: 402, y: 475 + topShift, icon: "⚡" },
      ];
      const activeIdx = Math.min(3, Math.floor(p * 4));

      // Animated light beams radiating from Central Core to each orbital node
      nodePositions.forEach((n, idx) => {
        const beamP = easeOutCubic(clamp01((p - 0.04 * idx) / 0.25));
        if (beamP <= 0) return;
        ctx.save();
        const beamGrad = ctx.createLinearGradient(centerX, centerY, n.x, n.y);
        beamGrad.addColorStop(0, hexToRgba(brand.primaryColor, 0.75));
        beamGrad.addColorStop(1, hexToRgba(brand.accentColor || "#FFE500", idx === activeIdx ? 0.65 : 0.22));
        ctx.strokeStyle = beamGrad;
        ctx.lineWidth = idx === activeIdx ? 3 : 1.6;
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.lineTo(centerX + (n.x - centerX) * beamP, centerY + (n.y - centerY) * beamP);
        ctx.stroke();
        ctx.restore();
      });

      // Central Pulsing Core Orb
      const corePulse = 1 + Math.sin(p * Math.PI * 4) * 0.05;
      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.scale(corePulse, corePulse);
      const coreGlow = ctx.createRadialGradient(0, 0, 8, 0, 0, 72);
      coreGlow.addColorStop(0, hexToRgba(brand.primaryColor, 0.55));
      coreGlow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = coreGlow;
      ctx.beginPath();
      ctx.arc(0, 0, 72, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
      ctx.strokeStyle = brand.primaryColor;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(0, 0, 44, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      drawFittedText(ctx, props.badgeText ?? "AI", 0, 6, 68, 16, 12, 700, monoFont, "center", "#FFFFFF");
      ctx.restore();

      // 4 Floating Circular Icon Orbs + Full Un-Truncated Thai Labels
      nodePositions.forEach((n, idx) => {
        const at = 0.05 + idx * 0.09;
        if (p < at) return;
        const np = easeOutBack(clamp01((p - at) / 0.18));
        const isCurrent = idx === activeIdx;
        const label = cleanDisplayString(items[idx] ?? `องค์ประกอบที่ ${idx + 1}`);

        ctx.save();
        ctx.translate(n.x, n.y);
        ctx.scale(np, np);

        // Circular Frosted Orb
        ctx.fillStyle = isCurrent ? hexToRgba(brand.primaryColor, 0.28) : "rgba(30, 41, 59, 0.78)";
        ctx.strokeStyle = isCurrent ? (brand.accentColor || brand.primaryColor) : "rgba(255, 255, 255, 0.20)";
        ctx.lineWidth = isCurrent ? 2.6 : 1.5;
        ctx.beginPath();
        ctx.arc(0, -18, 42, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.font = `600 30px ${font}`;
        ctx.textAlign = "center";
        ctx.fillStyle = "#FFFFFF";
        ctx.fillText(n.icon, 0, -7);

        // Open floating pill label underneath orb (generous 216px width — never cuts "ฮุก"!)
        drawGlassCapsule(-108, 34, 216, 44, isCurrent, 22);
        drawFittedText(ctx, label, 0, 62, 194, 17.5, 13, 600, font, "center", "#F8FAFC");
        ctx.restore();
      });

      // Clean floating summary title below orbital diagram
      if (p > 0.34 && props.title) {
        const tp = easeOutCubic(clamp01((p - 0.34) / 0.18));
        ctx.save();
        ctx.globalAlpha = tp;
        drawFittedText(ctx, props.title, bw / 2, 616 + topShift * 0.4, 440, 22, 16, 600, font, "center", "#E2E8F0");
        ctx.restore();
      }
    } else if (config.templateId === "bento.pricing-verdict") {
      // Kinetic Time/Effort Compression Flow (or Action Step -> CTA Flow on closing windows)
      const beforeEnter = easeOutCubic(clamp01((p - 0.04) / 0.18));
      const strikeP = easeOutCubic(clamp01((p - 0.16) / 0.22));
      const afterEnter = easeOutBack(clamp01((p - 0.24) / 0.2));
      const topLineText = props.leftText ?? items[0] ?? "แบบเดิมใช้เวลานาน";
      const isCtaFlow = /คอมเมนต์|พิมพ์|สั่งซื้อ|ทักแชต|คลิก|เริ่ม/u.test(
        `${props.rightText ?? ""} ${props.title ?? ""} ${topLineText}`,
      ) && !/ชั่วโมง|ชม\.|เสียเวลา|ช้า|แพง|ยาก|เดิม/u.test(topLineText);

      // Top: Muted "Before" Timeline Bar (or Clean Step-1 Capsule on CTA windows)
      ctx.save();
      ctx.translate(bw / 2, 205 + topShift);
      ctx.globalAlpha = beforeEnter;
      if (isCtaFlow) {
        drawGlassCapsule(-180, -34, 360, 52, false, 26);
        drawFittedText(ctx, `01  ·  ${topLineText}`, 0, -1, 324, 21, 15, 600, font, "center", "#E2E8F0");
      } else {
        const { width: topW } = drawFittedText(
          ctx,
          topLineText,
          0,
          -24,
          420,
          24,
          17,
          600,
          font,
          "center",
          "#94A3B8",
        );

        // Long red/slate bar representing heavy manual effort
        ctx.fillStyle = "rgba(239, 68, 68, 0.20)";
        ctx.strokeStyle = "rgba(239, 68, 68, 0.50)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(-200, -4, 400, 20, 10);
        ctx.fill();
        ctx.stroke();

        // Clean centered strike-through sweep across the old text only
        if (strikeP > 0 && topW > 0) {
          const halfW = Math.min(180, topW / 2 + 12);
          ctx.strokeStyle = "rgba(239, 68, 68, 0.88)";
          ctx.lineWidth = 2.8;
          ctx.beginPath();
          ctx.moveTo(-halfW, -31);
          ctx.lineTo(-halfW + halfW * 2 * strikeP, -31);
          ctx.stroke();
        }
      }
      ctx.restore();

      // Center: Glowing Animated Compression Arrow / Beam
      if (p > 0.14) {
        const arrowP = easeOutCubic(clamp01((p - 0.14) / 0.2));
        ctx.save();
        ctx.translate(bw / 2, 290 + topShift);
        ctx.strokeStyle = brand.accentColor || brand.primaryColor;
        ctx.lineWidth = 3.5;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(0, -28);
        ctx.lineTo(0, -28 + 56 * arrowP);
        ctx.stroke();
        if (arrowP > 0.7) {
          ctx.beginPath();
          ctx.moveTo(-12, 16);
          ctx.lineTo(0, 28);
          ctx.lineTo(12, 16);
          ctx.stroke();
        }
        ctx.restore();
      }

      // Bottom: Radiant Spotlight Outcome + Sleek Compressed Sprint Bar
      if (p > 0.24) {
        ctx.save();
        ctx.translate(bw / 2, 435 + topShift);
        ctx.scale(afterEnter, afterEnter);
        drawGlassCapsule(-224, -84, 448, 196, true, 30);

        if (props.badgeText) {
          ctx.fillStyle = brand.primaryColor;
          ctx.beginPath();
          ctx.roundRect(-78, -66, 156, 28, 14);
          ctx.fill();
          drawFittedText(ctx, props.badgeText, 0, -47, 138, 13.5, 11, 700, monoFont, "center", "#090D16");
        }

        drawFittedText(
          ctx,
          props.rightText ?? props.title ?? "จบไวขึ้นด้วยระบบอัตโนมัติ",
          0,
          -4,
          404,
          32,
          21,
          700,
          font,
          "center",
          "#FFFFFF",
        );

        // Compact glowing green/accent sprint bar (visually 1/4th the old bar!)
        ctx.fillStyle = "rgba(255,255,255,0.10)";
        ctx.beginPath();
        ctx.roundRect(-180, 22, 360, 14, 7);
        ctx.fill();
        ctx.fillStyle = brand.accentColor || "#34D399";
        ctx.beginPath();
        ctx.roundRect(-180, 22, 96, 14, 7);
        ctx.fill();

        items.slice(0, 2).forEach((point, idx) => {
          drawFittedText(
            ctx,
            `✓  ${point}`,
            0,
            66 + idx * 30,
            396,
            17.5,
            13,
            600,
            font,
            "center",
            "#E2E8F0",
          );
        });
        ctx.restore();
      }
    } else {
      // bento.glass-metrics: Open Keynote Radial Arc Gauge + Floating Capsules
      const ringCenterY = 290 + topShift;
      const sweep = easeOutCubic(clamp01(p / 0.58));

      const metricMatch = `${props.title ?? ""} ${props.badgeText ?? ""} ${props.subtitle ?? ""}`.match(
        /([+-]?\d[\d,.]*)\s*(%|เท่า|x|X|ข้อ|ขั้นตอน|ขั้น|วัน|นาที|ชั่วโมง|ชม\.?|วินาที|บาท|คลิก)?/u,
      );
      const parsedNum = metricMatch ? Number(metricMatch[1]!.replace(/,/g, "")) : NaN;
      const targetNum = Number.isFinite(parsedNum) && parsedNum > 0 ? parsedNum : 100;
      const unitSuffix = metricMatch?.[2] ? ` ${metricMatch[2]}` : "%";
      const animatedVal = Math.max(1, Math.round(sweep * targetNum));
      const formattedMetric = `${targetNum >= 1000 ? animatedVal.toLocaleString("en-US") : animatedVal}${unitSuffix}`;

      // Outer luminous gauge track & active arc
      ctx.save();
      ctx.translate(bw / 2, ringCenterY);
      ctx.lineCap = "round";
      ctx.lineWidth = 16;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.09)";
      ctx.beginPath();
      ctx.arc(0, 0, 118, Math.PI * 0.78, Math.PI * 2.22);
      ctx.stroke();

      const arcGrad = ctx.createLinearGradient(-118, 0, 118, 0);
      arcGrad.addColorStop(0, brand.primaryColor);
      arcGrad.addColorStop(1, brand.accentColor || "#FFE500");
      ctx.strokeStyle = arcGrad;
      const endAngle = Math.PI * (0.78 + 1.44 * sweep);
      ctx.beginPath();
      ctx.arc(0, 0, 118, Math.PI * 0.78, endAngle);
      ctx.stroke();

      // Glowing comet dot at tip of arc
      const tipX = Math.cos(endAngle) * 118;
      const tipY = Math.sin(endAngle) * 118;
      ctx.fillStyle = "#FFFFFF";
      ctx.shadowColor = brand.accentColor || brand.primaryColor;
      ctx.shadowBlur = 16;
      ctx.beginPath();
      ctx.arc(tipX, tipY, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // Hero metric inside open ring
      drawFittedText(ctx, formattedMetric, 0, 12, 196, 48, 28, 700, font, "center", "#FFFFFF");
      if (props.badgeText) {
        drawFittedText(ctx, props.badgeText, 0, 52, 160, 14, 11, 600, monoFont, "center", brand.accentColor || "#94A3B8");
      }
      ctx.restore();

      // Subtitle / Headline floating cleanly underneath ring
      drawFittedText(
        ctx,
        props.subtitle ?? props.title ?? "สรุปข้อมูลสำคัญที่ต้องรู้",
        bw / 2,
        452 + topShift,
        444,
        22,
        16,
        600,
        font,
        "center",
        "#F8FAFC",
      );

      // 2 Sleek Floating Capsules at bottom
      items.slice(0, 2).forEach((item, idx) => {
        const at = 0.22 + idx * 0.12;
        if (p < at) return;
        const cp = easeOutBack(clamp01((p - at) / 0.16));
        const y = 516 + topShift * 0.6 + idx * 58;
        ctx.save();
        ctx.translate(bw / 2, y);
        ctx.scale(cp, cp);
        drawGlassCapsule(-205, -22, 410, 44, idx === 0, 22);
        drawFittedText(ctx, `✦  ${item}`, 0, 6, 374, 17.5, 13, 600, font, "center", "#E2E8F0");
        ctx.restore();
      });
    }
  } else {
    // ── THEME B: DOODLE EXPLAINER (Ref 1 Expressive Illustration + Clean Thai Labels) ──
    if (!suppressTopHeader && props.headerText) {
      const cleanH = trimPhraseAtWordBoundary(props.headerText, 28);
      ctx.font = `700 22px ${font}`;
      const headerW = Math.min(464, Math.max(200, ctx.measureText(cleanH).width + 54));
      ctx.save();
      ctx.translate(bw / 2, 72);
      ctx.rotate(-0.015);
      drawCard(-headerW / 2, -25, headerW, 50, "#FFFFFF", 25, "#111827", 3.6);
      drawFittedText(ctx, cleanH, 0, 8, headerW - 36, 22, 16, 700, font, "center", "#111827");
      ctx.restore();
    }

    const items =
      props.items && props.items.length > 0
        ? props.items
        : ["วางซีรีส์ชัด", "ตัวละครจำง่าย", "เปิดฮุกทันที", "จบกระชับ"];

    switch (entry.archetypeId) {
      case "hook-character": {
        const walkP = clamp01(p / 0.55);
        const charX = 162 + walkP * 28;
        const surprised = p > 0.38;
        drawStickman(charX, 505, 1.05, walkP * 2, surprised, p > 0.25 ? "right" : "none");

        if (p > 0.1) {
          const cp = easeOutBack(clamp01((p - 0.1) / 0.18));
          const clockLabel = trimPhraseAtWordBoundary(props.badgeText ?? "3 วินาทีแรก", 18);
          ctx.save();
          ctx.translate(382, 360 + topShift * 0.5);
          ctx.scale(cp, cp);
          drawCard(-88, -88, 176, 176, "#FFFFFF", 88, "#111827", 4);

          ctx.strokeStyle = "#9CA3AF";
          ctx.lineWidth = 2.8;
          for (let t = 0; t < 12; t++) {
            const a = (t / 12) * Math.PI * 2;
            ctx.beginPath();
            ctx.moveTo(Math.cos(a) * 68, Math.sin(a) * 68);
            ctx.lineTo(Math.cos(a) * 76, Math.sin(a) * 76);
            ctx.stroke();
          }

          const handAngle = -Math.PI * 0.85 + clamp01((p - 0.12) / 0.45) * Math.PI * 0.65;
          ctx.strokeStyle = "#111827";
          ctx.lineWidth = 4.5;
          ctx.beginPath();
          ctx.moveTo(0, -10);
          ctx.lineTo(Math.cos(handAngle) * 40, -10 + Math.sin(handAngle) * 40);
          ctx.stroke();

          ctx.strokeStyle = brand.primaryColor;
          ctx.lineWidth = 4.5;
          ctx.beginPath();
          ctx.moveTo(0, -10);
          ctx.lineTo(42, -10);
          ctx.stroke();

          drawFittedText(ctx, clockLabel, 0, 42, 142, 19, 13, 700, font, "center", "#111827");
          ctx.restore();
        }

        if (p > 0.36) {
          const qp = easeOutBack(clamp01((p - 0.36) / 0.16));
          ctx.save();
          ctx.translate(charX + 4, 326);
          ctx.scale(qp, qp);
          ctx.font = `700 62px ${font}`;
          ctx.textAlign = "center";
          ctx.fillStyle = "#FACC15";
          ctx.strokeStyle = "#111827";
          ctx.lineWidth = 5;
          ctx.strokeText("?", 0, 0);
          ctx.fillText("?", 0, 0);
          ctx.restore();
        }
        break;
      }

      case "three-cards-progression": {
        // Open Hand-Drawn Milestone Trail + Circular Flame/Energy Medallions (NO narrow 112px boxes that cut Thai words!)
        const stageItems = [
          cleanDisplayString(items[0] ?? "ตอน 1 ไฟแรง"),
          cleanDisplayString(items[1] ?? "ตอน 2 เริ่มช้า"),
          cleanDisplayString(items[2] ?? "ตอน 3 หมดไฟ"),
        ];
        const coords = [
          { x: 108, y: 310 + topShift * 0.4, flame: 1.0 },
          { x: 266, y: 382 + topShift * 0.4, flame: 0.58 },
          { x: 424, y: 454 + topShift * 0.4, flame: 0.0 },
        ];

        // Curved dotted ink trail connecting milestones
        ctx.save();
        ctx.strokeStyle = "rgba(17, 24, 39, 0.45)";
        ctx.lineWidth = 3.5;
        ctx.setLineDash([8, 6]);
        ctx.beginPath();
        ctx.moveTo(coords[0]!.x, coords[0]!.y);
        ctx.quadraticCurveTo(coords[1]!.x, coords[1]!.y - 12, coords[2]!.x, coords[2]!.y);
        ctx.stroke();
        ctx.restore();

        coords.forEach((c, idx) => {
          const at = 0.05 + idx * 0.14;
          if (p < at) return;
          const cp = easeOutBack(clamp01((p - at) / 0.16));
          const lbl = stageItems[idx]!;

          ctx.save();
          ctx.translate(c.x, c.y);
          ctx.scale(cp, cp);

          // Circular emblem instead of narrow rectangle
          drawCard(-46, -46, 92, 92, "#FFFFFF", 46, "#111827", 3.6);

          if (c.flame > 0) {
            ctx.save();
            ctx.translate(0, 6);
            ctx.scale(c.flame * 0.82, c.flame * 0.82);
            ctx.fillStyle = "#F97316";
            ctx.strokeStyle = "#111827";
            ctx.lineWidth = 3.6;
            ctx.beginPath();
            ctx.moveTo(0, -44);
            ctx.bezierCurveTo(30, -14, 34, 22, 0, 34);
            ctx.bezierCurveTo(-34, 22, -30, -14, 0, -44);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = "#FACC15";
            ctx.beginPath();
            ctx.moveTo(0, -20);
            ctx.bezierCurveTo(14, -4, 16, 16, 0, 24);
            ctx.bezierCurveTo(-16, 16, -14, -4, 0, -20);
            ctx.fill();
            ctx.restore();
          } else {
            // Exhausted smoke spiral
            ctx.strokeStyle = "#6B7280";
            ctx.lineWidth = 3.5;
            ctx.beginPath();
            ctx.moveTo(-6, 18);
            ctx.quadraticCurveTo(-16, -4, 6, -16);
            ctx.quadraticCurveTo(18, -26, -2, -34);
            ctx.stroke();
          }

          // Wide pill ribbon underneath medallion (156px wide, auto-fitted — zero word chopping!)
          drawCard(-78, 56, 156, 40, "#FFFFFF", 20, "#111827", 3.2);
          drawFittedText(ctx, lbl, 0, 82, 138, 17, 12.5, 600, font, "center", "#111827");
          ctx.restore();
        });

        if (p > 0.38 && props.badgeText) {
          const bp = easeOutBack(clamp01((p - 0.38) / 0.16));
          const badge = trimPhraseAtWordBoundary(props.badgeText, 22);
          ctx.save();
          ctx.translate(330, 218 + topShift * 0.5);
          ctx.scale(bp, bp);
          drawCard(-108, -24, 216, 48, "#EF4444", 24, "#111827", 3.6);
          drawFittedText(ctx, badge, 0, 7, 190, 20, 14, 700, font, "center", "#FFFFFF");
          ctx.restore();
        }
        drawStickman(124, 545, 0.78, 0, p > 0.38, "right");
        break;
      }

      case "chart-vs-reality": {
        drawStickman(270, 560, 0.82, 0, false, p > 0.34 ? "right" : "left");
        if (p > 0.04) {
          const cp = easeOutBack(clamp01((p - 0.04) / 0.16));
          ctx.save();
          ctx.translate(142, 304 + topShift * 0.4);
          ctx.scale(cp, cp);
          drawCard(-102, -84, 204, 168, "#FFFFFF", 22, "#111827", 3.6);
          ctx.strokeStyle = "#22C55E";
          ctx.lineWidth = 6;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(-66, 16);
          ctx.lineTo(-22, -14);
          ctx.lineTo(14, 0);
          ctx.lineTo(64, -52);
          ctx.stroke();

          drawFittedText(ctx, props.leftText ?? "คาดหวังสูง", 0, 58, 180, 17.5, 13, 600, font, "center", "#111827");

          if (p > 0.2) {
            const xp = clamp01((p - 0.2) / 0.15);
            ctx.strokeStyle = "#EF4444";
            ctx.lineWidth = 7;
            ctx.beginPath();
            ctx.moveTo(-56, -52);
            ctx.lineTo(-56 + 112 * xp, -52 + 74 * xp);
            if (xp > 0.5) {
              const xp2 = (xp - 0.5) * 2;
              ctx.moveTo(56, -52);
              ctx.lineTo(56 - 112 * xp2, -52 + 74 * xp2);
            }
            ctx.stroke();
          }
          ctx.restore();
        }

        if (p > 0.32) {
          const cp = easeOutBack(clamp01((p - 0.32) / 0.16));
          ctx.save();
          ctx.translate(398, 304 + topShift * 0.4);
          ctx.scale(cp, cp);
          drawCard(-102, -84, 204, 168, "#FFFFFF", 22, "#111827", 3.6);
          for (let i = 0; i < 4; i++) {
            const bx = -76 + i * 39;
            const by = -28;
            ctx.strokeStyle = "#111827";
            ctx.lineWidth = 3.2;
            ctx.beginPath();
            ctx.roundRect(bx, by, 30, 30, 7);
            ctx.stroke();
            if (p > 0.38 + i * 0.07) {
              ctx.strokeStyle = brand.primaryColor;
              ctx.lineWidth = 4.2;
              ctx.beginPath();
              ctx.moveTo(bx + 6, by + 15);
              ctx.lineTo(bx + 13, by + 22);
              ctx.lineTo(bx + 24, by + 8);
              ctx.stroke();
            }
          }
          drawFittedText(ctx, props.rightText ?? "ทำซ้ำได้ทุกสัปดาห์", 0, 58, 180, 17.5, 13, 600, font, "center", "#111827");
          ctx.restore();
        }
        break;
      }

      case "step-checklist": {
        const bookEnter = easeOutBack(clamp01(p / 0.16));
        ctx.save();
        ctx.translate(118, 385 + topShift * 0.4);
        ctx.scale(bookEnter, bookEnter);
        ctx.rotate(-0.07);
        drawCard(-70, -94, 144, 194, "#FFFFFF", 14, "#111827", 3.6);
        drawCard(-76, -102, 144, 194, brand.primaryColor, 14, "#111827", 3.6);
        ctx.strokeStyle = "#111827";
        ctx.lineWidth = 3.2;
        ctx.beginPath();
        ctx.moveTo(-54, -102);
        ctx.lineTo(-54, 92);
        ctx.stroke();

        drawCard(-42, -72, 98, 40, "#FFFFFF", 8, "#111827", 3);
        drawFittedText(ctx, props.title ?? "สูตรสำเร็จ", 7, -46, 86, 16, 11.5, 700, font, "center", "#111827");
        ctx.restore();

        items.slice(0, 4).forEach((item, idx) => {
          const at = 0.1 + idx * 0.11;
          if (p < at) return;
          const ip = easeOutBack(clamp01((p - at) / 0.14));
          const y = 268 + topShift * 0.4 + idx * 66;
          ctx.save();
          ctx.translate(344, y);
          ctx.scale(ip, ip);

          // Circular check badge + clean pill
          ctx.fillStyle = "#FFFFFF";
          ctx.strokeStyle = "#111827";
          ctx.lineWidth = 3.2;
          ctx.beginPath();
          ctx.arc(-118, 0, 18, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();

          ctx.strokeStyle = brand.primaryColor;
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.moveTo(-125, 0);
          ctx.lineTo(-119, 6);
          ctx.lineTo(-110, -6);
          ctx.stroke();

          drawCard(-90, -21, 252, 42, "#FFFFFF", 21, "#111827", 3.2);
          drawFittedText(ctx, item, 36, 6, 224, 17.5, 13, 600, font, "center", "#111827");
          ctx.restore();
        });
        break;
      }

      case "flow-diagram": {
        const coords = [
          { x: 145, y: 262 + topShift * 0.4, at: 0.04, icon: "doc" },
          { x: 395, y: 262 + topShift * 0.4, at: 0.15, icon: "audio" },
          { x: 145, y: 462 + topShift * 0.4, at: 0.27, icon: "scene" },
          { x: 395, y: 462 + topShift * 0.4, at: 0.39, icon: "play" },
        ];
        ctx.strokeStyle = "#111827";
        ctx.lineWidth = 3.6;
        if (p > 0.12) {
          ctx.beginPath();
          ctx.moveTo(212, coords[0]!.y - 8);
          ctx.quadraticCurveTo(270, coords[0]!.y - 28, 326, coords[1]!.y - 8);
          ctx.stroke();
        }
        if (p > 0.24) {
          ctx.beginPath();
          ctx.moveTo(340, coords[1]!.y + 52);
          ctx.quadraticCurveTo(270, coords[1]!.y + 112, 205, coords[2]!.y - 46);
          ctx.stroke();
        }
        if (p > 0.36) {
          ctx.beginPath();
          ctx.moveTo(212, coords[2]!.y - 6);
          ctx.quadraticCurveTo(270, coords[2]!.y - 22, 326, coords[3]!.y - 6);
          ctx.stroke();
        }

        coords.forEach((c, idx) => {
          if (p < c.at) return;
          const np = easeOutBack(clamp01((p - c.at) / 0.14));
          const lbl = cleanDisplayString(items[idx] ?? `ขั้นที่ ${idx + 1}`);
          ctx.save();
          ctx.translate(c.x, c.y);
          ctx.scale(np, np);
          ctx.fillStyle = "#FFFFFF";
          ctx.strokeStyle = "#111827";
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.arc(0, 0, 46, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();

          if (c.icon === "doc") {
            ctx.strokeRect(-15, -19, 30, 38);
            ctx.beginPath();
            ctx.moveTo(-8, -7);
            ctx.lineTo(8, -7);
            ctx.moveTo(-8, 2);
            ctx.lineTo(8, 2);
            ctx.moveTo(-8, 11);
            ctx.lineTo(4, 11);
            ctx.stroke();
          } else if (c.icon === "audio") {
            ctx.beginPath();
            ctx.moveTo(-15, -7);
            ctx.lineTo(-5, -7);
            ctx.lineTo(6, -17);
            ctx.lineTo(6, 17);
            ctx.lineTo(-5, 7);
            ctx.lineTo(-15, 7);
            ctx.closePath();
            ctx.stroke();
          } else if (c.icon === "scene") {
            ctx.beginPath();
            ctx.arc(0, -8, 11, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(0, 20, 17, Math.PI * 1.15, Math.PI * 1.85);
            ctx.stroke();
          } else {
            ctx.fillStyle = brand.primaryColor;
            ctx.beginPath();
            ctx.roundRect(-20, -14, 40, 28, 8);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = "#FFFFFF";
            ctx.beginPath();
            ctx.moveTo(-5, -7);
            ctx.lineTo(9, 0);
            ctx.lineTo(-5, 7);
            ctx.closePath();
            ctx.fill();
          }

          drawCard(-104, 56, 208, 38, "#FFFFFF", 19, "#111827", 3.2);
          drawFittedText(ctx, lbl, 0, 81, 186, 17, 12.5, 600, font, "center", "#111827");
          ctx.restore();
        });
        break;
      }

      case "before-after-split": {
        // Circular/Organic Visual Contrast instead of rigid twins
        ctx.save();
        ctx.translate(144, 332 + topShift * 0.4);
        drawCard(-102, -96, 204, 192, "#FFFFFF", 28, "#111827", 3.6);
        drawFittedText(ctx, "วิธีเดิม", 0, -52, 176, 18, 14, 600, font, "center", "#6B7280");
        drawFittedText(ctx, props.leftText ?? "เกริ่นน้ำยาว", 0, -6, 180, 20, 14, 700, font, "center", "#111827");
        ctx.strokeStyle = "#EF4444";
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(-22, 30);
        ctx.lineTo(22, 66);
        ctx.moveTo(22, 30);
        ctx.lineTo(-22, 66);
        ctx.stroke();
        ctx.restore();

        if (p > 0.2) {
          const ap = easeOutBack(clamp01((p - 0.2) / 0.16));
          ctx.save();
          ctx.translate(396, 332 + topShift * 0.4);
          ctx.scale(ap, ap);
          drawCard(-102, -96, 204, 192, brand.accentColor, 28, "#111827", 3.6);
          drawFittedText(ctx, "วิธีที่เวิร์ก!", 0, -52, 176, 19, 14, 700, font, "center", "#111827");
          drawFittedText(ctx, props.rightText ?? "เปิดด้วยคำตอบ", 0, -6, 180, 20, 14, 700, font, "center", "#111827");

          ctx.fillStyle = brand.primaryColor;
          ctx.beginPath();
          ctx.arc(0, 48, 22, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = "#FFFFFF";
          ctx.font = `700 22px ${font}`;
          ctx.textAlign = "center";
          ctx.fillText("✓", 0, 56);
          ctx.restore();
        }
        drawStickman(270, 520, 0.82, 0, false, "right");
        break;
      }

      case "screen-showcase": {
        drawCard(42, 185 + topShift * 0.4, 456, 260, "#1F2937", 22, "#111827", 4);
        drawCard(58, 201 + topShift * 0.4, 424, 228, "#EBF5FF", 14, "#111827", 3);

        drawCard(290, 222 + topShift * 0.4, 162, 108, "#BAE6FD", 10, "#111827", 2.8);
        const bColors = [brand.primaryColor, "#F59E0B", "#10B981"];
        for (let b = 0; b < 3; b++) {
          ctx.fillStyle = bColors[b]!;
          ctx.strokeStyle = "#111827";
          ctx.lineWidth = 2.4;
          const bx = 304 + b * 46;
          const bhBox = 44 + (b % 2) * 18;
          ctx.fillRect(bx, 330 + topShift * 0.4 - bhBox, 36, bhBox);
          ctx.strokeRect(bx, 330 + topShift * 0.4 - bhBox, 36, bhBox);
        }

        ctx.fillStyle = "#C69C72";
        ctx.fillRect(60, 383 + topShift * 0.4, 420, 44);
        ctx.strokeStyle = "#111827";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(60, 383 + topShift * 0.4);
        ctx.lineTo(480, 383 + topShift * 0.4);
        ctx.stroke();

        const walkP = clamp01(p);
        drawStickman(150 + walkP * 80, 352 + topShift * 0.4, 0.56, walkP * 2, false, "right");

        if (p > 0.16) {
          const bp = easeOutBack(clamp01((p - 0.16) / 0.16));
          ctx.save();
          ctx.translate(152, 512 + topShift * 0.3);
          ctx.scale(bp, bp);
          ctx.rotate(-0.025);
          drawCard(-112, -24, 224, 48, "#FFFFFF", 24, "#111827", 3.4);
          drawFittedText(ctx, items[0] ?? "ชัดเจนทุกขั้นตอน", 0, 7, 198, 18, 13, 600, font, "center", "#111827");
          ctx.restore();
        }

        if (p > 0.3) {
          const bp2 = easeOutBack(clamp01((p - 0.3) / 0.16));
          ctx.save();
          ctx.translate(388, 512 + topShift * 0.3);
          ctx.scale(bp2, bp2);
          ctx.rotate(0.02);
          drawCard(-112, -24, 224, 48, brand.accentColor, 24, "#111827", 3.4);
          drawFittedText(ctx, props.badgeText ?? items[1] ?? "เข้าใจในภาพเดียว", 0, 7, 198, 18, 13, 700, font, "center", "#111827");
          ctx.restore();
        }
        break;
      }

      case "price-slash-cta":
      default: {
        drawStickman(132, 505, 0.92, 0, false, "right");

        const btnEnter = easeOutBack(clamp01(p / 0.18));
        ctx.save();
        ctx.translate(292, 325 + topShift * 0.4);
        ctx.scale(btnEnter, btnEnter);
        drawCard(-168, -50, 336, 100, brand.primaryColor, 50, "#111827", 4.2);
        drawFittedText(
          ctx,
          props.rightText ? `พิมพ์ "${props.rightText}"` : "สั่งซื้อ / ทักแชต",
          0,
          12,
          296,
          36,
          22,
          700,
          font,
          "center",
          "#FFFFFF",
        );

        if (p > 0.22) {
          ctx.strokeStyle = "#EF4444";
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.moveTo(-95, -66);
          ctx.lineTo(-82, -84);
          ctx.lineTo(-70, -68);
          ctx.moveTo(70, -68);
          ctx.lineTo(82, -84);
          ctx.lineTo(95, -66);
          ctx.stroke();
        }
        ctx.restore();

        if (p > 0.32) {
          const sp = easeOutBack(clamp01((p - 0.32) / 0.16));
          ctx.save();
          ctx.translate(372, 485 + topShift * 0.3);
          ctx.scale(sp, sp);
          drawCard(-124, -32, 248, 64, "#FFFFFF", 32, "#111827", 3.8);
          drawFittedText(ctx, props.badgeText ?? "ส่งให้ในแชตทันที", 0, 8, 216, 20, 14, 600, font, "center", "#111827");
          ctx.restore();
        }
        break;
      }
    }
  }

  ctx.restore();
}

export function MotionBrollScene({
  motionTemplate,
  fallbackTemplateId = "doodle.hook-character",
  segDurFrames,
  tailFrames,
  headFrames,
  suppressTopHeader = false,
}: {
  motionTemplate?: MotionTemplateConfig | null;
  fallbackTemplateId?: MotionTemplateId;
  segDurFrames: number;
  tailFrames: number;
  headFrames: number;
  suppressTopHeader?: boolean;
}) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const resolvedConfig: MotionTemplateConfig = motionTemplate ?? {
    templateId: fallbackTemplateId,
    themeId: motionTemplateEntry(fallbackTemplateId).themeId,
    archetypeId: motionTemplateEntry(fallbackTemplateId).archetypeId,
    brandCi: DEFAULT_THEME_BRAND_CI[motionTemplateEntry(fallbackTemplateId).themeId],
    props: motionTemplateEntry(fallbackTemplateId).defaultProps,
  };

  const progress = clamp01(frame / Math.max(1, segDurFrames));
  const fadeIn =
    headFrames > 0
      ? interpolate(frame, [0, headFrames], [0, 1], { extrapolateRight: "clamp" })
      : 1;
  const fadeOut =
    tailFrames > 0
      ? interpolate(frame, [segDurFrames, segDurFrames + tailFrames], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 1;
  const opacity = Math.min(fadeIn, fadeOut);

  useLayoutEffect(() => {
    paintMotionBrollCanvas(canvasRef.current, resolvedConfig, progress, { suppressTopHeader });
  }, [resolvedConfig, progress, width, height, suppressTopHeader]);

  return (
    <AbsoluteFill style={{ opacity }}>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        data-motion-broll-template={resolvedConfig.templateId}
        style={{ width: "100%", height: "100%", display: "block" }}
      />
    </AbsoluteFill>
  );
}
