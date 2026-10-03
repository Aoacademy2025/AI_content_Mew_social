/**
 * The budget of FREE b-roll re-renders (the `rerenderOf` charge-skip in /api/videos/render):
 * 10 accepted skips per user per hour, sliding window, in-process. Mirrors
 * `tryConsumeKieImageRate`. With RENDER_VIA_QUEUE=1 every render funnels through the one
 * Next.js render route, so a per-process window is the effective ceiling.
 *
 * T5 (G4): extracted from the render route so the MCP free-render pre-check
 * (`assertMcpRenderFree`) reads the SAME window instead of a copy. The window is anchored on
 * `globalThis` so every route bundle in the Next.js process shares one Map.
 */
export const RERENDER_SKIP_WINDOW_MS = 60 * 60 * 1000; // 1 hour
export const RERENDER_SKIP_RATE_PER_HOUR = 10;

const globalForRerenderBudget = globalThis as unknown as {
  __heroRerenderSkipHits?: Map<string, number[]>;
};
const rerenderHits: Map<string, number[]> =
  globalForRerenderBudget.__heroRerenderSkipHits ?? new Map<string, number[]>();
globalForRerenderBudget.__heroRerenderSkipHits = rerenderHits;

function recentHits(userId: string, now: number): number[] {
  const cutoff = now - RERENDER_SKIP_WINDOW_MS;
  return (rerenderHits.get(userId) ?? []).filter((t) => t > cutoff);
}

/**
 * Consume one free re-render slot. Call ONLY when a re-render is otherwise valid for the
 * skip — an over-limit re-render returns false and the route falls through to normal charging.
 */
export function tryConsumeRerenderRate(userId: string, now: number = Date.now()): boolean {
  const recent = recentHits(userId, now);
  if (recent.length >= RERENDER_SKIP_RATE_PER_HOUR) {
    rerenderHits.set(userId, recent);
    return false;
  }
  recent.push(now);
  rerenderHits.set(userId, recent);
  return true;
}

/** Read-only peek: would one more free re-render fit in this user's window right now? */
export function rerenderSkipBudgetAvailable(userId: string, now: number = Date.now()): boolean {
  return recentHits(userId, now).length < RERENDER_SKIP_RATE_PER_HOUR;
}
