import React, { useEffect, useRef } from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
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

function hexToRgba(hex: string, alpha: number): string {
  const clean = (hex || "").trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return `rgba(56, 189, 248, ${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
) {
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  const s = W / 540; // Base coordinate space = 540x960 (scales cleanly to 1080x1920)
  const p = clamp01(progress);

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

  // 1. Background layer
  const bgVariant = props.backgroundVariant ?? entry.defaultBackgroundVariant;
  if (bgVariant === "sky-desert") {
    const skyGrad = ctx.createLinearGradient(0, 0, 0, bh * 0.64);
    skyGrad.addColorStop(0, "#4CB5F5");
    skyGrad.addColorStop(1, "#72CCF9");
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, bw, bh * 0.64);

    // Rotating Sun with crisp rays
    ctx.save();
    ctx.translate(bw * 0.81, bh * 0.19);
    ctx.rotate(p * Math.PI * 0.45);
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 4.5;
    ctx.lineCap = "round";
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 42, Math.sin(a) * 42);
      ctx.lineTo(Math.cos(a) * 56, Math.sin(a) * 56);
      ctx.stroke();
    }
    ctx.fillStyle = "#FACC15";
    ctx.beginPath();
    ctx.arc(0, 0, 32, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Floating Cloud with subtle outline
    const cloudX = 95 + Math.sin(p * Math.PI * 2) * 14;
    const cloudY = 185;
    ctx.save();
    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath();
    ctx.arc(cloudX, cloudY, 24, 0, Math.PI * 2);
    ctx.arc(cloudX + 25, cloudY - 8, 29, 0, Math.PI * 2);
    ctx.arc(cloudX + 52, cloudY, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Layered Sand Dunes (3 distinct tones + hand-drawn ink horizon lines)
    ctx.fillStyle = "#E7BC91";
    ctx.beginPath();
    ctx.moveTo(0, bh * 0.61);
    ctx.quadraticCurveTo(bw * 0.48, bh * 0.585, bw, bh * 0.62);
    ctx.lineTo(bw, bh);
    ctx.lineTo(0, bh);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 4;
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
    // Rich dark navy studio backdrop with radial spotlight glow
    const bgGrad = ctx.createLinearGradient(0, 0, 0, bh);
    bgGrad.addColorStop(0, "#0B1120");
    bgGrad.addColorStop(0.65, brand.backgroundColor || "#111827");
    bgGrad.addColorStop(1, "#1E1B18");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, bw, bh);

    // Subtle dot matrix
    ctx.fillStyle = "rgba(148, 163, 184, 0.13)";
    for (let y = 26; y < bh * 0.76; y += 32) {
      for (let x = 26; x < bw; x += 32) {
        ctx.beginPath();
        ctx.arc(x, y, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Ambient Brand CI Spotlight behind the board & presenter
    const glow = ctx.createRadialGradient(bw * 0.55, bh * 0.44, 20, bw * 0.55, bh * 0.44, 340);
    glow.addColorStop(0, hexToRgba(brand.primaryColor, 0.22));
    glow.addColorStop(0.55, hexToRgba(brand.primaryColor, 0.07));
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, bw, bh);
  } else {
    // cream-dots (Doodle editorial dot-grid paper)
    ctx.fillStyle = brand.backgroundColor || "#FDF8EC";
    ctx.fillRect(0, 0, bw, bh);
    ctx.fillStyle = "rgba(180, 165, 140, 0.35)";
    for (let y = 28; y < bh; y += 38) {
      for (let x = 28; x < bw; x += 38) {
        ctx.beginPath();
        ctx.arc(x, y, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Helper: Rounded card with thick ink outline + offset shadow
  const drawCard = (
    x: number,
    y: number,
    w: number,
    h: number,
    fill: string,
    radius = 16,
    strokeColor = "#111827",
    lineWidth = 4.5,
  ) => {
    ctx.save();
    ctx.fillStyle = "rgba(17, 24, 39, 0.18)";
    ctx.beginPath();
    ctx.roundRect(x + 5, y + 7, w, h, radius);
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

  // Helper: Expressive Stickman / Mascot character with living head-bob, eye blink & pointing arm
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
    ctx.lineWidth = 4.8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const swing = Math.sin(walkPhase * Math.PI * 4) * 15;

    // Ground contact shadow
    ctx.fillStyle = "rgba(17, 24, 39, 0.18)";
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

    // Head group with subtle bob & tilt
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
      // Round White Head with soft inner shading on left edge
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

      // Eyes (with natural blink)
      ctx.fillStyle = "#111827";
      if (isBlinking) {
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(-18, -76);
        ctx.lineTo(-6, -76);
        ctx.moveTo(12, -76);
        ctx.lineTo(24, -76);
        ctx.stroke();
        ctx.lineWidth = 4.8;
      } else {
        ctx.beginPath();
        ctx.arc(-12, -76, 4.5, 0, Math.PI * 2);
        ctx.arc(18, -76, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }

      if (mascot === "stickman-glasses") {
        ctx.strokeStyle = brand.primaryColor || "#111827";
        ctx.lineWidth = 4;
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
        ctx.lineWidth = 4.8;
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

        // Red comic shock zig-zags on both sides of head (Ref 1 style)
        ctx.strokeStyle = "#EF4444";
        ctx.lineWidth = 3.8;
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

  // ── THEME A: CUE STEP BOARD & HYPERFRAME KINETIC (Ref 2 Studio Desk + Rich Board) ──
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

    // 1. Dark Board Card with subtle -1.5deg tilt & neon rim
    const cardEnter = easeOutBack(clamp01(p / 0.16));
    ctx.save();
    ctx.translate(bw / 2, 285);
    ctx.scale(cardEnter, cardEnter);
    ctx.rotate(-0.018);

    // Outer ambient shadow
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.beginPath();
    ctx.roundRect(-228, -212, 464, 434, 22);
    ctx.fill();

    // Card surface
    ctx.fillStyle = "#161F30";
    ctx.strokeStyle = hexToRgba(brand.primaryColor, 0.65);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(-232, -218, 464, 430, 20);
    ctx.fill();
    ctx.stroke();

    // Step Pill + Segmented Progress Bar inside top of Card (Ref 2 exact layout)
    const stepText = trimPhraseAtWordBoundary(props.headerText ?? "STEP 1/9", 14);
    ctx.fillStyle = brand.primaryColor;
    ctx.beginPath();
    ctx.roundRect(-200, -190, 96, 30, 8);
    ctx.fill();
    ctx.fillStyle = "#090D16";
    ctx.font = `900 15px ${font}`;
    ctx.textAlign = "center";
    ctx.fillText(stepText, -152, -170);

    const totalSegs = 9;
    const stepMatch = stepText.match(/(\d+)\s*\/\s*(\d+)/);
    const activeSegs = stepMatch ? Math.min(totalSegs, Math.max(1, parseInt(stepMatch[1], 10))) : Math.ceil(p * 6);
    for (let i = 0; i < totalSegs; i++) {
      ctx.fillStyle = i < activeSegs ? brand.primaryColor : "rgba(255,255,255,0.14)";
      ctx.beginPath();
      ctx.roundRect(-90 + i * 32, -179, 25, 7, 3.5);
      ctx.fill();
    }

    // Main Card Title + Monospace file path subtitle
    ctx.fillStyle = "#FFFFFF";
    ctx.font = `900 31px ${font}`;
    ctx.textAlign = "left";
    ctx.fillText(trimPhraseAtWordBoundary(props.title ?? "หัวข้อสำคัญ", 22), -200, -124);

    ctx.fillStyle = "#94A3B8";
    ctx.font = `500 16px ${monoFont}`;
    ctx.fillText(trimPhraseAtWordBoundary(props.subtitle ?? "workflow/step.ts", 36), -200, -96);

    // Divider line
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-200, -78);
    ctx.lineTo(200, -78);
    ctx.stroke();

    const items =
      props.items && props.items.length > 0
        ? props.items
        : ["วางโครงเรื่องให้ชัด", "เปิดด้วยภาพคำตอบทันที", "ล็อกสีและฟอนต์ประจำช่อง"];

    // Specialized Rich Board Content (8 distinct production layouts)
    if (boardStyle === "comment-cta") {
      // Glowing CTA Board with Typewriter Input Box
      drawCard(-196, -42, 392, 82, "#FFFFFF", 41, brand.primaryColor, 4);
      const word = props.rightText ?? "MEW";
      const chars = Math.max(1, Math.floor(clamp01((p - 0.12) / 0.42) * word.length));
      ctx.fillStyle = "#0F172A";
      ctx.font = `900 34px ${font}`;
      ctx.textAlign = "left";
      ctx.fillText(`💬  ${word.slice(0, chars)}`, -164, 11);

      // Blinking cursor
      if (Math.floor(p * 12) % 2 === 0) {
        const textW = ctx.measureText(`💬  ${word.slice(0, chars)}`).width;
        ctx.fillStyle = brand.primaryColor;
        ctx.fillRect(-160 + textW, -18, 4, 36);
      }

      // Send Paper Plane icon on right of input
      ctx.strokeStyle = "#0F172A";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(145, -2);
      ctx.lineTo(172, -12);
      ctx.lineTo(160, 14);
      ctx.lineTo(154, 3);
      ctx.closePath();
      ctx.stroke();

      if (p > 0.32) {
        const bp = easeOutBack(clamp01((p - 0.32) / 0.18));
        ctx.save();
        ctx.translate(0, 108);
        ctx.scale(bp, bp);
        drawCard(-180, -28, 360, 56, brand.primaryColor, 14, "#0F172A", 3.5);
        ctx.fillStyle = "#090D16";
        ctx.font = `800 22px ${font}`;
        ctx.textAlign = "center";
        ctx.fillText(trimPhraseAtWordBoundary(props.badgeText ?? "เดี๋ยวส่งรายละเอียดให้ในแชต", 26), 0, 8);
        ctx.restore();
      }
    } else if (boardStyle === "audio-waveform") {
      // Waveform box + timing pills (Ref 2 Step 4/9)
      ctx.fillStyle = "#0B1120";
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(-200, -58, 400, 150, 12);
      ctx.fill();
      ctx.stroke();

      // Center playhead axis
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.beginPath();
      ctx.moveTo(-190, 17);
      ctx.lineTo(190, 17);
      ctx.stroke();

      const totalBars = 58;
      const activeBars = Math.floor(clamp01((p - 0.05) / 0.65) * totalBars);
      for (let i = 0; i < totalBars; i++) {
        const bx = -184 + i * 6.3;
        const amp =
          (Math.sin(i * 0.65 + p * 8) * 0.45 + Math.cos(i * 1.3) * 0.35 + 0.35) *
          (i % 9 === 0 ? 18 : 56);
        const hBar = Math.max(6, Math.min(62, amp));
        ctx.fillStyle = i <= activeBars ? brand.primaryColor : "rgba(148,163,184,0.25)";
        ctx.fillRect(bx, 17 - hBar, 3.6, hBar * 2);
      }

      const timingTags = ["hook 4.2s", "body 11.8s", "proof 9.4s", "cta 5.6s"];
      timingTags.forEach((tag, idx) => {
        const tx = -196 + idx * 100;
        ctx.fillStyle = "rgba(30, 41, 59, 0.95)";
        ctx.strokeStyle = "rgba(255,255,255,0.15)";
        ctx.beginPath();
        ctx.roundRect(tx, 112, 92, 34, 8);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#E2E8F0";
        ctx.font = `600 14px ${monoFont}`;
        ctx.textAlign = "center";
        ctx.fillText(tag, tx + 46, 134);
      });
    } else if (boardStyle === "lufs-meter") {
      // Big LUFS readout + Voice vs BGM db bars (Ref 2 Step 8/9)
      const lufsVal = (-32 + clamp01(p / 0.45) * 16.6).toFixed(1);
      ctx.fillStyle = "#FFFFFF";
      ctx.font = `900 58px ${font}`;
      ctx.textAlign = "left";
      ctx.fillText(lufsVal, -200, -10);
      ctx.fillStyle = "#94A3B8";
      ctx.font = `700 22px ${monoFont}`;
      ctx.fillText("LUFS", -24, -10);

      // Meter bar 1: Voice
      const bar1 = clamp01((p - 0.1) / 0.45);
      ctx.fillStyle = "#E2E8F0";
      ctx.font = `700 18px ${font}`;
      ctx.fillText("เสียงพูด (ชัดสุด)", -200, 38);
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath();
      ctx.roundRect(-45, 22, 240, 18, 9);
      ctx.fill();
      ctx.fillStyle = brand.primaryColor;
      ctx.beginPath();
      ctx.roundRect(-45, 22, 210 * bar1, 18, 9);
      ctx.fill();

      // Meter bar 2: BGM -10 dB
      ctx.fillStyle = "#94A3B8";
      ctx.fillText("เพลงประกอบ -10 dB", -200, 82);
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath();
      ctx.roundRect(-45, 66, 240, 14, 7);
      ctx.fill();
      ctx.fillStyle = "#64748B";
      ctx.beginPath();
      ctx.roundRect(-45, 66, 115 * bar1, 14, 7);
      ctx.fill();

      // Bottom highlight banner inside card
      if (p > 0.28) {
        const bp = easeOutBack(clamp01((p - 0.28) / 0.18));
        ctx.save();
        ctx.translate(0, 142);
        ctx.scale(bp, bp);
        ctx.fillStyle = brand.primaryColor;
        ctx.beginPath();
        ctx.roundRect(-196, -22, 392, 44, 10);
        ctx.fill();
        ctx.fillStyle = "#090D16";
        ctx.font = `800 19px ${font}`;
        ctx.textAlign = "center";
        ctx.fillText("เสียงพูดชัดสุด · เอฟเฟกต์ลงตรงจังหวะภาพ", 0, 7);
        ctx.restore();
      }
    } else if (boardStyle === "pronounce-map") {
      // Left -> Right pills (Ref 2 Step 3/9)
      const pairs = [
        ["Hook 3 วิแรก", "เปิดด้วยภาพคำตอบ"],
        ["Brand CI", "ล็อกสี #38BDF8 อัตโนมัติ"],
        ["Subtitles", "กระชับ ไม่ตกบรรทัด"],
        ["Motion 60fps", "ขยับตรงจังหวะเสียงพูด"],
      ];
      pairs.forEach(([left, right], idx) => {
        const at = 0.08 + idx * 0.14;
        if (p < at) return;
        const rp = easeOutBack(clamp01((p - at) / 0.16));
        const y = -40 + idx * 54;
        ctx.save();
        ctx.translate(0, y);
        ctx.scale(rp, rp);

        ctx.fillStyle = "#263248";
        ctx.strokeStyle = "rgba(255,255,255,0.16)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(-200, -20, 148, 40, 10);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = "#F8FAFC";
        ctx.font = `700 16px ${monoFont}`;
        ctx.textAlign = "center";
        ctx.fillText(left, -126, 6);

        ctx.fillStyle = brand.primaryColor;
        ctx.font = `900 20px ${font}`;
        ctx.fillText("→", -30, 7);

        ctx.fillStyle = "#FFFFFF";
        ctx.font = `800 19px ${font}`;
        ctx.textAlign = "left";
        ctx.fillText(trimPhraseAtWordBoundary(items[idx] ?? right, 20), -6, 7);
        ctx.restore();
      });
    } else if (boardStyle === "code-editor") {
      // React / Remotion code snippet + bottom highlight pill (Ref 2 Step 6/9)
      const codeLines = props.codeLines ?? [
        "<MotionBrollScene",
        "  themeId='cue-step-board'",
        "  brandCi={{ primary: '#38BDF8' }}",
        "  mascot='ai-bot'",
        "  syncToWordCues={true}",
        "/>",
      ];
      codeLines.forEach((line, idx) => {
        const at = 0.05 + idx * 0.08;
        if (p < at) return;
        ctx.fillStyle = idx === 1 || idx === 2 ? brand.primaryColor : "#E2E8F0";
        ctx.font = `500 15.5px ${monoFont}`;
        ctx.textAlign = "left";
        ctx.fillText(line, -196, -42 + idx * 28);
      });

      if (p > 0.3) {
        const bp = easeOutBack(clamp01((p - 0.3) / 0.18));
        ctx.save();
        ctx.translate(0, 146);
        ctx.scale(bp, bp);
        ctx.fillStyle = brand.primaryColor;
        ctx.beginPath();
        ctx.roundRect(-196, -22, 392, 44, 10);
        ctx.fill();
        ctx.fillStyle = "#090D16";
        ctx.font = `800 17.5px ${font}`;
        ctx.textAlign = "center";
        ctx.fillText("Remotion + Brand CI = วาดด้วยโค้ดทุกเฟรม", 0, 7);
        ctx.restore();
      }
    } else if (boardStyle === "contact-sheet-qa") {
      // 4x2 Thumbnail QA Grid with green checkmarks (Ref 2 Step 9/9)
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 4; c++) {
          const idx = r * 4 + c;
          const at = 0.06 + idx * 0.06;
          if (p < at) continue;
          const cp = easeOutBack(clamp01((p - at) / 0.14));
          const gx = -196 + c * 100;
          const gy = -54 + r * 114;
          ctx.save();
          ctx.translate(gx + 44, gy + 50);
          ctx.scale(cp, cp);
          ctx.fillStyle = idx % 2 === 0 ? "#1E293B" : "#0F172A";
          ctx.strokeStyle = hexToRgba(brand.primaryColor, 0.55);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect(-44, -50, 88, 100, 8);
          ctx.fill();
          ctx.stroke();

          // Mini preview bars inside thumbnail
          ctx.fillStyle = brand.primaryColor;
          ctx.fillRect(-32, -34, 48, 8);
          ctx.fillStyle = "rgba(255,255,255,0.25)";
          ctx.fillRect(-32, -18, 64, 6);
          ctx.fillRect(-32, -6, 52, 6);

          // Check badge
          ctx.fillStyle = brand.primaryColor;
          ctx.beginPath();
          ctx.arc(28, 34, 10, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#090D16";
          ctx.font = `900 12px ${font}`;
          ctx.textAlign = "center";
          ctx.fillText("✓", 28, 38);
          ctx.restore();
        }
      }
    } else if (boardStyle === "script-table") {
      // Structured Script Rows (hook / problem / solution / cta) (Ref 2 Step 2/9)
      const rows = [
        ["hook", items[0] ?? "เปิดด้วยภาพคำตอบใน 3 วิแรก"],
        ["pain", items[1] ?? "ทำไมคนเลื่อนผ่านคลิปที่เปิดช้า"],
        ["brand", items[2] ?? "ล็อกสีและสไตล์ประจำช่องให้จำง่าย"],
        ["cta", "ปิดด้วยคำถามให้คนคอมเมนต์ MEW"],
      ];
      rows.forEach(([tag, desc], idx) => {
        const at = 0.08 + idx * 0.14;
        if (p < at) return;
        const y = -36 + idx * 54;
        ctx.fillStyle = brand.primaryColor;
        ctx.font = `700 17px ${monoFont}`;
        ctx.textAlign = "left";
        ctx.fillText(tag, -196, y);

        ctx.fillStyle = "#F8FAFC";
        ctx.font = `600 19px ${font}`;
        ctx.fillText(trimPhraseAtWordBoundary(desc, 25), -118, y);

        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.beginPath();
        ctx.moveTo(-196, y + 18);
        ctx.lineTo(196, y + 18);
        ctx.stroke();
      });
    } else {
      // terminal-spec (Ref 2 Step 1/9: Fact check + checklist pills)
      ctx.fillStyle = "#CBD5E1";
      ctx.font = `500 16px ${monoFont}`;
      ctx.textAlign = "left";
      ctx.fillText("@ Channel Audit: mewsocial (duckyhero)", -196, -44);
      ctx.fillStyle = "#FFFFFF";
      ctx.font = `700 16px ${monoFont}`;
      ctx.fillText("### 1. Brand CI Palette & Hook Cadence", -196, -16);
      ctx.fillStyle = brand.primaryColor;
      ctx.fillText("    VERIFIED  ·  #38BDF8 / Kanit", -196, 10);

      items.slice(0, 2).forEach((item, idx) => {
        const at = 0.22 + idx * 0.18;
        if (p < at) return;
        const ip = easeOutBack(clamp01((p - at) / 0.16));
        const y = 62 + idx * 58;
        ctx.save();
        ctx.translate(0, y);
        ctx.scale(ip, ip);
        drawCard(-196, -22, 392, 46, "rgba(15, 23, 42, 0.9)", 12, hexToRgba(brand.primaryColor, 0.45), 2);
        ctx.fillStyle = brand.primaryColor;
        ctx.beginPath();
        ctx.roundRect(-182, -12, 26, 26, 6);
        ctx.fill();
        ctx.fillStyle = "#090D16";
        ctx.font = `900 16px ${font}`;
        ctx.textAlign = "center";
        ctx.fillText("✓", -169, 7);

        ctx.fillStyle = "#FFFFFF";
        ctx.font = `700 20px ${font}`;
        ctx.textAlign = "left";
        ctx.fillText(trimPhraseAtWordBoundary(item, 24), -142, 7);
        ctx.restore();
      });
    }

    ctx.restore();

    // 2. Studio Desk + Lamp + Brand-colored Mug + Keyboard + Drawers at bottom (Ref 2 exact layout)
    const deskTopY = 760;

    // Desk Lamp on left
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
    // Lamp head
    ctx.fillStyle = "#64748B";
    ctx.beginPath();
    ctx.arc(104, 642, 22, Math.PI * 0.85, Math.PI * 2.15);
    ctx.fill();
    ctx.restore();

    // Presenter Mascot centered behind the desk (with glowing rim outline like Ref 2)
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

    // Stacking Step Pills on right side above the desk (Ref 2 signature progression stack)
    const stackLabels = props.stackLabels ?? ["ไอเดีย", "บท", "ซับ", "Brand CI"];
    stackLabels.slice(0, 8).forEach((lbl, idx) => {
      const sy = deskTopY - 26 - idx * 28;
      const isTop = idx === stackLabels.length - 1;
      const pop = isTop ? easeOutBack(clamp01((p - 0.1) / 0.2)) : 1;
      const pillColor =
        isTop
          ? brand.primaryColor
          : STACK_PILL_PALETTE[idx % STACK_PILL_PALETTE.length];
      ctx.save();
      ctx.translate(454, sy);
      ctx.scale(pop, pop);
      ctx.fillStyle = pillColor;
      ctx.strokeStyle = "#0F172A";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.roundRect(-52, -12, 104, 24, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#090D16";
      ctx.font = `800 14px ${font}`;
      ctx.textAlign = "center";
      ctx.fillText(trimPhraseAtWordBoundary(lbl, 10), 0, 5);
      ctx.restore();
    });

    // Coffee Mug in Brand Primary Color on left of keyboard
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

    // Desk Surface & Drawers
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

    // Keyboard centered on desk edge
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

    // Two Desk Drawers
    const drawDrawer = (dx: number) => {
      ctx.fillStyle = "#3D2D20";
      ctx.strokeStyle = "#271C15";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(dx, deskTopY + 38, 195, 92, 10);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#A89F91";
      ctx.beginPath();
      ctx.roundRect(dx + 76, deskTopY + 80, 42, 8, 4);
      ctx.fill();
    };
    drawDrawer(38);
    drawDrawer(bw - 233);
  } else if (config.themeId === "paper-cutout-doc") {
    // ── THEME C: PAPER CUTOUT DOCUMENTARY (Vox / Johnny Harris Editorial Collage) ──
    // Craft paper / vintage newsprint grid + torn edges + masking tape + live highlighter sweep
    ctx.fillStyle = "#EAE2D3";
    ctx.fillRect(0, 0, bw, bh);

    // Subtle editorial rule lines & micro-grain dots
    ctx.strokeStyle = "rgba(120, 108, 90, 0.14)";
    ctx.lineWidth = 1;
    for (let y = 40; y < bh; y += 36) {
      ctx.beginPath();
      ctx.moveTo(24, y);
      ctx.lineTo(bw - 24, y);
      ctx.stroke();
    }
    for (let x = 36; x < bw; x += 54) {
      ctx.beginPath();
      ctx.moveTo(x, 24);
      ctx.lineTo(x, bh - 24);
      ctx.stroke();
    }

    // Helper: Torn-edge newspaper clipping card with masking tape
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

      // Deep collage drop shadow
      ctx.fillStyle = "rgba(28, 25, 23, 0.24)";
      ctx.beginPath();
      ctx.roundRect(-w / 2 + 7, -h / 2 + 10, w, h, 4);
      ctx.fill();

      // Main paper body with jagged torn bottom edge
      ctx.fillStyle = paperColor;
      ctx.strokeStyle = "#292524";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(-w / 2, -h / 2);
      ctx.lineTo(w / 2, -h / 2);
      ctx.lineTo(w / 2, h / 2 - 8);
      const zigSteps = 18;
      for (let i = zigSteps; i >= 0; i--) {
        const zx = -w / 2 + (w * i) / zigSteps;
        const zy = h / 2 - (i % 2 === 0 ? 8 : 0);
        ctx.lineTo(zx, zy);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Translucent masking tape at top center
      if (showTape) {
        ctx.save();
        ctx.translate(0, -h / 2 - 2);
        ctx.rotate(-0.04);
        ctx.fillStyle = "rgba(234, 215, 167, 0.82)";
        ctx.strokeStyle = "rgba(120, 102, 68, 0.45)";
        ctx.lineWidth = 1.5;
        ctx.fillRect(-58, -13, 116, 26);
        ctx.strokeRect(-58, -13, 116, 26);
        ctx.restore();
      }
      ctx.restore();
    };

    // Top Editorial Masthead Tag
    const headerTag = trimPhraseAtWordBoundary(props.headerText ?? "INVESTIGATION FILE", 22);
    ctx.save();
    ctx.translate(bw / 2, 74);
    ctx.rotate(-0.015);
    ctx.fillStyle = "#1C1917";
    ctx.fillRect(-195, -22, 390, 44);
    ctx.fillStyle = "#FAF6EE";
    ctx.font = `900 18px ${monoFont}`;
    ctx.textAlign = "center";
    ctx.fillText(`📰  ${headerTag}  ·  DOC #2026`, 0, 6);
    ctx.restore();

    const items =
      props.items && props.items.length > 0
        ? props.items
        : ["คนดูตัดสินใน 3 วินาทีแรก", "เปิดคลิปช้า = คนปัดทิ้ง 78%", "ต้องขึ้นคำตอบตั้งแต่ประโยคแรก"];

    if (config.templateId === "paper.evidence-dossier") {
      // 2 Polaroid Evidence Frames connected by Red Investigation String + Pushpins
      const p1 = easeOutBack(clamp01((p - 0.04) / 0.18));
      const p2 = easeOutBack(clamp01((p - 0.18) / 0.18));

      // Polaroid 1 (Left-Top)
      ctx.save();
      ctx.translate(158, 290);
      ctx.scale(p1, p1);
      ctx.rotate(-0.055);
      ctx.fillStyle = "rgba(28, 25, 23, 0.25)";
      ctx.fillRect(-108 + 6, -124 + 8, 216, 248);
      ctx.fillStyle = "#FFFFFF";
      ctx.strokeStyle = "#1C1917";
      ctx.lineWidth = 3;
      ctx.fillRect(-108, -124, 216, 248);
      ctx.strokeRect(-108, -124, 216, 248);

      // Dark archival photo area inside Polaroid 1
      ctx.fillStyle = "#1E293B";
      ctx.fillRect(-92, -106, 184, 152);
      // Red declining retention graph inside photo
      ctx.strokeStyle = "#EF4444";
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(-74, -76);
      ctx.lineTo(-22, -52);
      ctx.lineTo(18, -14);
      ctx.lineTo(74, 24);
      ctx.stroke();
      ctx.fillStyle = "#F8FAFC";
      ctx.font = `800 15px ${monoFont}`;
      ctx.textAlign = "left";
      ctx.fillText("RETENTION: 22%", -78, -82);

      // Caption on Polaroid bottom
      ctx.fillStyle = "#1C1917";
      ctx.font = `900 20px ${font}`;
      ctx.textAlign = "center";
      ctx.fillText(trimPhraseAtWordBoundary(props.leftText ?? "คลิปทั่วไป: เกริ่นยาว", 18), 0, 82);
      ctx.fillStyle = "#DC2626";
      ctx.font = `800 16px ${font}`;
      ctx.fillText("❌ คนปัดทิ้งตั้งแต่ 3 วิแรก", 0, 106);

      // Red Pushpin
      ctx.fillStyle = "#DC2626";
      ctx.beginPath();
      ctx.arc(0, -116, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // Polaroid 2 (Right-Bottom)
      if (p > 0.16) {
        ctx.save();
        ctx.translate(382, 435);
        ctx.scale(p2, p2);
        ctx.rotate(0.045);
        ctx.fillStyle = "rgba(28, 25, 23, 0.25)";
        ctx.fillRect(-108 + 6, -124 + 8, 216, 248);
        ctx.fillStyle = "#FFFFFF";
        ctx.strokeStyle = "#1C1917";
        ctx.lineWidth = 3;
        ctx.fillRect(-108, -124, 216, 248);
        ctx.strokeRect(-108, -124, 216, 248);

        ctx.fillStyle = "#0F172A";
        ctx.fillRect(-92, -106, 184, 152);
        // Rising Brand CI retention bar inside photo
        ctx.strokeStyle = brand.primaryColor;
        ctx.lineWidth = 5.5;
        ctx.beginPath();
        ctx.moveTo(-74, 18);
        ctx.lineTo(-22, -26);
        ctx.lineTo(24, -44);
        ctx.lineTo(74, -82);
        ctx.stroke();
        ctx.fillStyle = brand.accentColor || "#FACC15";
        ctx.font = `800 15px ${monoFont}`;
        ctx.textAlign = "left";
        ctx.fillText("HOOK LOCKED: +310%", -78, 34);

        ctx.fillStyle = "#1C1917";
        ctx.font = `900 20px ${font}`;
        ctx.textAlign = "center";
        ctx.fillText(trimPhraseAtWordBoundary(props.rightText ?? "เปิดด้วยคำตอบ + ภาพขยับ", 18), 0, 82);
        ctx.fillStyle = "#15803D";
        ctx.font = `800 16px ${font}`;
        ctx.fillText("✓ หยุดนิ้วคนดูได้ทันที", 0, 106);

        // Red Pushpin
        ctx.fillStyle = "#DC2626";
        ctx.beginPath();
        ctx.arc(0, -116, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      // Red Investigation String connecting the two pushpins
      if (p > 0.28) {
        const sp = clamp01((p - 0.28) / 0.22);
        ctx.save();
        ctx.strokeStyle = "#DC2626";
        ctx.lineWidth = 4;
        ctx.setLineDash([8, 4]);
        ctx.beginPath();
        ctx.moveTo(158, 174);
        ctx.quadraticCurveTo(270, 265, 158 + (382 - 158) * sp, 174 + (319 - 174) * sp);
        ctx.stroke();
        ctx.restore();
      }

      // Bottom Torn Dossier Summary Note
      if (p > 0.36) {
        const np = easeOutBack(clamp01((p - 0.36) / 0.18));
        ctx.save();
        ctx.translate(bw / 2, 645);
        ctx.scale(np, np);
        drawPaperClipping(0, 0, 448, 118, -0.012, "#FEF9C3", true);
        ctx.fillStyle = "#1C1917";
        ctx.font = `900 24px ${font}`;
        ctx.textAlign = "center";
        ctx.fillText(trimPhraseAtWordBoundary(props.title ?? "หลักฐานเปรียบเทียบชัด", 22), 0, -12);
        ctx.fillStyle = "#DC2626";
        ctx.font = `800 20px ${font}`;
        ctx.fillText(trimPhraseAtWordBoundary(props.badgeText ?? "พิสูจน์แล้วจากดาต้าจริง", 24), 0, 26);
        ctx.restore();
      }
    } else if (config.templateId === "paper.quote-stamp") {
      // Editorial Cutout Quote + Slamming Rubber Stamp
      const clipEnter = easeOutBack(clamp01(p / 0.18));
      ctx.save();
      ctx.translate(bw / 2, 330);
      ctx.scale(clipEnter, clipEnter);
      drawPaperClipping(0, 0, 456, 340, -0.02, "#FAF6EE", true);

      // Giant serif quotation marks
      ctx.fillStyle = "rgba(220, 38, 38, 0.18)";
      ctx.font = `900 120px Georgia, serif`;
      ctx.textAlign = "left";
      ctx.fillText("“", -204, -52);

      // Highlighted Quote Headline
      const hlSweep = clamp01((p - 0.14) / 0.32);
      ctx.fillStyle = "rgba(250, 204, 21, 0.78)";
      ctx.fillRect(-190, -82, 380 * hlSweep, 46);

      ctx.fillStyle = "#1C1917";
      ctx.font = `900 29px ${font}`;
      ctx.textAlign = "center";
      ctx.fillText(trimPhraseAtWordBoundary(props.title ?? "กฏเหล็กของช่องที่โตไว", 22), 0, -48);

      items.slice(0, 2).forEach((line, idx) => {
        ctx.fillStyle = "#292524";
        ctx.font = `700 22px ${font}`;
        ctx.fillText(`• ${trimPhraseAtWordBoundary(line, 24)}`, 0, 12 + idx * 44);
      });
      ctx.restore();

      // Rubber Stamp Slam Effect (scales from 2.4x -> 1.0x with ink border)
      if (p > 0.34) {
        const rawStamp = clamp01((p - 0.34) / 0.14);
        const stampScale = rawStamp < 1 ? 2.2 - 1.2 * rawStamp : 1.0;
        ctx.save();
        ctx.translate(bw / 2 + 78, 535);
        ctx.rotate(-0.18);
        ctx.scale(stampScale, stampScale);

        ctx.fillStyle = "rgba(254, 242, 242, 0.92)";
        ctx.strokeStyle = "#DC2626";
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.roundRect(-142, -44, 284, 88, 10);
        ctx.fill();
        ctx.stroke();

        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.roundRect(-132, -34, 264, 68, 6);
        ctx.stroke();

        ctx.fillStyle = "#DC2626";
        ctx.font = `900 28px ${font}`;
        ctx.textAlign = "center";
        ctx.fillText(trimPhraseAtWordBoundary(props.badgeText ?? "APPROVED · ทำตามได้ทันที", 18), 0, 10);
        ctx.restore();
      }
    } else {
      // Default: paper.headline-highlighter (Vox Newspaper Clipping + Live Yellow Highlighter Sweep)
      const clipEnter = easeOutBack(clamp01(p / 0.16));
      ctx.save();
      ctx.translate(bw / 2, 355);
      ctx.scale(clipEnter, clipEnter);
      drawPaperClipping(0, 0, 464, 420, -0.018, "#FAF6EE", true);

      // Newspaper metadata header
      ctx.fillStyle = "#57534E";
      ctx.font = `700 14px ${monoFont}`;
      ctx.textAlign = "left";
      ctx.fillText("THE CREATOR TIMES  ·  SPECIAL REPORT", -202, -162);
      ctx.strokeStyle = "#1C1917";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-202, -146);
      ctx.lineTo(202, -146);
      ctx.stroke();

      // Main Headline with Live Yellow Marker Sweep
      const sweep1 = clamp01((p - 0.12) / 0.28);
      ctx.fillStyle = "rgba(250, 204, 21, 0.85)";
      ctx.beginPath();
      ctx.roundRect(-204, -126, 408 * sweep1, 54, 6);
      ctx.fill();

      ctx.fillStyle = "#1C1917";
      ctx.font = `900 30px ${font}`;
      ctx.textAlign = "left";
      ctx.fillText(trimPhraseAtWordBoundary(props.title ?? "ทำไมคนเลื่อนผ่านใน 3 วิแรก?", 22), -194, -88);

      // Sub-items with progressive marker sweeps & red editorial underlines
      items.slice(0, 3).forEach((item, idx) => {
        const at = 0.22 + idx * 0.15;
        if (p < at) return;
        const rowSweep = clamp01((p - at) / 0.22);
        const y = -18 + idx * 74;

        // Faux newspaper body lines in background
        ctx.fillStyle = "rgba(168, 162, 158, 0.28)";
        ctx.fillRect(-194, y - 24, 388, 8);
        ctx.fillRect(-194, y + 22, 310, 8);

        // Live Highlighter strip on key phrase
        ctx.fillStyle = idx === 1 ? hexToRgba(brand.primaryColor, 0.32) : "rgba(253, 224, 71, 0.78)";
        ctx.fillRect(-196, y - 18, 392 * rowSweep, 38);

        ctx.fillStyle = "#1C1917";
        ctx.font = `800 22px ${font}`;
        ctx.textAlign = "left";
        ctx.fillText(`${idx + 1}. ${trimPhraseAtWordBoundary(item, 24)}`, -186, y + 8);

        // Hand-drawn Red Pen Underline on last item
        if (idx === 2 && rowSweep > 0.5) {
          ctx.strokeStyle = "#DC2626";
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.moveTo(-186, y + 18);
          ctx.quadraticCurveTo(0, y + 24, -186 + 360 * rowSweep, y + 16);
          ctx.stroke();
        }
      });
      ctx.restore();

      // Bottom Red Editorial Badge
      if (p > 0.45) {
        const bp = easeOutBack(clamp01((p - 0.45) / 0.16));
        ctx.save();
        ctx.translate(bw / 2, 628);
        ctx.scale(bp, bp);
        ctx.rotate(0.02);
        drawCard(-155, -26, 310, 52, "#DC2626", 10, "#1C1917", 3.5);
        ctx.fillStyle = "#FFFFFF";
        ctx.font = `900 21px ${font}`;
        ctx.textAlign = "center";
        ctx.fillText(trimPhraseAtWordBoundary(props.badgeText ?? "KEY FINDING · อินไซต์สำคัญ", 22), 0, 8);
        ctx.restore();
      }
    }
  } else if (config.themeId === "social-chat-sim") {
    // ── THEME D: SOCIAL CHAT & NOTIFICATION SIMULATOR (Modern Mobile Glass UI) ──
    const bgGrad = ctx.createLinearGradient(0, 0, 0, bh);
    bgGrad.addColorStop(0, "#090D16");
    bgGrad.addColorStop(0.5, "#0F172A");
    bgGrad.addColorStop(1, "#090D16");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, bw, bh);

    // Dual Brand CI ambient glow orbs
    const orb1 = ctx.createRadialGradient(120, 220, 10, 120, 220, 260);
    orb1.addColorStop(0, hexToRgba(brand.primaryColor, 0.28));
    orb1.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = orb1;
    ctx.fillRect(0, 0, bw, bh);

    const orb2 = ctx.createRadialGradient(420, 520, 10, 420, 520, 260);
    orb2.addColorStop(0, hexToRgba(brand.accentColor, 0.22));
    orb2.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = orb2;
    ctx.fillRect(0, 0, bw, bh);

    const items =
      props.items && props.items.length > 0
        ? props.items
        : [
            "พี่ครับ ทำไมลงคลิปทุกวันแต่ยอดวิวนิ่ง?",
            "เพราะ 3 วิแรกยังไม่ได้บอกคำตอบที่คนดูอยากรู้ครับ",
            "ลองเปลี่ยนมาเปิดด้วยผลลัพธ์ + ซับคำสำคัญดูครับ 🔥",
          ];

    // Frosted Phone Container Frame (top & center area, leaving bottom for subtitles)
    const frameEnter = easeOutBack(clamp01(p / 0.14));
    ctx.save();
    ctx.translate(bw / 2, 355);
    ctx.scale(frameEnter, frameEnter);

    // Glass phone shell
    ctx.fillStyle = "rgba(15, 23, 42, 0.84)";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.roundRect(-236, -295, 472, 575, 34);
    ctx.fill();
    ctx.stroke();

    // Top Dynamic Island + Status Header
    ctx.fillStyle = "#020617";
    ctx.beginPath();
    ctx.roundRect(-62, -278, 124, 24, 12);
    ctx.fill();

    // Profile Header Bar inside phone
    ctx.fillStyle = "rgba(30, 41, 59, 0.75)";
    ctx.beginPath();
    ctx.roundRect(-216, -240, 432, 64, 18);
    ctx.fill();

    // Avatar Circle with Brand Ring + Online Dot
    ctx.fillStyle = brand.primaryColor;
    ctx.beginPath();
    ctx.arc(-176, -208, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#090D16";
    ctx.font = `900 18px ${font}`;
    ctx.textAlign = "center";
    ctx.fillText("M", -176, -201);

    ctx.fillStyle = "#22C55E";
    ctx.beginPath();
    ctx.arc(-159, -192, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#F8FAFC";
    ctx.font = `800 20px ${font}`;
    ctx.textAlign = "left";
    ctx.fillText(trimPhraseAtWordBoundary(props.title ?? "Mew Social Studio", 22), -142, -212);
    ctx.fillStyle = brand.primaryColor;
    ctx.font = `600 14px ${monoFont}`;
    ctx.fillText(trimPhraseAtWordBoundary(props.headerText ?? "ACTIVE NOW · VERIFIED", 26), -142, -190);

    if (config.templateId === "chat.notification-stack") {
      // Stacked iOS Glass Notification Banners cascading in with spring physics
      items.slice(0, 3).forEach((alertText, idx) => {
        const at = 0.08 + idx * 0.16;
        if (p < at) return;
        const np = easeOutBack(clamp01((p - at) / 0.18));
        const y = -118 + idx * 112;
        ctx.save();
        ctx.translate(0, y);
        ctx.scale(np, np);

        ctx.fillStyle = idx === 2 ? hexToRgba(brand.primaryColor, 0.22) : "rgba(30, 41, 59, 0.92)";
        ctx.strokeStyle = idx === 2 ? brand.primaryColor : "rgba(255, 255, 255, 0.16)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(-208, -44, 416, 92, 20);
        ctx.fill();
        ctx.stroke();

        // App Icon Badge
        ctx.fillStyle = idx === 0 ? "#EF4444" : idx === 1 ? "#F59E0B" : brand.primaryColor;
        ctx.beginPath();
        ctx.roundRect(-190, -24, 48, 48, 12);
        ctx.fill();
        ctx.fillStyle = "#090D16";
        ctx.font = `900 22px ${font}`;
        ctx.textAlign = "center";
        ctx.fillText(idx === 0 ? "!" : idx === 1 ? "⚡" : "✓", -166, 8);

        // Notification Title + Timestamp
        ctx.fillStyle = "#94A3B8";
        ctx.font = `700 13px ${monoFont}`;
        ctx.textAlign = "left";
        ctx.fillText(idx === 2 ? "BRAND CI SYSTEM · NOW" : `ANALYTICS ALERT · ${idx + 1}m ago`, -128, -14);

        ctx.fillStyle = "#FFFFFF";
        ctx.font = `800 20px ${font}`;
        ctx.fillText(trimPhraseAtWordBoundary(alertText, 25), -128, 18);
        ctx.restore();
      });
    } else if (config.templateId === "chat.viral-comment-reply") {
      // Pinned Creator Comment Card + Auto-Reply DM Input Box
      const c1 = easeOutBack(clamp01((p - 0.06) / 0.16));
      ctx.save();
      ctx.translate(0, -88);
      ctx.scale(c1, c1);
      ctx.fillStyle = "rgba(30, 41, 59, 0.95)";
      ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(-208, -64, 416, 128, 22);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#F43F5E";
      ctx.beginPath();
      ctx.roundRect(-190, -48, 128, 26, 8);
      ctx.fill();
      ctx.fillStyle = "#FFFFFF";
      ctx.font = `800 13px ${font}`;
      ctx.textAlign = "center";
      ctx.fillText("📌 คอมเมนต์ปักหมุด", -126, -30);

      ctx.fillStyle = "#FFFFFF";
      ctx.font = `800 22px ${font}`;
      ctx.textAlign = "left";
      ctx.fillText(trimPhraseAtWordBoundary(items[0] ?? "อยากได้เทมเพลตนี้ ต้องทำยังไงครับ?", 24), -190, 8);
      ctx.fillStyle = "#94A3B8";
      ctx.font = `600 15px ${font}`;
      ctx.fillText("❤️ 1.4K   ·   ดูการตอบกลับของครีเอเตอร์", -190, 40);
      ctx.restore();

      // Creator Auto-Reply Bubble with Typewriter Keyword
      if (p > 0.22) {
        const c2 = easeOutBack(clamp01((p - 0.22) / 0.18));
        const kw = props.rightText ?? "MEW";
        ctx.save();
        ctx.translate(0, 78);
        ctx.scale(c2, c2);
        ctx.fillStyle = brand.primaryColor;
        ctx.beginPath();
        ctx.roundRect(-208, -56, 416, 112, 24);
        ctx.fill();

        ctx.fillStyle = "#090D16";
        ctx.font = `900 32px ${font}`;
        ctx.textAlign = "center";
        ctx.fillText(`💬 พิมพ์คอมเมนต์ "${kw}"`, 0, -4);
        ctx.font = `800 19px ${font}`;
        ctx.fillText(trimPhraseAtWordBoundary(props.badgeText ?? "ส่งลิงก์ให้ใน DM ทันที ⚡", 24), 0, 32);
        ctx.restore();
      }
    } else {
      // Default: chat.dm-conversation (Incoming & Outgoing Chat Bubbles + Typing Indicator + Emoji Reactions)
      // Bubble 1 (Incoming Left)
      if (p > 0.05) {
        const b1 = easeOutBack(clamp01((p - 0.05) / 0.16));
        ctx.save();
        ctx.translate(-18, -118);
        ctx.scale(b1, b1);
        ctx.fillStyle = "#1E293B";
        ctx.strokeStyle = "rgba(255,255,255,0.12)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(-194, -38, 368, 76, 20);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = "#F8FAFC";
        ctx.font = `700 20px ${font}`;
        ctx.textAlign = "left";
        ctx.fillText(trimPhraseAtWordBoundary(items[0] ?? "ทำไมลงคลิปทุกวันแต่คนเลื่อนผ่าน?", 24), -174, 7);
        ctx.restore();
      }

      // Bubble 2 (Outgoing Right - Brand Primary Color)
      if (p > 0.2) {
        const b2 = easeOutBack(clamp01((p - 0.2) / 0.16));
        ctx.save();
        ctx.translate(18, -12);
        ctx.scale(b2, b2);
        ctx.fillStyle = brand.primaryColor;
        ctx.beginPath();
        ctx.roundRect(-174, -42, 368, 84, 22);
        ctx.fill();

        ctx.fillStyle = "#090D16";
        ctx.font = `800 20px ${font}`;
        ctx.textAlign = "left";
        ctx.fillText(trimPhraseAtWordBoundary(items[1] ?? "เพราะ 3 วิแรกยังไม่ได้ขึ้นคำตอบครับ", 24), -154, 7);
        ctx.restore();
      }

      // Bubble 3 (Outgoing Right + Emoji Reaction Pill)
      if (p > 0.36) {
        const b3 = easeOutBack(clamp01((p - 0.36) / 0.16));
        ctx.save();
        ctx.translate(18, 98);
        ctx.scale(b3, b3);
        ctx.fillStyle = "rgba(30, 41, 59, 0.95)";
        ctx.strokeStyle = brand.primaryColor;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.roundRect(-174, -42, 368, 84, 22);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = "#FFFFFF";
        ctx.font = `800 20px ${font}`;
        ctx.textAlign = "left";
        ctx.fillText(trimPhraseAtWordBoundary(items[2] ?? "เปิดด้วยภาพคำตอบ + ซับคำสำคัญ 🔥", 24), -154, 7);

        // Floating Emoji Reaction Pill
        ctx.fillStyle = "#0F172A";
        ctx.strokeStyle = "rgba(255,255,255,0.22)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(102, 26, 82, 32, 16);
        ctx.fill();
        ctx.stroke();
        ctx.font = `700 15px ${font}`;
        ctx.textAlign = "center";
        ctx.fillText("🔥 ❤️ 99+", 143, 47);
        ctx.restore();
      }

      // Live Typing Indicator Pill at bottom of chat
      const dotBounce = (idx: number) => Math.sin(p * Math.PI * 8 + idx * 1.1) * 4;
      ctx.save();
      ctx.translate(-138, 212);
      ctx.fillStyle = "#1E293B";
      ctx.beginPath();
      ctx.roundRect(-54, -20, 108, 40, 20);
      ctx.fill();
      for (let d = 0; d < 3; d++) {
        ctx.fillStyle = d === 1 ? brand.primaryColor : "#94A3B8";
        ctx.beginPath();
        ctx.arc(-22 + d * 22, dotBounce(d), 5.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.restore();
  } else if (config.themeId === "apple-bento-glass") {
    // ── THEME E: APPLE BENTO GRID / GLASSMORPHISM (Keynote Frosted Glass + Specular Rim) ──
    const bgGrad = ctx.createLinearGradient(0, 0, bw, bh);
    bgGrad.addColorStop(0, "#050811");
    bgGrad.addColorStop(0.5, "#0B1120");
    bgGrad.addColorStop(1, "#090D16");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, bw, bh);

    // Ambient Mesh Gradient Orbs behind frosted Bento cards
    const mesh1 = ctx.createRadialGradient(140, 210, 10, 140, 210, 280);
    mesh1.addColorStop(0, hexToRgba(brand.primaryColor, 0.34));
    mesh1.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = mesh1;
    ctx.fillRect(0, 0, bw, bh);

    const mesh2 = ctx.createRadialGradient(410, 480, 10, 410, 480, 280);
    mesh2.addColorStop(0, hexToRgba(brand.accentColor, 0.28));
    mesh2.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = mesh2;
    ctx.fillRect(0, 0, bw, bh);

    // Helper: Frosted Apple Bento Tile with Specular Top Rim Highlight
    const drawBentoTile = (
      x: number,
      y: number,
      w: number,
      h: number,
      activeGlow = false,
      radius = 26,
    ) => {
      ctx.save();
      ctx.fillStyle = "rgba(0, 0, 0, 0.42)";
      ctx.beginPath();
      ctx.roundRect(x + 4, y + 10, w, h, radius);
      ctx.fill();

      const tileGrad = ctx.createLinearGradient(x, y, x, y + h);
      if (activeGlow) {
        tileGrad.addColorStop(0, hexToRgba(brand.primaryColor, 0.26));
        tileGrad.addColorStop(1, "rgba(15, 23, 42, 0.88)");
      } else {
        tileGrad.addColorStop(0, "rgba(30, 41, 59, 0.78)");
        tileGrad.addColorStop(1, "rgba(15, 23, 42, 0.88)");
      }
      ctx.fillStyle = tileGrad;
      ctx.strokeStyle = activeGlow
        ? hexToRgba(brand.primaryColor, 0.85)
        : "rgba(255, 255, 255, 0.15)";
      ctx.lineWidth = activeGlow ? 2.5 : 1.8;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      ctx.fill();
      ctx.stroke();

      // Top Specular Glass Rim
      ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x + radius, y + 1.5);
      ctx.lineTo(x + w - radius, y + 1.5);
      ctx.stroke();
      ctx.restore();
    };

    // Keynote Pill Header
    const topTag = trimPhraseAtWordBoundary(props.headerText ?? "APPLE BENTO SUMMARY", 24);
    ctx.save();
    ctx.translate(bw / 2, 72);
    drawBentoTile(-175, -22, 350, 44, false, 22);
    ctx.fillStyle = brand.primaryColor;
    ctx.font = `800 15px ${monoFont}`;
    ctx.textAlign = "center";
    ctx.fillText(`✦  ${topTag}`, 0, 6);
    ctx.restore();

    const items =
      props.items && props.items.length > 0
        ? props.items
        : ["AI Script Hook", "Brand CI Lock", "60fps Motion B-Roll", "Smart Karaoke Sub"];

    if (config.templateId === "bento.feature-matrix") {
      // 2x2 Apple Keynote Bento Grid with Active Spotlight Tile
      const tiles = [
        { x: 34, y: 120, w: 226, h: 215, tag: "01 · HOOK", icon: "⚡" },
        { x: 280, y: 120, w: 226, h: 215, tag: "02 · BRAND CI", icon: "🎨" },
        { x: 34, y: 355, w: 226, h: 215, tag: "03 · MOTION", icon: "🎬" },
        { x: 280, y: 355, w: 226, h: 215, tag: "04 · SUBTITLE", icon: "💬" },
      ];
      const activeIdx = Math.min(3, Math.floor(p * 4));
      tiles.forEach((t, idx) => {
        const at = 0.04 + idx * 0.1;
        if (p < at) return;
        const tp = easeOutBack(clamp01((p - at) / 0.16));
        const isCurrent = idx === activeIdx;
        ctx.save();
        ctx.translate(t.x + t.w / 2, t.y + t.h / 2);
        ctx.scale(tp, tp);
        drawBentoTile(-t.w / 2, -t.h / 2, t.w, t.h, isCurrent, 26);

        ctx.fillStyle = isCurrent ? brand.primaryColor : "#94A3B8";
        ctx.font = `700 13px ${monoFont}`;
        ctx.textAlign = "left";
        ctx.fillText(t.tag, -t.w / 2 + 22, -t.h / 2 + 34);

        ctx.font = `900 38px ${font}`;
        ctx.fillText(t.icon, -t.w / 2 + 22, -4);

        ctx.fillStyle = "#FFFFFF";
        ctx.font = `800 21px ${font}`;
        ctx.fillText(trimPhraseAtWordBoundary(items[idx] ?? t.tag, 16), -t.w / 2 + 22, 46);

        ctx.fillStyle = isCurrent ? brand.accentColor || "#FACC15" : "rgba(148,163,184,0.65)";
        ctx.font = `600 14px ${font}`;
        ctx.fillText(isCurrent ? "● ACTIVE MODULE" : "✓ READY", -t.w / 2 + 22, 78);
        ctx.restore();
      });

      // Bottom Full-Width Summary Glass Bar
      if (p > 0.36) {
        const bp = easeOutBack(clamp01((p - 0.36) / 0.16));
        ctx.save();
        ctx.translate(bw / 2, 628);
        ctx.scale(bp, bp);
        drawBentoTile(-236, -34, 472, 68, true, 22);
        ctx.fillStyle = "#FFFFFF";
        ctx.font = `900 22px ${font}`;
        ctx.textAlign = "center";
        ctx.fillText(trimPhraseAtWordBoundary(props.title ?? "4 ระบบหลักทำงานเชื่อมกันอัตโนมัติ", 26), 0, 8);
        ctx.restore();
      }
    } else if (config.templateId === "bento.pricing-verdict") {
      // Old Manual Workflow Card vs Highlighted Pro Bento Verdict Card
      const c1 = easeOutBack(clamp01((p - 0.04) / 0.16));
      ctx.save();
      ctx.translate(bw / 2, 225);
      ctx.scale(c1, c1);
      drawBentoTile(-236, -88, 472, 176, false, 26);

      ctx.fillStyle = "#EF4444";
      ctx.font = `800 15px ${monoFont}`;
      ctx.textAlign = "left";
      ctx.fillText("OLD WORKFLOW · วิธีเดิมที่เสียเวลา", -204, -46);

      ctx.fillStyle = "#94A3B8";
      ctx.font = `800 28px ${font}`;
      ctx.fillText(trimPhraseAtWordBoundary(props.leftText ?? "ตัดต่อเอง 4 ชั่วโมง / คลิป", 22), -204, 4);

      // Animated red strikethrough line
      const strikeP = clamp01((p - 0.18) / 0.2);
      ctx.strokeStyle = "#EF4444";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(-204, -6);
      ctx.lineTo(-204 + 340 * strikeP, -6);
      ctx.stroke();

      ctx.fillStyle = "#64748B";
      ctx.font = `600 18px ${font}`;
      ctx.fillText("× ซับไม่ตรงแบรนด์   × กราฟิกไม่ขยับตามเสียงพูด", -204, 52);
      ctx.restore();

      // Bottom Highlighted Bento Verdict Card
      if (p > 0.22) {
        const c2 = easeOutBack(clamp01((p - 0.22) / 0.18));
        ctx.save();
        ctx.translate(bw / 2, 470);
        ctx.scale(c2, c2);
        drawBentoTile(-236, -124, 472, 248, true, 30);

        ctx.fillStyle = brand.primaryColor;
        ctx.beginPath();
        ctx.roundRect(-204, -96, 176, 32, 10);
        ctx.fill();
        ctx.fillStyle = "#090D16";
        ctx.font = `900 14px ${monoFont}`;
        ctx.textAlign = "center";
        ctx.fillText(trimPhraseAtWordBoundary(props.badgeText ?? "PRO VERDICT", 16), -116, -75);

        ctx.fillStyle = "#FFFFFF";
        ctx.font = `900 34px ${font}`;
        ctx.textAlign = "left";
        ctx.fillText(trimPhraseAtWordBoundary(props.rightText ?? "ใช้ AI + Brand CI เสร็จใน 5 นาที", 22), -204, -22);

        items.slice(0, 2).forEach((point, idx) => {
          ctx.fillStyle = "#E2E8F0";
          ctx.font = `700 20px ${font}`;
          ctx.fillText(`✓  ${trimPhraseAtWordBoundary(point, 26)}`, -204, 34 + idx * 38);
        });
        ctx.restore();
      }
    } else {
      // Default: bento.glass-metrics (Hero KPI Card with 60fps Animated Number Counter + 2 Sub-Bento Cards)
      const heroEnter = easeOutBack(clamp01(p / 0.16));
      ctx.save();
      ctx.translate(bw / 2, 255);
      ctx.scale(heroEnter, heroEnter);
      drawBentoTile(-236, -135, 472, 270, true, 30);

      ctx.fillStyle = "#94A3B8";
      ctx.font = `700 16px ${monoFont}`;
      ctx.textAlign = "left";
      ctx.fillText("RETENTION & HOOK VELOCITY", -202, -92);

      // 60fps Animated KPI Number Counter
      const countVal = Math.round(clamp01(p / 0.55) * 320);
      ctx.fillStyle = "#FFFFFF";
      ctx.font = `900 78px ${font}`;
      ctx.fillText(`+${countVal}%`, -202, -8);

      // Glowing Growth Pill
      ctx.fillStyle = "rgba(34, 197, 94, 0.22)";
      ctx.strokeStyle = "#22C55E";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(72, -62, 132, 42, 21);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#4ADE80";
      ctx.font = `800 18px ${monoFont}`;
      ctx.textAlign = "center";
      ctx.fillText("▲ 3.2x FAST", 138, -35);

      ctx.fillStyle = "#F8FAFC";
      ctx.font = `800 24px ${font}`;
      ctx.textAlign = "left";
      ctx.fillText(trimPhraseAtWordBoundary(props.title ?? "หยุดนิ้วคนดูตั้งแต่วินาทีแรก", 24), -202, 44);

      // Smooth Sparkline Curve inside Hero Bento Card
      const sparkP = clamp01((p - 0.1) / 0.5);
      ctx.strokeStyle = brand.primaryColor;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(-202, 102);
      ctx.bezierCurveTo(-90, 98, 10, 42, -202 + 404 * sparkP, 102 - 64 * sparkP);
      ctx.stroke();
      ctx.restore();

      // 2 Bottom Sub-Bento Cards
      const subCards = [
        { x: 34, title: items[0] ?? "เปิดด้วยคำตอบทันที", sub: "3 วิแรกห้ามเกริ่น" },
        { x: 280, title: items[1] ?? "ล็อกสี Brand CI", sub: "จำช่องได้ในพริบตา" },
      ];
      subCards.forEach((sc, idx) => {
        const at = 0.22 + idx * 0.12;
        if (p < at) return;
        const sp = easeOutBack(clamp01((p - at) / 0.16));
        ctx.save();
        ctx.translate(sc.x + 113, 505);
        ctx.scale(sp, sp);
        drawBentoTile(-113, -95, 226, 190, false, 26);

        ctx.fillStyle = brand.primaryColor;
        ctx.beginPath();
        ctx.arc(-72, -46, 18, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#090D16";
        ctx.font = `900 18px ${font}`;
        ctx.textAlign = "center";
        ctx.fillText(idx === 0 ? "01" : "02", -72, -40);

        ctx.fillStyle = "#FFFFFF";
        ctx.font = `800 20px ${font}`;
        ctx.textAlign = "left";
        ctx.fillText(trimPhraseAtWordBoundary(sc.title, 15), -88, 14);
        ctx.fillStyle = "#94A3B8";
        ctx.font = `600 16px ${font}`;
        ctx.fillText(trimPhraseAtWordBoundary(sc.sub, 18), -88, 48);
        ctx.restore();
      });
    }
  } else {
    // ── THEME B: DOODLE EXPLAINER (Ref 1 Editorial Hand-Drawn Vector Style) ──
    if (props.headerText) {
      const cleanH = trimPhraseAtWordBoundary(props.headerText, 26);
      const headerW = Math.min(450, Math.max(210, cleanH.length * 16 + 52));
      ctx.save();
      ctx.translate(bw / 2, 70);
      ctx.rotate(-0.018);
      drawCard(-headerW / 2, -28, headerW, 56, "#FFFFFF", 16, "#111827", 4.5);
      ctx.fillStyle = "#111827";
      ctx.font = `900 26px ${font}`;
      ctx.textAlign = "center";
      ctx.fillText(cleanH, 0, 9);
      ctx.restore();
    }

    const items =
      props.items && props.items.length > 0
        ? props.items
        : ["วางซีรีส์", "ตัวละครประจำช่อง", "สูตร Hook", "โครงตอนสั้นกระชับ"];

    switch (entry.archetypeId) {
      case "hook-character": {
        const walkP = clamp01(p / 0.55);
        const charX = 165 + walkP * 28;
        const surprised = p > 0.38;
        drawStickman(charX, 505, 1.06, walkP * 2, surprised, p > 0.25 ? "right" : "none");

        // Clock with animated sweep hand & clear time badge
        if (p > 0.1) {
          const cp = easeOutBack(clamp01((p - 0.1) / 0.18));
          const clockLabel = trimPhraseAtWordBoundary(props.badgeText ?? "3 วินาทีแรก", 12);
          ctx.save();
          ctx.translate(382, 360);
          ctx.scale(cp, cp);
          drawCard(-86, -86, 172, 172, "#FFFFFF", 86, "#111827", 4.5);

          // Clock tick marks
          ctx.strokeStyle = "#9CA3AF";
          ctx.lineWidth = 3;
          for (let t = 0; t < 12; t++) {
            const a = (t / 12) * Math.PI * 2;
            ctx.beginPath();
            ctx.moveTo(Math.cos(a) * 66, Math.sin(a) * 66);
            ctx.lineTo(Math.cos(a) * 74, Math.sin(a) * 74);
            ctx.stroke();
          }

          const handAngle = -Math.PI * 0.85 + clamp01((p - 0.12) / 0.45) * Math.PI * 0.65;
          ctx.strokeStyle = "#111827";
          ctx.lineWidth = 5;
          ctx.beginPath();
          ctx.moveTo(0, -6);
          ctx.lineTo(Math.cos(handAngle) * 42, -6 + Math.sin(handAngle) * 42);
          ctx.stroke();

          ctx.strokeStyle = brand.primaryColor;
          ctx.lineWidth = 5;
          ctx.beginPath();
          ctx.moveTo(0, -6);
          ctx.lineTo(44, -6);
          ctx.stroke();

          ctx.fillStyle = "#111827";
          ctx.font = `900 22px ${font}`;
          ctx.textAlign = "center";
          ctx.fillText(clockLabel, 0, 42);
          ctx.restore();
        }

        if (p > 0.36) {
          const qp = easeOutBack(clamp01((p - 0.36) / 0.16));
          ctx.save();
          ctx.translate(charX + 4, 326);
          ctx.scale(qp, qp);
          ctx.font = `900 66px ${font}`;
          ctx.textAlign = "center";
          ctx.fillStyle = "#FACC15";
          ctx.strokeStyle = "#111827";
          ctx.lineWidth = 6;
          ctx.strokeText("?", 0, 0);
          ctx.fillText("?", 0, 0);
          ctx.restore();
        }
        break;
      }

      case "three-cards-progression": {
        const labels = ["ตอน 1", "ตอน 2", "ตอน 3"];
        const flames = [1.0, 0.55, 0.0];
        labels.forEach((lbl, idx) => {
          const at = 0.05 + idx * 0.14;
          if (p < at) return;
          const cp = easeOutBack(clamp01((p - at) / 0.16));
          const x = 44 + idx * 134;
          ctx.save();
          ctx.translate(x + 58, 435);
          ctx.scale(cp, cp);
          drawCard(-56, -80, 112, 150, "#FFFFFF", 14, "#111827", 4.2);
          ctx.fillStyle = "#111827";
          ctx.font = `900 24px ${font}`;
          ctx.textAlign = "center";
          ctx.fillText(lbl, 0, 22);

          const fScale = flames[idx] ?? 0;
          if (fScale > 0) {
            ctx.save();
            ctx.translate(0, -76);
            ctx.scale(fScale, fScale);
            ctx.fillStyle = "#F97316";
            ctx.strokeStyle = "#111827";
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.moveTo(0, -52);
            ctx.bezierCurveTo(34, -18, 38, 24, 0, 38);
            ctx.bezierCurveTo(-38, 24, -34, -18, 0, -52);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = "#FACC15";
            ctx.beginPath();
            ctx.moveTo(0, -24);
            ctx.bezierCurveTo(16, -6, 18, 18, 0, 28);
            ctx.bezierCurveTo(-18, 18, -16, -6, 0, -24);
            ctx.fill();
            ctx.restore();
          } else {
            ctx.strokeStyle = "#9CA3AF";
            ctx.lineWidth = 3.8;
            ctx.beginPath();
            ctx.moveTo(0, -56);
            ctx.quadraticCurveTo(-10, -80, 6, -104);
            ctx.quadraticCurveTo(16, -122, -4, -140);
            ctx.stroke();
          }
          ctx.restore();
        });

        if (p > 0.38) {
          const bp = easeOutBack(clamp01((p - 0.38) / 0.16));
          ctx.save();
          ctx.translate(242, 232);
          ctx.scale(bp, bp);
          drawCard(-94, -28, 188, 56, "#EF4444", 14, "#111827", 4.2);
          ctx.fillStyle = "#FFFFFF";
          ctx.font = `900 26px ${font}`;
          ctx.textAlign = "center";
          ctx.fillText(trimPhraseAtWordBoundary(props.badgeText ?? "จำช่องไม่ได้", 14), 0, 9);
          ctx.restore();
        }
        drawStickman(468, 505, 0.78, 0, p > 0.38, "left");
        break;
      }

      case "chart-vs-reality": {
        drawStickman(270, 515, 0.88, 0, false, p > 0.34 ? "right" : "left");
        if (p > 0.04) {
          const cp = easeOutBack(clamp01((p - 0.04) / 0.16));
          ctx.save();
          ctx.translate(145, 375);
          ctx.scale(cp, cp);
          drawCard(-102, -98, 204, 196, "#FFFFFF", 16);
          ctx.strokeStyle = "#22C55E";
          ctx.lineWidth = 7;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.beginPath();
          ctx.moveTo(-68, 30);
          ctx.lineTo(-24, -5);
          ctx.lineTo(14, 10);
          ctx.lineTo(66, -60);
          ctx.stroke();

          drawCard(-92, 44, 184, 42, "#FFFFFF", 10);
          ctx.fillStyle = "#111827";
          ctx.font = `800 18px ${font}`;
          ctx.textAlign = "center";
          ctx.fillText(trimPhraseAtWordBoundary(props.leftText ?? "สัญญายอดวิว", 14), 0, 71);

          if (p > 0.2) {
            const xp = clamp01((p - 0.2) / 0.15);
            ctx.strokeStyle = "#EF4444";
            ctx.lineWidth = 9;
            ctx.beginPath();
            ctx.moveTo(-66, -62);
            ctx.lineTo(-66 + 132 * xp, -62 + 96 * xp);
            if (xp > 0.5) {
              const xp2 = (xp - 0.5) * 2;
              ctx.moveTo(66, -62);
              ctx.lineTo(66 - 132 * xp2, -62 + 96 * xp2);
            }
            ctx.stroke();
          }
          ctx.restore();
        }

        if (p > 0.32) {
          const cp = easeOutBack(clamp01((p - 0.32) / 0.16));
          ctx.save();
          ctx.translate(395, 375);
          ctx.scale(cp, cp);
          drawCard(-102, -98, 204, 196, "#FFFFFF", 16);
          for (let i = 0; i < 4; i++) {
            const bx = -76 + i * 39;
            const by = -28;
            ctx.strokeStyle = "#111827";
            ctx.lineWidth = 3.5;
            ctx.beginPath();
            ctx.roundRect(bx, by, 31, 31, 6);
            ctx.stroke();
            if (p > 0.38 + i * 0.07) {
              ctx.strokeStyle = brand.primaryColor;
              ctx.lineWidth = 4.5;
              ctx.beginPath();
              ctx.moveTo(bx + 6, by + 15);
              ctx.lineTo(bx + 13, by + 23);
              ctx.lineTo(bx + 25, by + 8);
              ctx.stroke();
            }
          }
          drawCard(-92, 44, 184, 42, "#FFFFFF", 10);
          ctx.fillStyle = "#111827";
          ctx.font = `800 18px ${font}`;
          ctx.textAlign = "center";
          ctx.fillText(trimPhraseAtWordBoundary(props.rightText ?? "ทำซ้ำทุกสัปดาห์", 14), 0, 71);
          ctx.restore();
        }
        break;
      }

      case "step-checklist": {
        // Left 3D Hardcover Book with spine + smiley badge + Right Checklist (Ref 1 E-book layout)
        const bookEnter = easeOutBack(clamp01(p / 0.16));
        ctx.save();
        ctx.translate(128, 385);
        ctx.scale(bookEnter, bookEnter);
        ctx.rotate(-0.08);
        // Book pages block
        drawCard(-74, -98, 154, 204, "#FFFFFF", 12);
        // Book cover in Brand Primary
        drawCard(-80, -106, 154, 204, brand.primaryColor, 12);
        // Spine line
        ctx.strokeStyle = "#111827";
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.moveTo(-58, -106);
        ctx.lineTo(-58, 98);
        ctx.stroke();

        // White title label on book cover
        drawCard(-44, -76, 102, 42, "#FFFFFF", 8, "#111827", 3.5);
        ctx.fillStyle = "#111827";
        ctx.font = `900 19px ${font}`;
        ctx.textAlign = "center";
        ctx.fillText(trimPhraseAtWordBoundary(props.title ?? "Mew Guide", 10), 7, -49);

        // Smiley mini icon on book cover
        ctx.fillStyle = "#FFFFFF";
        ctx.beginPath();
        ctx.arc(32, 54, 22, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#111827";
        ctx.beginPath();
        ctx.arc(26, 50, 2.5, 0, Math.PI * 2);
        ctx.arc(38, 50, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(32, 54, 8, 0.15 * Math.PI, 0.85 * Math.PI);
        ctx.stroke();
        ctx.restore();

        items.slice(0, 4).forEach((item, idx) => {
          const at = 0.1 + idx * 0.11;
          if (p < at) return;
          const ip = easeOutBack(clamp01((p - at) / 0.14));
          const y = 268 + idx * 66;
          ctx.save();
          ctx.translate(348, y);
          ctx.scale(ip, ip);
          ctx.fillStyle = "#FFFFFF";
          ctx.strokeStyle = "#111827";
          ctx.lineWidth = 3.8;
          ctx.beginPath();
          ctx.roundRect(-115, -20, 36, 36, 8);
          ctx.fill();
          ctx.stroke();

          ctx.strokeStyle = brand.primaryColor;
          ctx.lineWidth = 5;
          ctx.beginPath();
          ctx.moveTo(-108, -2);
          ctx.lineTo(-98, 8);
          ctx.lineTo(-84, -10);
          ctx.stroke();

          drawCard(-66, -23, 214, 42, "#FFFFFF", 10, "#111827", 3.5);
          ctx.fillStyle = "#111827";
          ctx.font = `800 18px ${font}`;
          ctx.textAlign = "left";
          ctx.fillText(trimPhraseAtWordBoundary(item, 18), -52, 5);
          ctx.restore();
        });
        break;
      }

      case "flow-diagram": {
        const coords = [
          { x: 145, y: 262, at: 0.04, icon: "doc" },
          { x: 395, y: 262, at: 0.15, icon: "audio" },
          { x: 145, y: 462, at: 0.27, icon: "scene" },
          { x: 395, y: 462, at: 0.39, icon: "play" },
        ];
        ctx.strokeStyle = "#111827";
        ctx.lineWidth = 4;
        if (p > 0.12) {
          ctx.beginPath();
          ctx.moveTo(212, 254);
          ctx.quadraticCurveTo(270, 234, 326, 254);
          ctx.stroke();
          // Arrowhead
          ctx.beginPath();
          ctx.moveTo(316, 245);
          ctx.lineTo(328, 255);
          ctx.lineTo(314, 263);
          ctx.stroke();
        }
        if (p > 0.24) {
          ctx.beginPath();
          ctx.moveTo(340, 315);
          ctx.quadraticCurveTo(270, 375, 205, 415);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(218, 415);
          ctx.lineTo(203, 417);
          ctx.lineTo(209, 403);
          ctx.stroke();
        }
        if (p > 0.36) {
          ctx.beginPath();
          ctx.moveTo(212, 456);
          ctx.quadraticCurveTo(270, 440, 326, 456);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(316, 447);
          ctx.lineTo(328, 457);
          ctx.lineTo(314, 465);
          ctx.stroke();
        }

        coords.forEach((c, idx) => {
          if (p < c.at) return;
          const np = easeOutBack(clamp01((p - c.at) / 0.14));
          const lbl = trimPhraseAtWordBoundary(items[idx] ?? `ขั้น ${idx + 1}`, 16);
          ctx.save();
          ctx.translate(c.x, c.y);
          ctx.scale(np, np);
          ctx.fillStyle = "#FFFFFF";
          ctx.strokeStyle = "#111827";
          ctx.lineWidth = 4.5;
          ctx.beginPath();
          ctx.arc(0, 0, 48, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();

          // Vector icon inside circle (Ref 1 style)
          if (c.icon === "doc") {
            ctx.strokeRect(-16, -20, 32, 40);
            ctx.beginPath();
            ctx.moveTo(-9, -8);
            ctx.lineTo(9, -8);
            ctx.moveTo(-9, 2);
            ctx.lineTo(9, 2);
            ctx.moveTo(-9, 12);
            ctx.lineTo(4, 12);
            ctx.stroke();
          } else if (c.icon === "audio") {
            ctx.beginPath();
            ctx.moveTo(-16, -8);
            ctx.lineTo(-6, -8);
            ctx.lineTo(6, -18);
            ctx.lineTo(6, 18);
            ctx.lineTo(-6, 8);
            ctx.lineTo(-16, 8);
            ctx.closePath();
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(10, 0, 10, -0.35 * Math.PI, 0.35 * Math.PI);
            ctx.stroke();
          } else if (c.icon === "scene") {
            ctx.beginPath();
            ctx.arc(0, -8, 12, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(0, 22, 18, Math.PI * 1.15, Math.PI * 1.85);
            ctx.stroke();
          } else {
            ctx.fillStyle = brand.primaryColor;
            ctx.beginPath();
            ctx.roundRect(-22, -15, 44, 30, 8);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = "#FFFFFF";
            ctx.beginPath();
            ctx.moveTo(-6, -8);
            ctx.lineTo(10, 0);
            ctx.lineTo(-6, 8);
            ctx.closePath();
            ctx.fill();
          }

          const pillW = Math.min(210, Math.max(108, lbl.length * 14 + 28));
          drawCard(-pillW / 2, 58, pillW, 40, "#FFFFFF", 10, "#111827", 3.8);
          ctx.fillStyle = "#111827";
          ctx.font = `800 18px ${font}`;
          ctx.textAlign = "center";
          ctx.fillText(lbl, 0, 84);
          ctx.restore();
        });
        break;
      }

      case "before-after-split": {
        drawCard(38, 220, 212, 235, "#FFFFFF", 16);
        ctx.fillStyle = "#6B7280";
        ctx.font = `800 21px ${font}`;
        ctx.textAlign = "center";
        ctx.fillText("เปิดคลิปช้า", 144, 275);
        ctx.fillStyle = "#111827";
        ctx.font = `800 20px ${font}`;
        ctx.fillText(trimPhraseAtWordBoundary(props.leftText ?? "เกริ่นน้ำยาว", 14), 144, 345);

        // Red cross on old way
        ctx.strokeStyle = "#EF4444";
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(114, 375);
        ctx.lineTo(174, 415);
        ctx.moveTo(174, 375);
        ctx.lineTo(114, 415);
        ctx.stroke();

        if (p > 0.2) {
          const ap = easeOutBack(clamp01((p - 0.2) / 0.16));
          ctx.save();
          ctx.translate(396, 338);
          ctx.scale(ap, ap);
          drawCard(-106, -118, 212, 235, brand.accentColor, 16);
          ctx.fillStyle = "#111827";
          ctx.font = `900 22px ${font}`;
          ctx.textAlign = "center";
          ctx.fillText("เปิดด้วยคำตอบ!", 0, -62);
          ctx.font = `800 20px ${font}`;
          ctx.fillText(trimPhraseAtWordBoundary(props.rightText ?? "หยุดนิ้วใน 3 วิ", 14), 0, 6);

          ctx.fillStyle = brand.primaryColor;
          ctx.beginPath();
          ctx.arc(0, 62, 22, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = "#FFFFFF";
          ctx.font = `900 22px ${font}`;
          ctx.fillText("✓", 0, 70);
          ctx.restore();
        }
        drawStickman(270, 515, 0.82, 0, false, "right");
        break;
      }

      case "screen-showcase": {
        // Framed Monitor Screen with interior architectural/brand showcase + walking character (Ref 1)
        drawCard(42, 185, 456, 265, "#1F2937", 18, "#111827", 4.5);
        drawCard(58, 201, 424, 233, "#EBF5FF", 12, "#111827", 3.5);

        // Interior picture frame on wall inside monitor
        drawCard(290, 224, 162, 112, "#BAE6FD", 8, "#111827", 3);
        // Mini buildings inside frame
        const bColors = [brand.primaryColor, "#F59E0B", "#10B981"];
        for (let b = 0; b < 3; b++) {
          ctx.fillStyle = bColors[b];
          ctx.strokeStyle = "#111827";
          ctx.lineWidth = 2.5;
          const bx = 304 + b * 46;
          const bhBox = 45 + (b % 2) * 18;
          ctx.fillRect(bx, 336 - bhBox, 36, bhBox);
          ctx.strokeRect(bx, 336 - bhBox, 36, bhBox);
        }

        // Floor inside monitor
        ctx.fillStyle = "#C69C72";
        ctx.fillRect(60, 386, 420, 46);
        ctx.strokeStyle = "#111827";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(60, 386);
        ctx.lineTo(480, 386);
        ctx.stroke();

        const walkP = clamp01(p);
        drawStickman(150 + walkP * 80, 355, 0.56, walkP * 2, false, "right");

        if (p > 0.16) {
          const bp = easeOutBack(clamp01((p - 0.16) / 0.16));
          ctx.save();
          ctx.translate(150, 515);
          ctx.scale(bp, bp);
          ctx.rotate(-0.03);
          drawCard(-105, -26, 210, 52, "#FFFFFF", 12);
          ctx.fillStyle = "#111827";
          ctx.font = `800 21px ${font}`;
          ctx.textAlign = "center";
          ctx.fillText("วาดด้วยโค้ด", 0, 8);
          ctx.restore();
        }

        if (p > 0.3) {
          const bp2 = easeOutBack(clamp01((p - 0.3) / 0.16));
          ctx.save();
          ctx.translate(385, 515);
          ctx.scale(bp2, bp2);
          ctx.rotate(0.02);
          drawCard(-110, -26, 220, 52, brand.accentColor, 12);
          ctx.fillStyle = "#111827";
          ctx.font = `900 21px ${font}`;
          ctx.textAlign = "center";
          ctx.fillText(trimPhraseAtWordBoundary(props.badgeText ?? "ล็อก Brand CI", 14), 0, 8);
          ctx.restore();
        }
        break;
      }

      case "price-slash-cta":
      default: {
        // Character pointing to big CTA button + speech bubble (Ref 1 closing scene)
        drawStickman(135, 505, 0.92, 0, false, "right");

        const btnEnter = easeOutBack(clamp01(p / 0.18));
        ctx.save();
        ctx.translate(290, 325);
        ctx.scale(btnEnter, btnEnter);
        drawCard(-165, -52, 330, 104, brand.primaryColor, 52, "#111827", 5);
        ctx.fillStyle = "#FFFFFF";
        ctx.font = `900 44px ${font}`;
        ctx.textAlign = "center";
        ctx.fillText(
          props.rightText ? `พิมพ์ "${props.rightText}"` : "สั่งซื้อ / ทักแชต",
          0,
          15,
        );

        // Comic emphasis bursts above button
        if (p > 0.22) {
          ctx.strokeStyle = "#EF4444";
          ctx.lineWidth = 4.5;
          ctx.beginPath();
          ctx.moveTo(-95, -68);
          ctx.lineTo(-82, -88);
          ctx.lineTo(-70, -70);
          ctx.moveTo(70, -70);
          ctx.lineTo(82, -88);
          ctx.lineTo(95, -68);
          ctx.stroke();
        }
        ctx.restore();

        if (p > 0.32) {
          const sp = easeOutBack(clamp01((p - 0.32) / 0.16));
          ctx.save();
          ctx.translate(375, 485);
          ctx.scale(sp, sp);
          drawCard(-115, -36, 230, 72, "#FFFFFF", 22, "#111827", 4.5);
          ctx.fillStyle = "#111827";
          ctx.font = `800 22px ${font}`;
          ctx.textAlign = "center";
          ctx.fillText(trimPhraseAtWordBoundary(props.badgeText ?? "ส่งให้ในแชตทันที", 16), 0, 8);
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
}: {
  motionTemplate?: MotionTemplateConfig | null;
  fallbackTemplateId?: MotionTemplateId;
  segDurFrames: number;
  tailFrames: number;
  headFrames: number;
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

  useEffect(() => {
    paintMotionBrollCanvas(canvasRef.current, resolvedConfig, progress);
  }, [resolvedConfig, progress, width, height]);

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
