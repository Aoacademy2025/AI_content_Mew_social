/**
 * Client-safe helpers for the /admin overview page. `admin-trends.server.ts` pulls in `prisma`
 * and `readDisk` (which import `fs`/`child_process`) at module scope, so a "use client" component
 * cannot import anything from it by value without dragging those Node built-ins into the browser
 * bundle (Next.js resolves the whole module once any binding is imported, not just the ones used).
 * This file holds only the pure pieces the client genuinely needs; admin-trends.server.ts
 * re-exports `defaultTrendDays` from here so server-side callers keep one import path.
 */

/** Narrow viewports cannot read 30 bars, so they open on 14. Pure — the client picks the default. */
export function defaultTrendDays(viewportWidth: number): 14 | 30 {
  return viewportWidth < 640 ? 14 : 30;
}
