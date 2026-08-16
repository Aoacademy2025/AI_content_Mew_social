export type SceneRerollCapability =
  | { available: true; reason: "available"; message: null }
  | {
      available: false;
      reason: "legacy_project_missing_visual_context";
      message: string;
    };

/**
 * Scene Reroll is a property of a completed job's persisted visual pin, not of
 * the account subscription. Paid access is still enforced by the generation
 * route; this capability only prevents legacy projects from advertising an
 * action the route must deterministically reject.
 */
export function resolveSceneRerollCapability(input: {
  projectId?: string | null;
  contentPreflightId?: string | null;
  hasProjectVisualContext: boolean;
}): SceneRerollCapability {
  if (input.projectId && input.contentPreflightId && input.hasProjectVisualContext) {
    return { available: true, reason: "available", message: null };
  }
  return {
    available: false,
    reason: "legacy_project_missing_visual_context",
    message: "คลิปเก่ายังไม่มีข้อมูลฉากสำหรับลองภาพใหม่ กรุณาสร้างคลิปใหม่เพื่อใช้ฟีเจอร์นี้",
  };
}
