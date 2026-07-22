export const HERO_AI_BROLL_FPS = 30;
export const HERO_AI_BROLL_MIN_MOTION_SEC = 5;
export const HERO_AI_BROLL_RENDER_SAFETY_SEC = 1;
export const HERO_AI_BROLL_MAX_WINDOW_SEC = 600;

export type HeroAiWindowGenerationPlanItem = {
  keyword: string;
  sourceIndex: number;
  kenBurnsDurationSec: number;
};

function motionDurationForWindow(windowDurationSec: number): number {
  const safeWindowDuration = Number.isFinite(windowDurationSec) && windowDurationSec > 0
    ? Math.min(HERO_AI_BROLL_MAX_WINDOW_SEC, windowDurationSec)
    : 0;
  const required = Math.max(
    HERO_AI_BROLL_MIN_MOTION_SEC,
    safeWindowDuration + HERO_AI_BROLL_RENDER_SAFETY_SEC,
  );
  return Math.ceil(required * HERO_AI_BROLL_FPS) / HERO_AI_BROLL_FPS;
}

/**
 * Auto Hero AI Image owns one generated asset per semantic B-roll window.
 * The plan never silently clamps or samples the window list: billing preflight
 * decides whether all images can be afforded before any provider job starts.
 */
export function planHeroAiWindowGeneration(
  keywords: string[],
  windowDurationsSec: number[],
): HeroAiWindowGenerationPlanItem[] {
  return keywords.map((keyword, sourceIndex) => ({
    keyword,
    sourceIndex,
    kenBurnsDurationSec: motionDurationForWindow(windowDurationsSec[sourceIndex] ?? 0),
  }));
}
