export const HEYGEN_AVATAR_ENGINES = ["avatar_iii", "avatar_iv", "avatar_v"] as const;

export type HeyGenAvatarEngine = (typeof HEYGEN_AVATAR_ENGINES)[number];
export type HeyGenAvatarApiVersion = "v2" | "v3";

export const HEYGEN_ENGINE_LABELS: Record<HeyGenAvatarEngine, string> = {
  avatar_iii: "Avatar III (เดิม)",
  avatar_iv: "Avatar IV",
  avatar_v: "Avatar V",
};

export const HEYGEN_EXTERNAL_COST_DISCLOSURE =
  "HeyGen คิดค่าบริการแยกตามบัญชีและระยะเวลาที่สร้าง ไม่รวมอยู่ในเครดิต HERO กรุณาตรวจสอบอัตราในบัญชี HeyGen ก่อนยืนยัน";
export const HEYGEN_ENGINE_UNKNOWN_MESSAGE =
  "ยังตรวจสอบรุ่นที่ Avatar นี้รองรับไม่ได้ กรุณาลองใหม่";
export const HEYGEN_ENGINE_INCOMPATIBLE_MESSAGE =
  "Avatar นี้ไม่รองรับรุ่นที่เลือก กรุณาเลือกรุ่นที่รองรับหรือเปลี่ยน Avatar";

export function isHeyGenAvatarEngine(value: unknown): value is HeyGenAvatarEngine {
  return typeof value === "string"
    && (HEYGEN_AVATAR_ENGINES as readonly string[]).includes(value);
}

/** Existing persisted work has no engine field and remains on the legacy III/v2 route. */
export function resolveHeyGenAvatarEngine(value: unknown): HeyGenAvatarEngine {
  return isHeyGenAvatarEngine(value) ? value : "avatar_iii";
}

export function heygenApiVersionForEngine(engine: HeyGenAvatarEngine): HeyGenAvatarApiVersion {
  return engine === "avatar_iii" ? "v2" : "v3";
}

export function heygenLookEngineCompatibility(
  looks: readonly { avatar_id: string; supported_api_engines: readonly HeyGenAvatarEngine[] }[],
  avatarId: string,
  engine: HeyGenAvatarEngine,
): "compatible" | "unknown" | "incompatible" {
  const look = looks.find((candidate) => candidate.avatar_id === avatarId);
  if (!look) return "unknown";
  return look.supported_api_engines.includes(engine) ? "compatible" : "incompatible";
}
