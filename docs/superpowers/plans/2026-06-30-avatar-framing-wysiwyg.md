# Avatar Framing WYSIWYG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the avatar the user positions against equal the avatar that renders, with one HeyGen gen per clip and a good default framing.

**Architecture:** Two layers stay separate — HeyGen GEN framing (expensive, sets how the avatar sits in the 720×1280 green video) and the COMPOSITE layer (cheap, places the green video on the 1080×1920 canvas). We (B) tune the gen default from a single shared constant, and (C) move all positioning to the composite layer performed against the *real* green video: the web pipeline pauses before composite the first time an avatar is used (no saved preset), and re-composite is free (no re-gen). MCP already consumes the saved preset.

**Tech Stack:** Next.js 15 / React 19 / TypeScript, SQLite+Prisma 6, HeyGen API (BYOK), ffmpeg composite. Tests = `scripts/verify-*.ts` run via `npx tsx` (assert + `process.exit(1)` on fail), plus `npx tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-06-30-avatar-framing-wysiwyg-design.md`

## Global Constraints

- **main = production.** Work on branch `mew/avatar-framing-wysiwyg`. Mew merges + deploys. Deploy only when no in-flight RenderJob/VideoJob.
- **No schema change.** Deploy is additive (`prisma db push`); `AvatarPreset` data must survive.
- **Gen scale lives in ONE shared constant** now — never reintroduce a per-caller hardcoded gen scale (the C1 bug: 3 callers each hardcoded `2.02`/`1.0`, route default was dead).
- **Do NOT change** offset units, canvas dimensions (`CANVAS_W=1080`,`CANVAS_H=1920`), the chroma-key/despill math, or the `clampAvatarLayout` null/full-cover fallback (`avatar-layout.ts`).
- **HeyGen offset is a fraction −1..1** (positive = right/down). **Composite offset is −400..400 px.** Different units — keep them separate.
- HeyGen avatar = PRO/BUSINESS only; BYOK (user's own HeyGen key).
- Two delivery phases: **Phase 1 (B)** is independently deployable as a quick win; **Phase 2 (C)** follows.

---

# PHASE 1 — B: tuned gen default (quick win, deployable alone)

### Task 1: Single shared gen-framing constant + wire all callers

**Files:**
- Create: `src/lib/avatar-gen-framing.ts`
- Modify: `src/lib/mcp/avatar-steps.ts:6`
- Modify: `src/app/api/heygen/generate-with-bg/route.ts:13-14,116-118`
- Modify: `src/app/(dashboard)/video-editor/page.tsx:2307` (and usages at `:2358`, `:2507`)
- Test: `scripts/verify-avatar-gen-framing.ts`

**Interfaces:**
- Produces: `export type GenFraming = { scale: number; offsetX: number; offsetY: number }` and `export const HEYGEN_GEN_FRAMING: GenFraming` from `src/lib/avatar-gen-framing.ts`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-avatar-gen-framing.ts`:
```ts
// Run: npx tsx scripts/verify-avatar-gen-framing.ts
// Locks the single source of truth for HeyGen GEN framing (no per-caller drift — the C1 bug).
import { HEYGEN_GEN_FRAMING } from "../src/lib/avatar-gen-framing";
import { HEYGEN_FRAMING as MCP_FRAMING } from "../src/lib/mcp/avatar-steps";

let p = 0;
const ok = (c: boolean, m: string) => { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); p++; };

ok(typeof HEYGEN_GEN_FRAMING.scale === "number" && typeof HEYGEN_GEN_FRAMING.offsetX === "number" && typeof HEYGEN_GEN_FRAMING.offsetY === "number", "shared framing has scale/offsetX/offsetY");
ok(HEYGEN_GEN_FRAMING.scale >= 1.0 && HEYGEN_GEN_FRAMING.scale <= 3, "gen scale within HeyGen-safe range (1.0–3)");
ok(Math.abs(HEYGEN_GEN_FRAMING.offsetX) <= 1 && Math.abs(HEYGEN_GEN_FRAMING.offsetY) <= 1, "gen offsets are HeyGen fractions (−1..1)");
ok(MCP_FRAMING === HEYGEN_GEN_FRAMING, "MCP avatar-steps re-exports the shared constant (no drift)");

console.log(`\n✅ ALL ${p} GEN-FRAMING CHECKS PASSED`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/verify-avatar-gen-framing.ts`
Expected: FAIL — cannot find module `../src/lib/avatar-gen-framing`.

- [ ] **Step 3: Create the shared constant**

Create `src/lib/avatar-gen-framing.ts`:
```ts
// Single source of truth for the HeyGen GEN framing (character.{scale,offset}) sent at
// avatar generation. This is the GEN layer (how HeyGen frames the avatar inside its own
// 720×1280 green video) — NOT the composite layer (that's avatar-layout.ts / AvatarPreset).
// Lives here so the editor, MCP, and the API route share ONE value and can't drift — the
// C1 bug was three callers each hardcoding their own scale while the route default was dead.
// offset is a HeyGen frame fraction: positive y = down, so a small negative y lifts the avatar.
// VALUE finalized empirically in Task 2 (render-on-green across real avatars).
export type GenFraming = { scale: number; offsetX: number; offsetY: number };
export const HEYGEN_GEN_FRAMING: GenFraming = { scale: 1.5, offsetX: 0, offsetY: -0.08 };
```

- [ ] **Step 4: Wire MCP to re-export the shared constant**

In `src/lib/mcp/avatar-steps.ts`, replace line 6:
```ts
// (was) export const HEYGEN_FRAMING = { scale: 1.0, offsetX: 0, offsetY: 0 } as const;
import { HEYGEN_GEN_FRAMING } from "@/lib/avatar-gen-framing";
export const HEYGEN_FRAMING = HEYGEN_GEN_FRAMING;
```
(Add the import near the top with the other imports; keep the `HEYGEN_FRAMING` name so `:73` keeps working.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx scripts/verify-avatar-gen-framing.ts`
Expected: PASS — `ALL 4 GEN-FRAMING CHECKS PASSED`.

- [ ] **Step 6: Wire the API route default to the shared constant**

In `src/app/api/heygen/generate-with-bg/route.ts`, replace lines 13-14:
```ts
// (was) const HEYGEN_GEN_SCALE = 1.0;  const HEYGEN_GEN_OFFSET_Y = 0.0;
import { HEYGEN_GEN_FRAMING } from "@/lib/avatar-gen-framing";
const HEYGEN_GEN_SCALE = HEYGEN_GEN_FRAMING.scale;
const HEYGEN_GEN_OFFSET_Y = HEYGEN_GEN_FRAMING.offsetY;
```
(Add the import with the other top-of-file imports. `scale`/`offsetY` defaults at `:116-118` already reference these consts — leave them.)

- [ ] **Step 7: Wire the editor to the shared constant**

In `src/app/(dashboard)/video-editor/page.tsx`, replace the inline constant at `:2307`:
```ts
// (was) const HEYGEN_FRAMING = { scale: 1.0, offsetX: 0, offsetY: 0 } as const;
// Use the shared constant (imported at top of file):
//   import { HEYGEN_GEN_FRAMING } from "@/lib/avatar-gen-framing";
const HEYGEN_FRAMING = HEYGEN_GEN_FRAMING;
```
Add `import { HEYGEN_GEN_FRAMING } from "@/lib/avatar-gen-framing";` to the import block. The usages at `:2358` and `:2507` (`HEYGEN_FRAMING.scale/offsetX/offsetY`) stay unchanged.

- [ ] **Step 8: Verify no stale hardcoded gen scale remains**

Run: `grep -rn "scale: 2.02\|scale: 1.0, offsetX\|HEYGEN_GEN_SCALE = 1.0" src` 
Expected: no matches (all gen framing now flows from `HEYGEN_GEN_FRAMING`).

- [ ] **Step 9: Typecheck + commit**

Run: `npx tsc --noEmit` → Expected: no errors.
```bash
git add src/lib/avatar-gen-framing.ts src/lib/mcp/avatar-steps.ts src/app/api/heygen/generate-with-bg/route.ts "src/app/(dashboard)/video-editor/page.tsx" scripts/verify-avatar-gen-framing.ts
git commit -m "feat(avatar): single shared HeyGen gen-framing constant (B)"
```

---

### Task 2: Finalize the gen-default value via render-on-green QA

**Files:** Modify only `src/lib/avatar-gen-framing.ts` (the constant value).
**Note:** Empirical task — needs Mew-authorized read-only SSH to read a HeyGen key (Beta = 1 credit/clip). No unit test; validation is visual.

- [ ] **Step 1: Pull a HeyGen key (read-only, Mew-authorized)**

```bash
ssh -i ~/.ssh/hostinger_heroai_codex root@72.62.196.230 \
  'sqlite3 /var/www/ai-content/prisma/dev.db "SELECT email, heygenKey FROM User WHERE email=\"duckyhero@gmail.com\";"'
```
The `heygenKey` is base64 — decode before use (`echo <key> | base64 -d`).

- [ ] **Step 2: Render-on-green for candidate framings across ≥2 avatars**

For each candidate `{scale, offsetY}` in a small sweep (scale ∈ {1.4, 1.5, 1.7}, offsetY ∈ {0, −0.08, −0.12}) and each avatar (`83f87532940548af83059467db069af7` "Mew Social" + the striped-shirt male avatar from Mew's screenshots), POST to HeyGen `/v2/video/generate` with `background:{type:color,value:"#00FF00"}`, `character.{scale,offset}`, poll `/v1/video_status.get`, download, extract a frame:
```bash
ffmpeg -ss 1 -i <clip>.mp4 -vframes 1 <frame>.jpg
```
Read each frame. Pick the framing where the avatar is **whole (no head/arm cut)** and **fills a good portion of the frame, centered** across BOTH avatars. (Reuse the prior session's helper pattern at `scratchpad/hg-genscale-test.py`.)

- [ ] **Step 3: Set the chosen value**

Edit `src/lib/avatar-gen-framing.ts` → `HEYGEN_GEN_FRAMING` to the chosen `{ scale, offsetX: 0, offsetY }`.

- [ ] **Step 4: Re-run the guard test + commit**

Run: `npx tsx scripts/verify-avatar-gen-framing.ts` → Expected: PASS.
```bash
git add src/lib/avatar-gen-framing.ts
git commit -m "feat(avatar): tune gen-default framing to <scale>/<offsetY> (render-on-green QA)"
```

---

### Task 3: Fix the stale prod preset (ops, Mew-gated)

**Files:** none (prod data).
**Note:** `duckyhero / 83f87532940548af83059467db069af7` preset = `{1.03,−8,57}` was tuned against the misleading thumbnail and is wrong. **Write to prod — requires Mew's explicit OK and her chosen action.**

- [ ] **Step 1: Confirm with Mew: delete (fall back to new default) OR overwrite with a value she picks.**
- [ ] **Step 2 (delete):** `DELETE FROM AvatarPreset WHERE avatarId='83f87532940548af83059467db069af7' AND userId=(SELECT id FROM User WHERE email='duckyhero@gmail.com');`
- [ ] **Step 2 (overwrite):** `UPDATE AvatarPreset SET scale=<s>, offsetX=<x>, offsetY=<y>, updatedAt=<ms> WHERE ...;`
- [ ] **Step 3:** Re-query the row to confirm. Do this only when no in-flight jobs.

---

# PHASE 2 — C: WYSIWYG (honest preview + pause + free re-composite + clobber guard)

### Task 4: Preset-load clobber guard

**Files:**
- Create: `src/lib/avatar-flow.ts`
- Modify: `src/app/(dashboard)/video-editor/page.tsx:333-348` (load-preset effect), plus a touched-ref and wrapped setters passed to `OrderPanel`
- Test: `scripts/verify-avatar-flow.ts`

**Interfaces:**
- Produces: `export function shouldApplyLoadedPreset(input: { loadedFor: string | null; avatarId: string; userTouched: boolean }): boolean` from `src/lib/avatar-flow.ts`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-avatar-flow.ts`:
```ts
// Run: npx tsx scripts/verify-avatar-flow.ts
// Locks the editor's avatar-flow decisions (preset clobber guard + pause-for-positioning).
import { shouldApplyLoadedPreset } from "../src/lib/avatar-flow";

let p = 0;
const ok = (c: boolean, m: string) => { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); p++; };

ok(shouldApplyLoadedPreset({ loadedFor: null, avatarId: "a", userTouched: false }) === true, "fresh avatar, untouched → apply preset");
ok(shouldApplyLoadedPreset({ loadedFor: "a", avatarId: "a", userTouched: false }) === false, "already loaded this avatar → do not re-apply");
ok(shouldApplyLoadedPreset({ loadedFor: null, avatarId: "a", userTouched: true }) === false, "user already edited → do not clobber");
ok(shouldApplyLoadedPreset({ loadedFor: "a", avatarId: "b", userTouched: false }) === true, "switched to new avatar → apply its preset");
ok(shouldApplyLoadedPreset({ loadedFor: null, avatarId: "", userTouched: false }) === false, "no avatar id → no-op");

console.log(`\n✅ ALL ${p} AVATAR-FLOW CHECKS PASSED`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/verify-avatar-flow.ts`
Expected: FAIL — cannot find module `../src/lib/avatar-flow`.

- [ ] **Step 3: Implement the pure function**

Create `src/lib/avatar-flow.ts`:
```ts
// Pure decisions for the Video Editor avatar flow. Kept out of the 4,700-line page
// component so they're unit-testable (scripts/verify-avatar-flow.ts).

/** Apply a freshly-fetched preset into the editor only when it won't clobber a live edit.
 *  - skip if no avatar id
 *  - skip if we've already loaded this avatarId once (true one-shot per id)
 *  - skip if the user has already touched the position controls for this avatar */
export function shouldApplyLoadedPreset(input: { loadedFor: string | null; avatarId: string; userTouched: boolean }): boolean {
  if (!input.avatarId) return false;
  if (input.loadedFor === input.avatarId) return false;
  if (input.userTouched) return false;
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/verify-avatar-flow.ts`
Expected: PASS — `ALL 5 AVATAR-FLOW CHECKS PASSED`.

- [ ] **Step 5: Wire the guard + touched tracking into page.tsx**

Add a touched ref near the avatar refs (after `:332` `loadedPresetFor`):
```ts
const avatarTouchedRef = useRef(false);          // user dragged a position control this avatar
const avatarHasPresetRef = useRef(false);        // a saved preset existed for the current avatarId
```
Reset `avatarTouchedRef` when the avatar id changes — extend the auto-load effect (`:723-727`) body:
```ts
avatarTouchedRef.current = false;   // new avatar id → allow its preset to load
```
Rewrite the load-preset effect (`:333-348`) to use the guard and set `loadedPresetFor`/`avatarHasPresetRef` on ALL exit paths:
```ts
useEffect(() => {
  if (!avatarId || !avatarValid) return;
  if (!shouldApplyLoadedPreset({ loadedFor: loadedPresetFor.current, avatarId, userTouched: avatarTouchedRef.current })) return;
  let cancelled = false;
  (async () => {
    try {
      const res = await fetch(`/api/avatar-presets/${encodeURIComponent(avatarId)}`);
      if (cancelled) return;
      if (res.ok) {
        const { layout } = await res.json();
        if (!cancelled && layout && !avatarTouchedRef.current) {
          setAvatarScale(layout.scale); setAvatarOffsetX(layout.offsetX); setAvatarOffsetY(layout.offsetY);
          avatarHasPresetRef.current = true;
        } else if (!layout) {
          avatarHasPresetRef.current = false;
        }
      }
    } catch { /* keep current values */ }
    finally { if (!cancelled) loadedPresetFor.current = avatarId; }  // one-shot per id, even on no-preset
  })();
  return () => { cancelled = true; };
}, [avatarId, avatarValid]);
```
Add `shouldApplyLoadedPreset` to the imports. Create touched-marking wrapped setters and pass THEM to `OrderPanel` (keep the raw setters for preset-load/reset/draft so those never mark touched):
```ts
const setAvatarScaleTouched   = (v: number) => { avatarTouchedRef.current = true; setAvatarScale(v); };
const setAvatarOffsetXTouched = (v: number) => { avatarTouchedRef.current = true; setAvatarOffsetX(v); };
const setAvatarOffsetYTouched = (v: number) => { avatarTouchedRef.current = true; setAvatarOffsetY(v); };
```
At the `OrderPanel` usages (`:4479`, `:4534`, `:4601`) pass `setAvatarScale={setAvatarScaleTouched}` etc. (the touched variants).

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit` → no errors. Then `npx tsx scripts/verify-avatar-flow.ts` → PASS.
```bash
git add src/lib/avatar-flow.ts scripts/verify-avatar-flow.ts "src/app/(dashboard)/video-editor/page.tsx"
git commit -m "fix(avatar): preset-load clobber guard (don't overwrite live edits)"
```

---

### Task 5: Pause-before-composite decision + free re-composite handler

**Files:**
- Modify: `src/lib/avatar-flow.ts` (add `shouldPauseForPositioning`)
- Modify: `scripts/verify-avatar-flow.ts` (add cases)
- Modify: `src/app/(dashboard)/video-editor/page.tsx` (state, `compositeOrPause`, `compositeWithCurrentLayout`; call sites `:2570`, `:2809`)

**Interfaces:**
- Produces: `export function shouldPauseForPositioning(input: { useAvatar: boolean; isDirect: boolean; hasSavedPreset: boolean }): boolean`; and in page.tsx: `awaitingPosition: boolean` state + `compositeWithCurrentLayout(): Promise<void>` handler (consumed by OrderPanel in Task 6).
- Consumes: `shouldApplyLoadedPreset` (Task 4), `avatarHasPresetRef` (Task 4), `runComposite` (`:2441`), `pipe.current.renderedVideoUrl`, `avatarGreenUrl`, `avatarTailGreenUrl`.

- [ ] **Step 1: Add failing test cases**

Append to `scripts/verify-avatar-flow.ts` (before the final `console.log`):
```ts
import { shouldPauseForPositioning } from "../src/lib/avatar-flow";
ok(shouldPauseForPositioning({ useAvatar: true, isDirect: false, hasSavedPreset: false }) === true, "avatar + no preset → pause for positioning");
ok(shouldPauseForPositioning({ useAvatar: true, isDirect: false, hasSavedPreset: true }) === false, "avatar + saved preset → no pause (auto)");
ok(shouldPauseForPositioning({ useAvatar: false, isDirect: false, hasSavedPreset: false }) === false, "no avatar → no pause");
ok(shouldPauseForPositioning({ useAvatar: true, isDirect: true, hasSavedPreset: false }) === false, "direct-url avatar → no pause (no gen framing)");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/verify-avatar-flow.ts`
Expected: FAIL — `shouldPauseForPositioning` is not exported.

- [ ] **Step 3: Implement the pure function**

Add to `src/lib/avatar-flow.ts`:
```ts
/** Pause the web render before composite the FIRST time an avatar is used, so the user can
 *  position against the real green video. Skip when no avatar, a direct-URL avatar (no gen
 *  framing to fix), or a saved preset already exists (run straight through = automation). */
export function shouldPauseForPositioning(input: { useAvatar: boolean; isDirect: boolean; hasSavedPreset: boolean }): boolean {
  return input.useAvatar && !input.isDirect && !input.hasSavedPreset;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/verify-avatar-flow.ts`
Expected: PASS — `ALL 9 AVATAR-FLOW CHECKS PASSED`.

- [ ] **Step 5: Add pause state + handlers in page.tsx**

Add state near the avatar state (`:319`):
```ts
const [awaitingPosition, setAwaitingPosition] = useState(false);
```
Add a gate helper used by the orchestrator (place near `runComposite`, `:2491`):
```ts
// After the avatar green is ready: pause for first-time positioning, or composite straight through.
async function compositeOrPause(bgUrl: string, avUrl: string, tailUrl?: string): Promise<void> {
  if (shouldPauseForPositioning({ useAvatar, isDirect: avatarInputMode === "direct", hasSavedPreset: avatarHasPresetRef.current })) {
    setAwaitingPosition(true);
    setStep("composite", "idle", "รอจัดตำแหน่ง avatar — กด “ต่อ → ประกอบ”");
    return; // pipeline stops here; user resumes via compositeWithCurrentLayout()
  }
  await runComposite(bgUrl, avUrl, tailUrl);
}

// Composite-only using the already-generated green (no HeyGen re-gen). Used by both the
// pause "continue" button and the "re-position → re-composite" button.
async function compositeWithCurrentLayout(): Promise<void> {
  if (!pipe.current.renderedVideoUrl || !avatarGreenUrl) { toast.error("ต้อง Render avatar ก่อน"); return; }
  setAwaitingPosition(false);
  const tailUrl = avatarTiming === "bookend-both" ? (avatarTailGreenUrl || undefined) : undefined;
  try { await runComposite(pipe.current.renderedVideoUrl, avatarGreenUrl, tailUrl); }
  catch (err) { if (!handleMissingKey(err, "runAvatarPipeline")) showErrorToast(err); }
}
```
Add `shouldPauseForPositioning` to the imports.

- [ ] **Step 6: Route the two orchestrator call sites through the gate**

In `runAvatarPipeline` replace `:2570` `await runComposite(pipe.current.renderedVideoUrl, avUrl, tailUrl);` with:
```ts
await compositeOrPause(pipe.current.renderedVideoUrl, avUrl, tailUrl);
```
In the Run-All flow replace `:2809` `await runComposite(renderedUrl, avUrl, tailUrl);` with:
```ts
await compositeOrPause(renderedUrl, avUrl, tailUrl);
```

- [ ] **Step 7: Typecheck + commit**

Run: `npx tsc --noEmit` → no errors. `npx tsx scripts/verify-avatar-flow.ts` → PASS.
```bash
git add src/lib/avatar-flow.ts scripts/verify-avatar-flow.ts "src/app/(dashboard)/video-editor/page.tsx"
git commit -m "feat(avatar): pause-before-composite (first-time) + free re-composite handler"
```

---

### Task 6: OrderPanel — honest preview + continue/re-composite buttons

**Files:**
- Modify: `src/app/(dashboard)/video-editor/_components/OrderPanel.tsx` (props `:48-60`, preview `:832-842`, controls `:851-870`)
- Modify: `src/app/(dashboard)/video-editor/page.tsx` — pass new props at the `OrderPanel` usages (`:4459`, `:4520`, `:4585`)

**Interfaces:**
- Consumes (from page.tsx): `awaitingPosition: boolean`, `onComposite: () => void` (= `compositeWithCurrentLayout`), `compositing: boolean` (reuse the existing render-busy flag, e.g. `running`).
- Produces: UI only.

- [ ] **Step 1: Add the props to OrderPanel's type**

In `OrderPanel.tsx` props (around `:60`, next to `onSaveAvatarLayout`):
```ts
awaitingPosition: boolean; onComposite: () => void; compositing: boolean;
```

- [ ] **Step 2: Dim the thumbnail + honest label when no green exists**

At the preview img (`:837`), make the thumbnail visibly provisional when it's the stand-in (no green video):
```tsx
<img src={p.avatarPreviewUrl} draggable={false} className="w-full h-full" style={{ objectFit:"cover", objectPosition:"center top", opacity: 0.5 }} />
```
Extend the existing pre-gen note so it sets expectations (the line near `:842` that renders the "รูปตัวอย่าง" hint):
```tsx
รูปตัวอย่าง · ตำแหน่งจริงปรับได้หลัง Render รอบแรก
```

- [ ] **Step 3: Add the continue / re-composite buttons**

Next to the "💾 Save ตำแหน่ง" button (`:865`), add:
```tsx
{p.awaitingPosition && (
  <button onClick={() => p.onComposite()} disabled={p.compositing}
    className="text-[9px] font-semibold text-emerald-300 hover:text-emerald-200 disabled:opacity-50 flex-1 text-center">
    {p.compositing ? "กำลังประกอบ…" : "▶ ต่อ → ประกอบ"}
  </button>
)}
{!p.awaitingPosition && p.avatarGreenUrl && (
  <button onClick={() => p.onComposite()} disabled={p.compositing}
    className="text-[9px] text-cyan-400 hover:text-cyan-300 disabled:opacity-50 flex-1 text-center">
    {p.compositing ? "กำลังประกอบ…" : "↻ ปรับตำแหน่ง → ประกอบใหม่"}
  </button>
)}
```

- [ ] **Step 4: Pass the props from page.tsx**

At each `OrderPanel` usage, add:
```tsx
awaitingPosition={awaitingPosition} onComposite={() => { void compositeWithCurrentLayout(); }} compositing={running}
```

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` → no errors.
```bash
git add "src/app/(dashboard)/video-editor/_components/OrderPanel.tsx" "src/app/(dashboard)/video-editor/page.tsx"
git commit -m "feat(avatar): honest preview + continue/re-composite buttons in OrderPanel"
```

---

### Task 7: Full verification (typecheck + verify suites + manual e2e)

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit` → Expected: no errors.

- [ ] **Step 2: Run all avatar verify suites**

Run each; each must end with `ALL N … PASSED`:
```bash
npx tsx scripts/verify-avatar-gen-framing.ts
npx tsx scripts/verify-avatar-flow.ts
npx tsx scripts/verify-avatar-layout-geometry.ts
npx tsx scripts/verify-avatar-preset.ts
npx tsx scripts/verify-mcp-avatar-input.ts
npx tsx scripts/verify-avatar-steps.ts
npx tsx scripts/verify-heygen-avatar-details.ts
npx tsx scripts/verify-heygen-avatar-cache.ts
npx tsx scripts/verify-heygen-avatar-store.ts
```

- [ ] **Step 3: Manual e2e (Mew, chrome-devtools on prod after deploy)**

1. New avatar (no preset): Render → pipeline **pauses** after gen, shows real green → position → "ต่อ → ประกอบ" → output matches → Save.
2. Re-adjust → "↻ ปรับตำแหน่ง → ประกอบใหม่" → composite only (seconds, no new HeyGen gen — confirm no avatar step re-runs).
3. Second clip, same avatar: Render runs **straight through** (no pause), avatar correct from saved preset.
4. Confirm `[chromakey] layer layout scale=…` in the prod log matches the saved preset.

- [ ] **Step 4: Final commit (if any verification fixups)**

```bash
git add -A && git commit -m "test(avatar): verify framing WYSIWYG end-to-end"
```

---

## Self-Review

- **Spec coverage:** 3.1→Task 1+2; 3.2→Task 6 (dim thumbnail/label/prefer green); 3.3→Task 5+6 (pause + re-composite); 3.4→Task 4 (clobber guard); 3.5→Task 3 (prod data); 3.6→Task 1 (shared constant; MCP preset-load already wired). All covered.
- **Placeholder scan:** gen value `1.5/−0.08` is a concrete starting value finalized empirically in Task 2 (not a placeholder); prod SQL values `<s>/<x>/<y>` are Mew's choice at execution (gated ops step) — both intentional.
- **Type consistency:** `HEYGEN_GEN_FRAMING: GenFraming`, `shouldApplyLoadedPreset`, `shouldPauseForPositioning`, `compositeWithCurrentLayout`, `compositeOrPause`, `awaitingPosition` used consistently across tasks.
- **Phasing:** Phase 1 (Tasks 1-3) is deployable alone (B quick win); Phase 2 (Tasks 4-7) adds C. No Phase-2 symbol is referenced by Phase 1.
