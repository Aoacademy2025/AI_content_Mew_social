// Single source of truth for avatar-layer geometry, shared by the ffmpeg composite
// (src/app/api/heygen/composite/route.ts) and the editor preview (RightSettingsPanel).
// Coordinate space ("V2"): scale 1 = full canvas; offset in -400..400 (1080*offset/400 px).
export const CANVAS_W = 1080;
export const CANVAS_H = 1920;

export type AvatarLayout = { scale: number; offsetX: number; offsetY: number };

/** Clamp a raw layout to valid bounds. Returns null when it's a no-op (scale≈1, offset≈0) so the
 *  composite falls back to the legacy full-cover path, or when the input is non-finite/garbage. */
export function clampAvatarLayout(raw: unknown): AvatarLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const scale = Number(o.scale), offsetX = Number(o.offsetX), offsetY = Number(o.offsetY);
  if (!Number.isFinite(scale) || !Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return null;
  const s = Math.min(4, Math.max(0.05, scale));
  const x = Math.min(400, Math.max(-400, offsetX));
  const y = Math.min(400, Math.max(-400, offsetY));
  if (Math.abs(s - 1) < 0.001 && Math.abs(x) < 0.5 && Math.abs(y) < 0.5) return null;
  return { scale: s, offsetX: x, offsetY: y };
}

/** Pixel geometry for ffmpeg overlay: avatar scaled to w×h, placed at (x,y) on the canvas. */
export function layoutGeometry(layout: AvatarLayout): { w: number; h: number; x: number; y: number } {
  const w = Math.round((CANVAS_W * layout.scale) / 2) * 2;
  const h = Math.round((CANVAS_H * layout.scale) / 2) * 2;
  const x = Math.round((CANVAS_W - w) / 2 + (CANVAS_W * layout.offsetX) / 400);
  const y = Math.round((CANVAS_H - h) / 2 + (CANVAS_H * layout.offsetY) / 400);
  return { w, h, x, y };
}

/** True when the scaled avatar extends past the 1080×1920 canvas. */
export function layoutOverflowsCanvas(layout: AvatarLayout): boolean {
  const { w, h, x, y } = layoutGeometry(layout);
  return x < 0 || y < 0 || x + w > CANVAS_W || y + h > CANVAS_H;
}

/**
 * Crop source pixels before chromakey when the layout overflows the canvas.
 * Independent of the stability canary — overflowed full-Avatar jobs time out without this.
 */
export function shouldCropAvatarToVisibleCanvas(layout: AvatarLayout | null): boolean {
  return layout != null && layoutOverflowsCanvas(layout);
}

/** Center-based percentages for the editor preview box (translate(-50%,-50%) positioning). */
export function normalizedBox(layout: AvatarLayout): { centerXPct: number; centerYPct: number; widthPct: number; heightPct: number } {
  return {
    centerXPct: 50 + (layout.offsetX / 400) * 100,
    centerYPct: 50 + (layout.offsetY / 400) * 100,
    widthPct: layout.scale * 100,
    heightPct: layout.scale * 100,
  };
}
