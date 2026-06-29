# Design Spec — Avatar Framing WYSIWYG (decouple position from gen)

**Date:** 2026-06-30
**Author:** Mew (+ agent)
**Status:** Approved (design), pending spec review → implementation plan
**Approach:** **C** (decouple positioning from gen) with **B** (tuned gen default) folded in as step 1.
**Builds on:** `2026-06-29-avatar-position-lock-design.md` (the position-lock + preset feature that shipped). This spec fixes why that lock never looked right at render time.

---

## 1. Problem

When a user enables a HeyGen avatar in the Video Editor, positions it so it looks full in the preview box, then renders — **the rendered avatar comes out small and low**, not matching the preview. The user must re-expand and re-render (re-gen) repeatedly, burning HeyGen credits.

### Root cause (confirmed with prod evidence, 2026-06-29/30)

There are **two independent scale/offset layers**:

| Layer | Where | Cost to change | Controls |
|---|---|---|---|
| **GEN framing** | `scale`/`offset` sent to HeyGen (`character.{scale,offset}`) | Expensive — a full re-gen (15-25 min, BYOK credit) | How the avatar is framed *inside* the 720×1280 green video |
| **COMPOSITE layout** | `avatarScale/OffsetX/OffsetY` → `layoutGeometry` in `composite/route.ts` | Cheap — composite only (seconds, free) | How the green video is placed on the 1080×1920 canvas |

Two failures stack:

1. **Preview shows a different image than the render uses.** The position box (`OrderPanel.tsx:832-837`) renders the HeyGen **thumbnail** (`avatarPreviewUrl` — a tight, large headshot) whenever no green video is loaded yet. The render uses the **green-screen video**, which HeyGen frames *wide and small* at the current gen scale `1.0`. The geometry math (scale/offset → pixels) is **identical** between preview and composite (verified: `OrderPanel.tsx:833` `50+offset/4 %` == `avatar-layout.ts layoutGeometry` == `normalizedBox`). The numbers match; **the source images don't.** Positioning against the thumbnail is positioning against a lie.

2. **Bad gen default makes the raw material small.** At gen scale `1.0`, HeyGen frames the avatar small with large headroom → at composite scale ≈ 1 the avatar passes through small and low. To compensate the user must crank composite scale way up (digital zoom → blur) and push offset.

**Decisive evidence:** prod `AvatarPreset` row for `duckyhero / 83f8…` = `{scale 1.03, offsetX −8, offsetY 57}`, and the composite log for the matching render = `scale=1.03 offsetPx=(−8,57)` — **identical to the decimal.** So the render is 100% faithful to the saved preset; the preset itself encodes "small + pushed down", because it was tuned against the misleading thumbnail. A prior render at `scale=2.18` (the "full" one) was never saved as the preset.

### Secondary bug (in scope)

The per-avatar preset-load effect (`page.tsx:333-348`) overwrites the live editor layout on the avatar-validation edge (invalid→valid). Because validation takes a few seconds (`avatar-info`), an adjustment made before validation completes gets clobbered by the saved (stale) preset. The "no preset saved" path (`:340`, `:342`) returns **without** setting the `loadedPresetFor` guard, so it isn't a clean one-shot.

---

## 2. Goals / Non-goals

### Goals
- **WYSIWYG:** what the user positions against == what renders.
- **One gen per clip.** Positioning iteration must never trigger a re-gen.
- **Good default framing** so most renders look right with zero adjustment.
- **Per-avatar preset stays portable** across clips (already true; don't regress).
- No data loss; additive deploy.

### Non-goals
- HeyGen v3 / `fit:contain/cover` (returns avatar on its own background → can't chroma-key; only for a future no-broll mode).
- Per-avatar *automatic* gen framing detection (one tuned constant + cheap composite adjust is enough).
- Reworking the chroma-key / despill math, offset units, or canvas dimensions.
- The creator (`/video-creator`) thumbnail preview — editor-centric flow; creator deferred.

---

## 3. Design

### Principle
**Gen is the expensive, once-per-clip step. Composite is the cheap, re-runnable step. Move all positioning to the composite layer, performed against the *real* green video, and make the gen default good so the first composite already looks right.**

### Component 3.1 — Tune the gen default (B)
- Replace gen scale `1.0` with a validated constant that frames a "head + upper body" shot, larger and centered, without cutting heads. Likely scale ≈ 1.4-1.7 + small `offset.y` upward; **the exact value is determined empirically** via render-on-green tests across several real avatars (Mew's "Mew Social" + at least one other, e.g. the striped-shirt male avatar). Validate: avatar enters whole (no head/arm cut) and reasonably large.
- **Critical (C1 lesson):** the gen scale is read from **per-caller constants**, not the route default. ALL callers must change together:
  - `src/app/(dashboard)/video-editor/page.tsx:2307` `HEYGEN_FRAMING` (used at `:2358` runAvatar, `:2507` runAvatarTail)
  - `src/lib/mcp/avatar-steps.ts:6` `HEYGEN_FRAMING` (used at `:73`)
  - `src/app/api/heygen/generate-with-bg/route.ts:13-14` `HEYGEN_GEN_SCALE`/`HEYGEN_GEN_OFFSET_Y` (route default — keep in sync as the fallback)
- Consider extracting a single shared constant (e.g. `src/lib/avatar-gen-framing.ts`) so there is one source of truth and no caller can drift again.
- `DEFAULT_AVATAR_LAYOUT` (`avatar-preset.ts:5`) stays `{1,0,0}` — composite passes the (now well-framed) green through 1:1 by default. (Note `clampAvatarLayout` returns null at exactly `{1,0,0}` → legacy full-cover path, which is the correct pass-through.)

### Component 3.2 — Honest preview (never position against the thumbnail)
- Position box shows the **real green video** (`avatarGreenUrl`) whenever it exists (already supported at `OrderPanel.tsx:834-835`).
- Before any green exists, show the thumbnail **dimmed** with a clear label: positioning is approximate until the first render. The existing pre-gen note ("รูปตัวอย่าง · พื้นหลังจะถูกลบตอน render") is extended to set this expectation.
- Persist `avatarGreenUrl` so reopening a draft keeps showing the real green (it's already saved in drafts at `loadDraftInto:942`); ensure the position box prefers it over the thumbnail after reload.

### Component 3.3 — Pause-before-composite (first-time per avatar) + free re-composite
The web render pipeline gains a **pause point between avatar gen and composite**, used only for first-time setup of an avatar:

- **No saved preset for this (user, avatarId):** after the bg render + avatar gen complete, the pipeline **stops before composite** and surfaces the **real green video** in the position box. The user positions/scales against the real avatar, then clicks **"ต่อ → ประกอบ"** → composite runs (seconds, free) → the produced output already matches what they positioned. Saving the position writes the preset.
- **Saved preset exists:** **no pause** — the pipeline runs straight through (gen → composite using the saved preset) → avatar correct immediately. The product's "one script → finished video" automation holds for all but the first clip of each avatar.
- **After the first composite (either path):** the position panel keeps a **"ปรับตำแหน่ง → ประกอบใหม่"** action that re-runs **composite only**, reusing the cached green + bg. Unlimited cheap iteration, no re-gen.

Timing note: the pause necessarily lands **after** the 15-25 min gen (positioning needs the real green, which only exists post-gen). Flow is "render → wait for gen → position → continue (seconds)", not "position then long render".

Implementation reuses `runComposite(bgVideoUrl, avatarUrl)` (`page.tsx:2441`) with current `avatarScale/OffsetX/OffsetY` and cached urls (`avatarGreenUrl` in state; bg from the pipeline cache `pipe.current.*` — exact field confirmed in the plan). The pause is a pipeline-state gate between the existing discrete `avatar` and `composite` steps. Re-composite is enabled only when both a green avatar video and a bg render exist.

### Component 3.6 — MCP / chat path (no pause; consumes the preset)
The MCP path **cannot pause** (no interactive UI). It already **loads and applies the saved preset** — verified wired at `src/app/api/[transport]/route.ts:155-162`:
```js
const avatarLayout = resolveAvatarLayout(
  { avatarScale: args.avatarScale, ... },     // caller-supplied wins per-axis
  await getAvatarPreset(p.userId, avatar.avatarId),  // else the saved preset
);                                             // else DEFAULT_AVATAR_LAYER
```
So MCP behavior is unchanged by this work *except*: the **B gen-default change must include `src/lib/mcp/avatar-steps.ts:6`** (`HEYGEN_FRAMING`) so MCP-gen'd green is framed identically to web → the same preset applies correctly across both surfaces. Relationship: **web = set the preset (with first-time pause); preset = portable result; MCP = consume it (or the tuned default).** A pure-chat user with no preset gets the good default (B); MCP may advise setting position once in the web editor for an exact fit (optional copy, low priority).

### Component 3.4 — Preset load without clobbering live edits
- The preset-load effect (`page.tsx:333-348`) must not overwrite a layout the user has already touched this session. Options (decide in plan): only apply the preset before the first user interaction with the position controls; or set `loadedPresetFor` on *all* exit paths (including no-preset) so it is a true one-shot per avatarId.
- Save/load round-trip stays as-is (`onSaveAvatarLayout` PUT at `:2422`; GET at `:339`).

### Component 3.5 — Fix the existing bad preset data (prod)
- `duckyhero / 83f8…` preset `{1.03,−8,57}` was saved against the thumbnail and is wrong. After 3.1 ships, either delete it (falls back to the good default) or overwrite with a good full value Mew confirms. **Write to prod — requires Mew's explicit OK + value.** One-row SQL.

---

## 4. User flow (result)

**Gen count = 1 per clip.** Positioning iteration = free (composite only).

### New avatar (no preset) — pipeline **pauses** for one-time setup
1. Enter script + avatar ID. Position box shows thumbnail dimmed + "ปรับตำแหน่งจริงได้หลัง render รอบแรก".
2. Render → b-roll/voice + avatar **gen #1** (15-25 min) → **⏸️ pauses before composite**, showing the **real green avatar**.
3. User positions/scales against the real avatar → 💾 Save ตำแหน่ง → **"ต่อ → ประกอบ"** → composite (seconds, free) → output matches the chosen position.
4. Want to tweak more → drag → "ปรับตำแหน่ง → ประกอบใหม่" (composite only, free, repeatable).
5. Burn & Download.

### Same avatar, later clips (preset exists) — **no pause**, fully automatic
1. New script + same avatar → preset auto-loads.
2. Render → **gen once** → composite uses saved preset → avatar correct immediately (no pause).
3. Burn & Download.

### MCP / chat (any clip) — **no pause**
1. `create_video_job` → server pipeline runs straight through → composite uses the saved preset (or tuned default if none).
2. Poll `get_video_status` → done. (No interactive positioning; users set the preset once via the web editor.)

**One limitation (accepted):** the very first clip of a new avatar needs one render before faithful fine-tuning is possible (true pre-render WYSIWYG would require an extra sample gen = approach A, rejected for cost). The tuned default (B) covers this so the first render is usually already good.

---

## 5. Affected units

| File | Change |
|---|---|
| `src/lib/avatar-gen-framing.ts` (new, optional) | Single source for gen scale/offset |
| `src/app/(dashboard)/video-editor/page.tsx` | gen constant; preset-load clobber guard; **pause-before-composite gate (first-time, no-preset)** + re-composite action; prefer green over thumbnail |
| `src/lib/mcp/avatar-steps.ts` | gen constant (keep MCP in sync) |
| `src/app/api/heygen/generate-with-bg/route.ts` | gen default in sync |
| `src/app/(dashboard)/video-editor/_components/OrderPanel.tsx` | dimmed-thumbnail + honest label; "re-composite" button; enable/disable logic |
| prod `AvatarPreset` (data) | fix duckyhero's stale row |

No schema change. Deploy = `git pull` + `prisma db push` (additive) + build + restart; presets survive (db gitignored, push additive).

---

## 6. Error handling
- Re-composite with missing green/bg → button disabled (no silent no-op).
- Gen-default change must not break the `clampAvatarLayout` null/legacy path or the bookend/bookend-both composite paths.
- MCP path (`avatar-steps.ts`) keeps applying the saved preset; gen constant change must keep MCP renders consistent with web.

## 7. Testing
- `npx tsc --noEmit` + existing verify suites: `verify-avatar-layout-geometry` (geometry unchanged), `verify-avatar-preset`, `verify-mcp-avatar-input`, `verify-avatar-steps`, `verify-heygen-avatar-*`.
- New unit coverage for the preset-load clobber guard.
- **Render-on-green QA** for B: gen on `#00FF00` across ≥2 real avatars, pull a frame, confirm whole-avatar + good size at the chosen constant. (Needs Mew-authorized read-only SSH for the HeyGen key; Beta = cheap.)
- Manual e2e (Mew, chrome-devtools): new-avatar flow → render → re-composite cheap iterate → Save → second clip uses preset.

## 8. Rollout
1. **B first (quick win):** tune gen default constants (all callers incl. MCP `avatar-steps.ts:6`) + render-on-green QA → deploy. Immediately improves default framing for web + MCP. Fix duckyhero's stale preset.
2. **Then 3.2-3.4 + 3.6:** honest preview + pause-before-composite (first-time) + re-composite button + clobber guard → deploy. (3.6/MCP needs only the B constant — already wired to consume the preset.)
- Deploy only when no in-flight RenderJob/VideoJob (Mew's rule). Single deploy channel.
