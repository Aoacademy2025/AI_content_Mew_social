/**
 * Hero Script v2 design tokens — aligned with Video Editor v2's visual language
 * (Kanit headings, Noto Sans Thai body, violet gradient primary, semantic track
 * accents for HOOK / BODY / CTA) while staying theme-adaptive via `--ui-*` CSS
 * custom properties for both Dark and Light dashboard themes.
 */

export const HS_COLOR = {
  violet: "#8B5CF6",
  violetSoft: "rgba(139,92,246,.12)",
  violetBorder: "rgba(139,92,246,.40)",
  violetGradient: "linear-gradient(180deg,#8B66F8,#6C4CF4)",
  violetShadow: "0 6px 20px rgba(108,76,244,.30)",

  // Semantic section track colors (mirror video-editor/_v2/tokens.ts)
  hook: "#F97316",
  hookBg: "rgba(249,115,22,.14)",
  hookBorder: "rgba(249,115,22,.32)",

  body: "#0EA5E9",
  bodyBg: "rgba(14,165,233,.14)",
  bodyBorder: "rgba(14,165,233,.32)",

  cta: "#10B981",
  ctaBg: "rgba(16,185,129,.14)",
  ctaBorder: "rgba(16,185,129,.32)",

  // Pacing status colors
  ok: "#10B981",
  warn: "#F59E0B",
  danger: "#EF4444",
} as const;

export const HS_FONT = {
  heading: "var(--font-kanit), Kanit, 'Noto Sans Thai', sans-serif",
  body: "var(--font-noto-thai), 'Noto Sans Thai', Kanit, sans-serif",
} as const;
