export type CaptionStyleId = "tiktok" | "bold" | "neon" | "minimal" | "highlight" | "cinema" | "fire" | "white" | "pink" | "blue";

const outline = (px: number) =>
  `${-px}px ${-px}px 0 #000, ${px}px ${-px}px 0 #000, ${-px}px ${px}px 0 #000, ${px}px ${px}px 0 #000`;

export interface CaptionStyleDef {
  id: CaptionStyleId;
  label: string;           // shown in UI
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  activeColor: string;
  inactiveColor: string;
  activeTextShadow: string;
  inactiveTextShadow: string;
  /** if true, active word gets a colored background pill instead of text color */
  activeBackground?: string;
  activeTextColor?: string;   // text color when activeBackground is used
  /** box behind the whole sentence */
  boxBackground?: string;
  boxBorderRadius?: number;
  boxPadding?: string;
  paddingBottom: string;
  lineHeight: number;
  letterSpacing?: string;
  /** preview background for the style picker */
  previewBg: string;
  previewActive: string;
}

export const CAPTION_STYLES: Record<CaptionStyleId, CaptionStyleDef> = {
  tiktok: {
    id: "tiktok",
    label: "TikTok",
    fontFamily: "'Sarabun', sans-serif",
    fontSize: 62,
    fontWeight: 800,
    activeColor: "#FFE000",
    inactiveColor: "#FFFFFF",
    activeTextShadow: `${outline(3)}, 0 0 18px rgba(255,224,0,0.35)`,
    inactiveTextShadow: outline(2),
    paddingBottom: "13%",
    lineHeight: 1.55,
    previewBg: "#111",
    previewActive: "#FFE000",
  },

  bold: {
    id: "bold",
    label: "Bold Red",
    fontFamily: "'Kanit', sans-serif",
    fontSize: 66,
    fontWeight: 900,
    activeColor: "#FF3B3B",
    inactiveColor: "#FFFFFF",
    activeTextShadow: outline(3),
    inactiveTextShadow: outline(2),
    boxBackground: "rgba(0,0,0,0.68)",
    boxBorderRadius: 10,
    boxPadding: "8px 20px",
    paddingBottom: "12%",
    lineHeight: 1.5,
    previewBg: "#1a0000",
    previewActive: "#FF3B3B",
  },

  neon: {
    id: "neon",
    label: "Neon",
    fontFamily: "'Prompt', sans-serif",
    fontSize: 58,
    fontWeight: 700,
    activeColor: "#00E5FF",
    inactiveColor: "#888888",
    activeTextShadow: "0 0 8px #00E5FF, 0 0 22px #00E5FF, 0 0 45px rgba(0,229,255,0.5)",
    inactiveTextShadow: "0 0 3px rgba(255,255,255,0.15)",
    boxBackground: "rgba(0,0,15,0.78)",
    boxBorderRadius: 8,
    boxPadding: "10px 24px",
    paddingBottom: "12%",
    lineHeight: 1.55,
    letterSpacing: "0.02em",
    previewBg: "#00050f",
    previewActive: "#00E5FF",
  },

  minimal: {
    id: "minimal",
    label: "Minimal",
    fontFamily: "'Mitr', sans-serif",
    fontSize: 54,
    fontWeight: 500,
    activeColor: "#FFD700",
    inactiveColor: "#E8E8E8",
    activeTextShadow: "0 2px 14px rgba(255,215,0,0.55), 0 1px 4px rgba(0,0,0,0.9)",
    inactiveTextShadow: "0 1px 4px rgba(0,0,0,0.95)",
    paddingBottom: "14%",
    lineHeight: 1.65,
    previewBg: "#0a0a0a",
    previewActive: "#FFD700",
  },

  highlight: {
    id: "highlight",
    label: "Highlight",
    fontFamily: "'Sarabun', sans-serif",
    fontSize: 60,
    fontWeight: 800,
    activeColor: "#000000",
    inactiveColor: "#FFFFFF",
    activeTextShadow: "none",
    inactiveTextShadow: outline(2),
    activeBackground: "#FFE000",   // yellow pill behind active word
    activeTextColor: "#000000",
    paddingBottom: "13%",
    lineHeight: 1.7,
    previewBg: "#111",
    previewActive: "#FFE000",
  },

  // ── New styles ──────────────────────────────────────────────

  cinema: {
    id: "cinema",
    label: "Cinema",
    fontFamily: "'Mitr', sans-serif",
    fontSize: 52,
    fontWeight: 400,
    activeColor: "#FFFFFF",
    inactiveColor: "#CCCCCC",
    activeTextShadow: "0 1px 3px rgba(0,0,0,0.9)",
    inactiveTextShadow: "0 1px 3px rgba(0,0,0,0.7)",
    boxBackground: "rgba(0,0,0,0.82)",
    boxBorderRadius: 6,
    boxPadding: "8px 28px",
    paddingBottom: "10%",
    lineHeight: 1.6,
    letterSpacing: "0.015em",
    previewBg: "#1a1a2e",
    previewActive: "#FFFFFF",
  },

  fire: {
    id: "fire",
    label: "Fire",
    fontFamily: "'Kanit', sans-serif",
    fontSize: 64,
    fontWeight: 900,
    activeColor: "#FF6B00",
    inactiveColor: "#FFFFFF",
    activeTextShadow: `0 0 10px #FF6B00, 0 0 25px #FF4500, 0 0 50px rgba(255,69,0,0.6), ${outline(3)}`,
    inactiveTextShadow: outline(2),
    paddingBottom: "12%",
    lineHeight: 1.5,
    previewBg: "#100500",
    previewActive: "#FF6B00",
  },

  white: {
    id: "white",
    label: "White",
    fontFamily: "'Sarabun', sans-serif",
    fontSize: 62,
    fontWeight: 800,
    activeColor: "#FFFFFF",
    inactiveColor: "#DDDDDD",
    activeTextShadow: `${outline(4)}, 0 0 10px rgba(255,255,255,0.25)`,
    inactiveTextShadow: outline(3),
    paddingBottom: "13%",
    lineHeight: 1.55,
    previewBg: "#333",
    previewActive: "#FFFFFF",
  },

  pink: {
    id: "pink",
    label: "Pink",
    fontFamily: "'Prompt', sans-serif",
    fontSize: 58,
    fontWeight: 700,
    activeColor: "#FF2D9C",
    inactiveColor: "#AAAAAA",
    activeTextShadow: "0 0 10px #FF2D9C, 0 0 24px #FF2D9C, 0 0 50px rgba(255,45,156,0.5)",
    inactiveTextShadow: "0 0 3px rgba(255,255,255,0.1)",
    boxBackground: "rgba(10,0,20,0.78)",
    boxBorderRadius: 8,
    boxPadding: "10px 24px",
    paddingBottom: "12%",
    lineHeight: 1.55,
    letterSpacing: "0.01em",
    previewBg: "#0a0010",
    previewActive: "#FF2D9C",
  },

  blue: {
    id: "blue",
    label: "Blue",
    fontFamily: "'Sarabun', sans-serif",
    fontSize: 60,
    fontWeight: 800,
    activeColor: "#FFFFFF",
    inactiveColor: "#FFFFFF",
    activeTextShadow: "none",
    inactiveTextShadow: outline(2),
    activeBackground: "#2979FF",
    activeTextColor: "#FFFFFF",
    paddingBottom: "13%",
    lineHeight: 1.7,
    previewBg: "#0a1929",
    previewActive: "#2979FF",
  },
};

export const CAPTION_STYLE_IDS = Object.keys(CAPTION_STYLES) as CaptionStyleId[];
export const DEFAULT_CAPTION_STYLE: CaptionStyleId = "tiktok";

/** Google Fonts import URL covering all styles */
export const FONTS_IMPORT_URL =
  "https://fonts.googleapis.com/css2?family=Sarabun:wght@400;500;700;800&family=Kanit:wght@700;900&family=Prompt:wght@600;700&family=Mitr:wght@400;500;600&display=swap";
