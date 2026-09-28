/** Per-scene place, action, and shot scale sent to the image model. */

export const SCENE_SHOT_SCALES = [
  "wide environmental view",
  "medium observational view",
  "close detail view",
  "overhead view",
  "low angle view",
  "profile view",
  "three-quarter view",
  "distant establishing view",
] as const;

export type SceneShotScale = (typeof SCENE_SHOT_SCALES)[number];

export function pointingGestureRequested(text: string): boolean {
  return /(?:\bpoint(?:s|ing|ed)?\b|\bindex finger\b|ชี้)/iu.test(text);
}

export function shotScaleForAction(action: string): SceneShotScale {
  let hash = 2166136261;
  for (const char of action.trim()) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return SCENE_SHOT_SCALES[(hash >>> 0) % SCENE_SHOT_SCALES.length];
}

/** Same action keeps one scale. Different actions get different scales until the list runs out. */
export function assignDistinctShotScales(actions: readonly string[]): SceneShotScale[] {
  const chosen = new Map<string, SceneShotScale>();
  const result: SceneShotScale[] = [];
  for (const action of actions) {
    const key = action.trim();
    const prior = chosen.get(key);
    if (prior) {
      result.push(prior);
      continue;
    }
    const used = new Set(chosen.values());
    const preferred = shotScaleForAction(key);
    const start = SCENE_SHOT_SCALES.indexOf(preferred);
    let pick = preferred;
    if (used.has(pick)) {
      for (let step = 1; step < SCENE_SHOT_SCALES.length; step += 1) {
        const candidate = SCENE_SHOT_SCALES[(start + step) % SCENE_SHOT_SCALES.length];
        if (!used.has(candidate)) {
          pick = candidate;
          break;
        }
      }
    }
    chosen.set(key, pick);
    result.push(pick);
  }
  return result;
}

export function sceneDiversityClause(input: {
  setting: string;
  action: string;
  shotScale: string;
  allowPointing: boolean;
}): string {
  const place = input.setting.trim() || "the setting named by this scene";
  const action = input.action.trim() || "the action named by this scene";
  const gesture = input.allowPointing
    ? "A pointing gesture is allowed only because this scene action asks for it."
    : "No pointing hand and no pointing finger.";
  return `Scene place: ${place}. Scene action: ${action}. Shot scale: ${input.shotScale}. ${gesture}`;
}
