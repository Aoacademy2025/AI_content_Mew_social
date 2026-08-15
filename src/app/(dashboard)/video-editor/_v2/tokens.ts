/**
 * Editor v2 design tokens — from Design System v1.1 (design_handoff_editor_redesign).
 * Single source for the v2 surface; don't inline raw hex in v2 components.
 */

export const color = {
  // Backgrounds
  bg0: "#0A0A10",          // พื้นจอ
  bg1: "#0F0F17",          // แผงข้าง (ทึบ ไม่ glass)
  bgTimeline: "#0C0C13",   // โซน timeline

  // Card surfaces
  cardBg: "rgba(255,255,255,.03)",
  cardBorder: "rgba(255,255,255,.08)",

  // Primary
  gradientPrimary: "linear-gradient(180deg,#8B66F8,#6C4CF4)",
  primary500: "#8B5CF6",   // radio/selected, focus, slider fill
  primary300: "#B9A6FF",   // ข้อความเน้น
  link: "#9B7DFF",

  // Selected (การ์ด/ชิปที่เลือก)
  selectedBg: "rgba(139,92,246,.10)",
  selectedBorder: "rgba(167,139,250,.45)",
  selectedBorderStrong: "rgba(167,139,250,.55)",

  // Text
  text: "#F2F2F8",
  textSecondary: "#9C9CB4",
  textFaint: "#6A6A85",
  textFaintest: "#55556E",

  // Status
  success: "#34D399",
  warning: "#FBBF24",
  warningText: "#FCD34D",
  danger: "#F87171",
  dangerText: "#FCA5A5",
  info: "#38BDF8",
  infoText: "#7DD3FC",

  // Track colors (คงที่ทั้งระบบ)
  trackAvatar: "#8B5CF6",
  trackBroll: "#38BDF8",
  trackHook: "#F97316",
  trackSub: "#FBBF24",
  trackVoice: "#34D399",
  trackMusic: "#F472B6",

  // Subtitle keyword accent (ในวิดีโอ)
  subAccent: "#FFE500",
} as const;

export const radius = {
  pill: 999,
  control: 11,   // ปุ่ม/ช่องกรอก 10–12
  card: 12,      // การ์ด 12–16
  cardLg: 16,
  panel: 22,     // แผงลอย/dock 20–22
  clip: 7,       // คลิป timeline 7–8
  iconTile: 9,
} as const;

export const shadow = {
  primaryBtn: "0 8px 26px rgba(108,76,244,.35)",
  focusRing: "0 0 0 3px rgba(139,92,246,.18)",
} as const;

/** Liquid glass — ใช้เฉพาะชั้นที่ "ลอย" (แผงเรนเดอร์, modal, dock); แผงติดขอบจอ = ทึบ bg1 เสมอ */
export const glass = {
  background: "rgba(22,22,36,.55)",
  backdropFilter: "blur(28px) saturate(150%)",
  border: "1px solid rgba(255,255,255,.12)",
  boxShadow: "0 24px 80px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.08)",
} as const;

/** Font stacks — ตัวโหลดจริงอยู่ใน fonts.ts (next/font) ซึ่ง set CSS vars เหล่านี้ที่ root ของ v2 */
export const font = {
  heading: "var(--font-kanit), Kanit, 'Noto Sans Thai', sans-serif",       // หัวข้อ ปุ่ม ตัวเลขเด่น
  body: "var(--font-noto-thai), 'Noto Sans Thai', Kanit, sans-serif",      // เนื้อหา UI ฟอร์ม คำอธิบาย
} as const;

/** Interaction constants */
export const fx = {
  transition: "all 150ms ease",
  hoverBrightness: "brightness(1.08)",
} as const;
