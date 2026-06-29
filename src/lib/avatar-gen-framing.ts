// Single source of truth for the HeyGen GEN framing (character.{scale,offset}) sent at
// avatar generation. This is the GEN layer (how HeyGen frames the avatar inside its own
// 720×1280 green video) — NOT the composite layer (that's avatar-layout.ts / AvatarPreset).
// Lives here so the editor, MCP, and the API route share ONE value and can't drift — the
// C1 bug was three callers each hardcoding their own scale while the route default was dead.
// offset is a HeyGen frame fraction: positive y = down, so a small negative y lifts the avatar.
// VALUE finalized via render-on-green QA (2026-06-30) on avatar 83f8… (duckyhero, Beta key):
// at scale 1.0/y 0 the avatar rendered small + low; 1.6/-0.12 frames a whole, centered
// presenter (head ~25% from top, uncut) — clearly bigger than before while staying conservative
// enough to generalize. Per-avatar variance is handled by the composite preset + first-time pause.
export type GenFraming = { scale: number; offsetX: number; offsetY: number };
export const HEYGEN_GEN_FRAMING: GenFraming = { scale: 1.6, offsetX: 0, offsetY: -0.12 };
