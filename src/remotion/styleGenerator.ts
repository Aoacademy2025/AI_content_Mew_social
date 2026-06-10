import type { CaptionStyleDef } from "./captionStyles";

// ── Seeded PRNG (Mulberry32) ───────────────────────────────────────────────
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 0xffffffff;
  };
}

function buildOutline(px: number, color = "#000") {
  return `${-px}px ${-px}px 0 ${color},${px}px ${-px}px 0 ${color},${-px}px ${px}px 0 ${color},${px}px ${px}px 0 ${color}`;
}

function buildDeepShadow(color = "#000") {
  return `3px 4px 0px ${color}, 6px 8px 0px ${color}66, ${buildOutline(3, color)}`;
}

// ── Professional Thai video templates ────────────────────────────────────────
// Each template mirrors a real Thai YouTube/TikTok editor's style
interface Template {
  label: string;
  activeColor: string;
  fontFamily: string;
  fontWeight: number;
  fontSize: [number, number]; // [min, max]
  activeTextShadow: string;
  boxBackground?: string;
  boxBorderRadius?: number;
  boxPadding?: string;
  activeBackground?: string;
  activeTextColor?: string;
  previewBg: string;
}

const TEMPLATES: Template[] = [
  // 1. Thai Classic — yellow + thick black stroke + dark box (ข่าว / สาระ)
  {
    label: "Classic Yellow",
    activeColor: "#FFE000",
    fontFamily: "'Kanit', sans-serif",
    fontWeight: 900,
    fontSize: [66, 76],
    activeTextShadow: buildOutline(4) + `, 0 4px 14px rgba(0,0,0,0.9)`,
    boxBackground: "rgba(0,0,0,0.78)",
    boxBorderRadius: 6,
    boxPadding: "10px 26px",
    previewBg: "#111",
  },
  // 2. Bold White Stroke — white text heavy outline (travel / lifestyle)
  {
    label: "White Bold",
    activeColor: "#FFFFFF",
    fontFamily: "'Prompt', sans-serif",
    fontWeight: 900,
    fontSize: [64, 74],
    activeTextShadow: buildOutline(5) + `, 2px 4px 0 #000`,
    boxBackground: "rgba(0,0,0,0.65)",
    boxBorderRadius: 8,
    boxPadding: "10px 24px",
    previewBg: "#1a1a1a",
  },
  // 3. Cinematic Gold — amber/gold deep shadow (ภาพยนตร์ / drama)
  {
    label: "Cinematic Gold",
    activeColor: "#FFC200",
    fontFamily: "'Kanit', sans-serif",
    fontWeight: 800,
    fontSize: [64, 72],
    activeTextShadow: buildDeepShadow("#000") + `, 0 0 28px rgba(255,180,0,0.45)`,
    boxBackground: "rgba(0,0,0,0.82)",
    boxBorderRadius: 8,
    boxPadding: "10px 28px",
    previewBg: "#0a0800",
  },
  // 4. News Orange — vivid orange + black stroke (news / highlight)
  {
    label: "News Orange",
    activeColor: "#FF6A00",
    fontFamily: "'Kanit', sans-serif",
    fontWeight: 900,
    fontSize: [64, 76],
    activeTextShadow: buildOutline(4) + `, 0 4px 12px rgba(0,0,0,0.85)`,
    boxBackground: "rgba(0,0,0,0.76)",
    boxBorderRadius: 6,
    boxPadding: "10px 24px",
    previewBg: "#111",
  },
  // 5. Deep Red Drama — dark red + thick outline (drama / horror)
  {
    label: "Red Drama",
    activeColor: "#FF2525",
    fontFamily: "'Prompt', sans-serif",
    fontWeight: 900,
    fontSize: [62, 72],
    activeTextShadow: buildOutline(4) + `, 0 0 22px rgba(255,0,0,0.35)`,
    boxBackground: "rgba(0,0,0,0.80)",
    boxBorderRadius: 6,
    boxPadding: "10px 24px",
    previewBg: "#100000",
  },
  // 6. Highlight Pill Yellow — yellow pill bg black text (important fact)
  {
    label: "Pill Yellow",
    activeColor: "#000000",
    fontFamily: "'Kanit', sans-serif",
    fontWeight: 800,
    fontSize: [58, 68],
    activeTextShadow: "none",
    activeBackground: "#FFE000",
    activeTextColor: "#000000",
    previewBg: "#111",
  },
  // 7. Highlight Pill White — white pill bg black text (clean/modern)
  {
    label: "Pill White",
    activeColor: "#000000",
    fontFamily: "'Sarabun', sans-serif",
    fontWeight: 800,
    fontSize: [58, 68],
    activeTextShadow: "none",
    activeBackground: "#FFFFFF",
    activeTextColor: "#000000",
    previewBg: "#222",
  },
  // 8. Highlight Pill Orange
  {
    label: "Pill Orange",
    activeColor: "#000000",
    fontFamily: "'Kanit', sans-serif",
    fontWeight: 900,
    fontSize: [58, 68],
    activeTextShadow: "none",
    activeBackground: "#FF6A00",
    activeTextColor: "#FFFFFF",
    previewBg: "#111",
  },
  // 9. Cyan Impact — neon cyan + thick outline (tech / gaming)
  {
    label: "Cyan Impact",
    activeColor: "#00E5FF",
    fontFamily: "'Prompt', sans-serif",
    fontWeight: 900,
    fontSize: [62, 72],
    activeTextShadow: buildOutline(4) + `, 0 0 18px rgba(0,229,255,0.55)`,
    boxBackground: "rgba(0,5,20,0.84)",
    boxBorderRadius: 8,
    boxPadding: "10px 26px",
    previewBg: "#000d14",
  },
  // 10. Clean Impact — pure white stroke no box (outdoor / sport)
  {
    label: "Clean Impact",
    activeColor: "#FFFFFF",
    fontFamily: "'Kanit', sans-serif",
    fontWeight: 900,
    fontSize: [68, 80],
    activeTextShadow: buildOutline(5) + `, ${buildDeepShadow()}`,
    previewBg: "#333",
  },
  // 11. Luxury Gold Glow — gold with warm glow (food / fashion)
  {
    label: "Luxury Gold",
    activeColor: "#FFD700",
    fontFamily: "'Mitr', sans-serif",
    fontWeight: 700,
    fontSize: [62, 70],
    activeTextShadow: `${buildOutline(3)}, 0 0 18px rgba(255,200,0,0.7), 0 0 40px rgba(255,180,0,0.35)`,
    boxBackground: "rgba(0,0,0,0.75)",
    boxBorderRadius: 10,
    boxPadding: "12px 28px",
    previewBg: "#090700",
  },
  // 12. Emerald — green text dark box (nature / health)
  {
    label: "Emerald",
    activeColor: "#00E676",
    fontFamily: "'Prompt', sans-serif",
    fontWeight: 800,
    fontSize: [62, 72],
    activeTextShadow: buildOutline(3) + `, 0 4px 16px rgba(0,0,0,0.9)`,
    boxBackground: "rgba(0,0,0,0.80)",
    boxBorderRadius: 8,
    boxPadding: "10px 24px",
    previewBg: "#000a02",
  },
  // 13. Purple Punch (entertainment / variety)
  {
    label: "Purple Punch",
    activeColor: "#E040FB",
    fontFamily: "'Kanit', sans-serif",
    fontWeight: 900,
    fontSize: [62, 72],
    activeTextShadow: buildOutline(4) + `, 0 0 20px rgba(200,0,255,0.45)`,
    boxBackground: "rgba(10,0,20,0.82)",
    boxBorderRadius: 8,
    boxPadding: "10px 24px",
    previewBg: "#080012",
  },
  // 14. Sky Blue Clean (education / tutorial)
  {
    label: "Sky Blue",
    activeColor: "#40C4FF",
    fontFamily: "'Sarabun', sans-serif",
    fontWeight: 800,
    fontSize: [62, 70],
    activeTextShadow: buildOutline(4),
    boxBackground: "rgba(0,10,30,0.82)",
    boxBorderRadius: 8,
    boxPadding: "10px 24px",
    previewBg: "#000a1e",
  },
  // 15. Warm White (soft vlog / motivational)
  {
    label: "Warm White",
    activeColor: "#FFF8E7",
    fontFamily: "'Mitr', sans-serif",
    fontWeight: 700,
    fontSize: [60, 70],
    activeTextShadow: buildOutline(3, "#1a1200") + `, 0 4px 18px rgba(0,0,0,0.85)`,
    boxBackground: "rgba(0,0,0,0.68)",
    boxBorderRadius: 12,
    boxPadding: "12px 28px",
    previewBg: "#111",
  },
];

export function generateUniqueStyle(seed: number): CaptionStyleDef & { generatedLabel: string } {
  const rand = mulberry32(Math.round(seed % 0xffffffff));
  const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];

  const template = pick(TEMPLATES);

  // Slight randomization within template ranges
  const [fsMin, fsMax] = template.fontSize;
  const fontSize = fsMin + Math.round(rand() * (fsMax - fsMin));
  const lineHeight = 1.3 + parseFloat((rand() * 0.25).toFixed(2)); // 1.3–1.55
  const letterSpacing = rand() > 0.6 ? `${(rand() * 0.02 + 0.005).toFixed(3)}em` : "0.01em";

  const generatedLabel = template.label;

  const result: CaptionStyleDef & { generatedLabel: string } = {
    id: "tiktok",
    label: "AI Generated",
    generatedLabel,
    fontFamily: template.fontFamily,
    fontSize,
    fontWeight: template.fontWeight,
    activeColor: template.activeColor,
    inactiveColor: "#CCCCCC",
    activeTextShadow: template.activeTextShadow,
    inactiveTextShadow: buildOutline(2),
    lineHeight,
    letterSpacing,
    paddingBottom: "12%",
    previewBg: template.previewBg,
    previewActive: template.activeColor,
  };

  if (template.boxBackground) {
    result.boxBackground = template.boxBackground;
    result.boxBorderRadius = template.boxBorderRadius;
    result.boxPadding = template.boxPadding;
  }
  if (template.activeBackground) {
    result.activeBackground = template.activeBackground;
    result.activeTextColor = template.activeTextColor;
  }

  return result;
}

/** Generate N unique styles from different seeds */
export function generateStyleBatch(count: number, baseSeed = Date.now()): ReturnType<typeof generateUniqueStyle>[] {
  return Array.from({ length: count }, (_, i) => generateUniqueStyle(baseSeed + i * 137508));
}
