"use client";

/**
 * Browser signals that gate the first-clip convert prompt (issue #303).
 *
 * `hero-first-clip-completed` (dispatched by the Editor job poller) stays the
 * source of truth that a clip finished. These signals answer the *other* half:
 * has the customer actually got the finished clip in front of them, and is a
 * render currently owning the screen. The prompt never opens on burn-complete
 * alone.
 */

export const FIRST_CLIP_COMPLETED_EVENT = "hero-first-clip-completed";
/** The exported-clip screen just mounted — start the calm reveal delay. */
export const FIRST_CLIP_EXPORTED_VIEW_EVENT = "hero-first-clip-exported-view";
/** The customer pressed ดาวน์โหลด / ดูใน Gallery — they have the clip; reveal now. */
export const FIRST_CLIP_VIEWED_EVENT = "hero-first-clip-viewed";
/** A render is in flight (true on mount of the rendering screen, false on unmount). */
export const FIRST_CLIP_RENDER_ACTIVE_EVENT = "hero-first-clip-render-active";

function dispatch(name: string, detail?: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(detail === undefined ? new Event(name) : new CustomEvent(name, { detail }));
  } catch {
    // Telemetry-grade signal: never let it break the screen it is announcing.
  }
}

export function emitFirstClipExportedView() {
  dispatch(FIRST_CLIP_EXPORTED_VIEW_EVENT);
}

export function emitFirstClipViewed() {
  dispatch(FIRST_CLIP_VIEWED_EVENT);
}

export function emitFirstClipRenderActive(active: boolean) {
  dispatch(FIRST_CLIP_RENDER_ACTIVE_EVENT, { active });
}

export function readRenderActiveDetail(event: Event): boolean {
  const detail = (event as CustomEvent<{ active?: unknown }>).detail;
  return detail?.active === true;
}
