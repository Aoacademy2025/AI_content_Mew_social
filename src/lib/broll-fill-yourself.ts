/**
 * HERO-44 (b): a "ใส่ B-roll เอง" video contacts no stock or image provider, but its empty
 * windows should still be fillable with Hero AI Image afterwards. Per-window AI is Scene
 * Reroll, which needs the scene plan the content preflight produces — so the plan is made
 * for accounts that can actually open that tab, and skipped (no LLM spend) for the rest.
 */
export function fillYourselfWantsScenePlan(input: {
  stockSource: string | undefined;
  projectId: string | null | undefined;
  canUseHeroAiImage: boolean;
}): boolean {
  return input.stockSource === "none" && Boolean(input.projectId) && input.canUseHeroAiImage;
}
