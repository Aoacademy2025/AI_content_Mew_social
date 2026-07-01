// Single source of truth for the HeyGen GEN framing (character.{scale,offset}) sent at
// avatar generation. This is the GEN layer (how HeyGen frames the avatar inside its own
// 720×1280 green video) — NOT the composite layer (that's avatar-layout.ts / AvatarPreset).
// Lives here so the editor, MCP, and the gen routes share ONE value and can't drift.
// offset is a HeyGen frame fraction: positive y = down, negative y lifts the avatar up.
//
// VALUE = HeyGen's native framing (no zoom, no lift) → the WHOLE avatar is always in frame,
// for every avatar. This is deliberate and load-bearing — DO NOT bump the scale up:
//   • 2026-06-30 set this to 1.6/-0.12, tuned on ONE wide avatar (duckyhero 83f8). It CUT THE
//     HEAD of tightly-framed avatars (bunchar ticket 2026-07-01, confirmed from prod frames):
//     the zoom+lift is baked into HeyGen's output, and a head missing from the source can NEVER
//     be recovered in the composite.
//   • Asymmetry: gen-too-BIG = head/limbs cut = unrecoverable; gen-too-SMALL = whole but small
//     = the user scales/positions up in the composite (avatar-layout.ts) with a live preview.
//     So the gen default MUST err small; sizing-up is the composite's job, not the gen's.
// A single global scale can't fit all avatars — 1.0 is the only value that guarantees no cut
// without per-avatar knowledge. (Future optimal-sizing = per-avatar composite auto-fit, not a
// bigger gen scale.) See docs/superpowers/specs/2026-07-01-avatar-safe-gen-framing-design.md.
export type GenFraming = { scale: number; offsetX: number; offsetY: number };
export const HEYGEN_GEN_FRAMING: GenFraming = { scale: 1.0, offsetX: 0, offsetY: 0 };
