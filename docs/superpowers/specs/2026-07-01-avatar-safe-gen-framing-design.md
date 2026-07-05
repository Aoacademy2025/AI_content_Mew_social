# Avatar Safe Gen Framing — design

**Date:** 2026-07-01
**Author:** Mew (via Claude)
**Branch:** `mew/avatar-safe-gen-framing`
**Status:** approved (design) → implementing

## Problem

Support ticket `bunchar@aoacademy.co` (PRO): AI-avatar renders come out **head cut off** ("หัวขาด"), in every mode, and no amount of composite position/scale adjustment fixes it.

**Confirmed root cause (prod render evidence — frames pulled from `composite-1782878948870.mp4` / `composite-1782879899276-bookend.mp4`):** the head is cut at the **generation** layer, not composite. We send HeyGen `character.scale = 1.6, offset.y = -0.12` at generation time; this zoom + upward lift is baked into HeyGen's 720×1280 output, pushing the head off the top of the frame for **tightly-framed avatars** (e.g. bunchar's photo-avatar). The composite faithfully places an already-headless source — and because `offset.y` positive only shifts the (headless) frame down, no composite adjustment can recover a head that was never rendered. Above the cut, the composite shows clean b-roll (the source region there was green), which proves the head was absent from the source.

**Why it varies per user:** `HEYGEN_GEN_FRAMING` was retuned to `1.6` on 2026-06-30 against **one** avatar (duckyhero `83f8…`, a wide-framed avatar where even 1.7 stayed uncut). A single global zoom cannot fit all avatars: wide ones need a big scale to not look tiny; tight ones get their heads cut by it.

**Key asymmetry (the design principle):**
- Gen **too big** → head/limbs cut → **unrecoverable** in composite.
- Gen **too small** → whole but small → **recoverable** (user scales/positions up in the composite, with a live preview).

So the gen default must **err small** (whole avatar guaranteed); sizing-up is the composite's job.

## Scope discovery — multiple gen paths, divergent values

There is no true single source for gen framing today:

| Path | Live? | gen scale/offset | Action |
|---|---|---|---|
| `video-editor/page.tsx` (bunchar's path) | ✅ | `HEYGEN_GEN_FRAMING` = 1.6 / −0.12 | **fix via constant** |
| `lib/mcp/avatar-steps.ts` (create via chat) | ✅ | `HEYGEN_GEN_FRAMING` = 1.6 / −0.12 | **fix via constant** |
| `video-creator/page.tsx` | ✅ (admin + content flow) | own `avatarScale` state, default **1.0** / 0 (user-adjustable) | already safe; couple default to constant (anti-drift) |
| `api/videos/create-avatar` | ❌ no callers | hardcoded **2.02** / +0.28 (×2) | align to constant (landmine) |
| `api/videos/heygen-direct` | ❌ no callers | hardcoded **2.02** / +0.28 | align to constant |
| `api/heygen/test-avatar` | ❌ test/dev | hardcoded **2.02** / +0.28 | align to constant |

## Design (approved: "whole avatar by default, user zooms in composite")

1. **Single safe gen value.** `HEYGEN_GEN_FRAMING` → `{ scale: 1.0, offsetX: 0, offsetY: 0 }` = HeyGen's native framing = whole avatar for every avatar type. `1.0` is the only value that guarantees no gen-cut without per-avatar knowledge (any zoom > 1.0 risks the tightest avatar; the upward lift is what specifically cut heads, so it goes to 0). Fixes editor + MCP together (they share the constant).
2. **Neutralize the divergent paths.** The three dead 2.02 routes import and use `HEYGEN_GEN_FRAMING` instead of hardcoded values (prevents the bug resurfacing if resurrected). `video-creator`'s `avatarScale` default references `HEYGEN_GEN_FRAMING.scale` (value-identical 1.0; keeps its user-adjustable gen-scale UX).
3. **Composite = the sizing surface (unchanged).** `OrderPanel` scale/offset + the live WYSIWYG preview already let users enlarge/position. Because gen now brings the whole avatar in, any composite zoom is previewed → no surprise cut. No new UI.
4. **Reset stale `AvatarPreset` rows (prod data op).** Existing presets were calibrated against the old (head-cut) gen and are now mis-positioned (e.g. bunchar `scale 1 / offX 1 / offY 195`). Reset to default `{scale 1, offX 0, offY 0}` so users start from the whole-avatar default (composite default already shows the whole frame). Precedent: 06-30 deleted duckyhero's stale preset for the same reason.

## Data flow (unchanged except the value)

`editor/MCP → generate-with-bg (character.scale = HEYGEN_GEN_FRAMING.scale) → HeyGen 720×1280 green (now whole avatar) → composite (clampAvatarLayout/layoutGeometry, default scale 1 = whole frame shown) → burn`.

## Error handling

No new failure modes. The constant is destructured with defaults in `generate-with-bg/route.ts`; `safeOffset` still clamps client offsets to HeyGen's −1..1. `clampAvatarLayout` still no-ops scale≈1/offset≈0 to the legacy full-cover path. Non-avatar renders are untouched.

## Testing / verification

- **TDD guard** `scripts/verify-avatar-gen-framing.ts` (tsx): asserts `HEYGEN_GEN_FRAMING` = `{1.0,0,0}`, invariants `scale ≤ 1.0` and `offsetY === 0` (the "no gen-cut" guarantee), and scans the gen route/page/lib files to assert the banned literals `2.02` and `1.6` no longer appear in a `character` gen payload (anti-drift).
- **Build:** `tsc` clean.
- **Visual (render-on-green):** regen duckyhero `83f8…` at 1.0/0 (Mew's HeyGen Beta key, ~1 credit) to confirm whole avatar; 06-30 QA already showed 1.0 = whole-but-small, so this is confirmation, not a blocker.

## Rollout

Feature branch → build-verify → merge to `main` → `deploy.sh` (no schema change; `prisma db push` no-op). **Deploy clear of in-flight generations** (team rule). Then reset `AvatarPreset` rows on prod. Rollback = revert the constant commit + redeploy; presets can be left reset (safe).

## Trade-offs

- Reverses "avatar size 1.6 FINAL" (06-30) — approved: default avatar is smaller / more headroom; users zoom in composite.
- Regression risk **low**: one constant + dead-route alignment + preset reset, all inside the avatar path.
- Not solved here (future, if wanted): per-avatar *optimal* auto-sizing (content-box auto-fit) — Option 2 from brainstorming, deferred.
