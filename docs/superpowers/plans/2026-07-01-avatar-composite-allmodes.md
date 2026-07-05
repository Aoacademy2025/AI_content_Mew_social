# Avatar composite — all modes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every avatar mode (Full / Intro / Intro+Outro / Direct·Green / Direct·Full) auto-composite after render with no pause, never re-pay HeyGen for a position change, and give direct uploads a working composite trigger + a non-green "full video" option.

**Architecture:** Remove the 06-30 positioning pause so render auto-composites (a shared smart post-render helper that gens only when gen-inputs changed, else composites). Wire the existing `nextAvatarAction` smart logic to the LIVE pipeline-step buttons (the dead `{false}` RightSettingsPanel block is left untouched). Add a Direct composite-mode toggle that selects the route's existing `chromakey` vs `direct` (full overlay) modes.

**Tech Stack:** Next.js 15 / React 19 / TypeScript; pure logic in `src/lib/avatar-flow.ts` verified by `scripts/verify-avatar-flow.ts` via `tsx`; UI/orchestration in `src/app/(dashboard)/video-editor/` verified by `tsc --noEmit` + build + browser e2e.

## Global Constraints

- Branch: `mew/avatar-composite-allmodes`. `main` = production — never push broken code.
- Keep from 06-30: `HEYGEN_GEN_FRAMING` = `{scale:1.6, offsetX:0, offsetY:-0.12}`; `compositeWithCurrentLayout` (free re-composite, no re-gen); honest preview.
- Direct uploads: position memory is **per-session only** (no AvatarPreset for direct).
- Direct·Full v1: b-roll is still rendered then covered (accepted waste; do NOT skip b-roll).
- No clean rebuild needed on deploy (06-30 "stale bundle" was `{false}` DCE, not webpack cache).
- Pure logic gets a failing `verify-avatar-flow.ts` check first; UI glue is verified by `tsc --noEmit` + build + e2e (team pattern — React glue is not unit-tested).

---

## File structure

- `src/lib/avatar-flow.ts` — pure decisions. Keep `avatarGenSignature`, `nextAvatarAction`. **Remove** `shouldPauseForPositioning`. (`shouldApplyLoadedPreset` stays.)
- `scripts/verify-avatar-flow.ts` — drop the `shouldPauseForPositioning` checks; keep signature + next-action checks.
- `src/app/(dashboard)/video-editor/page.tsx` — orchestration: new `autoCompositeAfterRender` helper; `runAll` + `runAvatarPipeline` + `runRenderOnly` use it; remove `compositeOrPause` + `awaitingPosition`; step-button handler → `onAvatarPrimary`; new `directCompositeMode` state; `runComposite` direct branch sends the chosen mode; stop passing dead-block props to RightSettingsPanel.
- `src/app/(dashboard)/video-editor/_components/OrderPanel.tsx` — remove "ต่อ → ประกอบ" pause button + `awaitingPosition` prop; add Direct Green/Full toggle.

---

### Task 1: Remove the pause → auto-composite (gen modes) + shared smart helper

**Files:**
- Modify: `src/lib/avatar-flow.ts` (remove `shouldPauseForPositioning`)
- Modify: `scripts/verify-avatar-flow.ts` (drop pause checks)
- Modify: `src/app/(dashboard)/video-editor/page.tsx` (helper + replace `compositeOrPause`; remove `awaitingPosition`)
- Modify: `src/app/(dashboard)/video-editor/_components/OrderPanel.tsx` (remove pause button + prop)

**Interfaces:**
- Consumes: existing `avatarGenSignature`, `nextAvatarAction` (avatar-flow.ts); existing `runAvatar`, `runAvatarTail`, `runComposite`, `currentAvatarGenSig`, `lastGenSig`/`setLastGenSig`, `avatarGreenUrl`, `avatarTailGreenUrl`, `avatarTiming`, `avatarInputMode` (page.tsx).
- Produces: `async function autoCompositeAfterRender(renderedUrl: string, audioUrl: string): Promise<void>` in page.tsx — used by Task 2.

- [ ] **Step 1 (RED): drop pause checks in the verify script**

In `scripts/verify-avatar-flow.ts` remove the import of `shouldPauseForPositioning` and its 4 `ok(...)` lines (the ones whose messages mention "pause for positioning" / "no pause"). Keep all `avatarGenSignature` and `nextAvatarAction` checks.

- [ ] **Step 2: Run the verify script — it must still fail to compile (function still imported elsewhere)**

Run: `npx tsx scripts/verify-avatar-flow.ts`
Expected: PASS for the remaining checks (the script no longer references `shouldPauseForPositioning`).

- [ ] **Step 3: Remove `shouldPauseForPositioning` from `src/lib/avatar-flow.ts`**

Delete the entire `shouldPauseForPositioning` export (the function + its doc comment). Leave `shouldApplyLoadedPreset`, `avatarGenSignature`, `nextAvatarAction`.

- [ ] **Step 4: Add the shared smart post-render helper in page.tsx**

Add next to `compositeWithCurrentLayout` (after it):

```ts
// After a base render, ensure the avatar is composited. Gen (HeyGen) only when a gen-input
// changed since the last green (or no green yet); otherwise composite the existing green for
// free. Direct mode's runAvatar sets green from the URL (no HeyGen). No pause — ever.
async function autoCompositeAfterRender(renderedUrl: string, audioUrl: string): Promise<void> {
  const action = nextAvatarAction({ hasGreen: !!avatarGreenUrl, lastGenSig, currentSig: currentAvatarGenSig() });
  let avUrl = avatarGreenUrl;
  let tailUrl = avatarTiming === "bookend-both" && avatarInputMode !== "direct" ? (avatarTailGreenUrl || undefined) : undefined;
  if (action === "gen") {
    avUrl = await runAvatar(audioUrl);
    if (abortRef.current) return;
    if (avatarInputMode !== "direct" && avatarTiming === "bookend-both") {
      tailUrl = avatarTailGreenUrl || await runAvatarTail(audioUrl);
      if (abortRef.current) return;
    }
    setLastGenSig(currentAvatarGenSig());
  }
  await runComposite(renderedUrl, avUrl, tailUrl);
}
```

- [ ] **Step 5: Replace the `compositeOrPause` call in `runAll`**

Find (≈ the `if (useAvatar)` block in `runAll`):

```ts
      let paused = false;
      if (useAvatar) {
        const avUrl = await runAvatar(vUrl);
        if (abortRef.current) return;
        let tailUrl: string | undefined;
        if (avatarInputMode !== "direct" && avatarTiming === "bookend-both") {
          tailUrl = avatarTailGreenUrl || await runAvatarTail(vUrl);
          if (abortRef.current) return;
        }
        paused = await compositeOrPause(renderedUrl, avUrl, tailUrl);
        if (abortRef.current || paused) return;
      }

      if (!abortRef.current && !paused) toast.success("Preview พร้อมแล้ว — ปรับซับ แล้วกด Burn & Download ตอนจบ");
```

Replace with:

```ts
      if (useAvatar) {
        await autoCompositeAfterRender(renderedUrl, vUrl);
        if (abortRef.current) return;
      }

      if (!abortRef.current) toast.success("Preview พร้อมแล้ว — ปรับซับ แล้วกด Burn & Download ตอนจบ");
```

- [ ] **Step 6: Replace the `compositeOrPause` call in `runAvatarPipeline`**

Find:

```ts
      setLastGenSig(currentAvatarGenSig());
      const paused = await compositeOrPause(pipe.current.renderedVideoUrl, avUrl, tailUrl);
      if (abortRef.current || paused) return;
```

Replace with:

```ts
      setLastGenSig(currentAvatarGenSig());
      await runComposite(pipe.current.renderedVideoUrl, avUrl, tailUrl);
      if (abortRef.current) return;
```

- [ ] **Step 7: Delete `compositeOrPause` + `awaitingPosition` + their references**

- Delete the `compositeOrPause` function.
- Delete `const [awaitingPosition, setAwaitingPosition] = useState(false);`.
- In `compositeWithCurrentLayout`, delete the line `setAwaitingPosition(false);`.
- Remove the `shouldPauseForPositioning` name from the avatar-flow import (keep `avatarGenSignature, nextAvatarAction, shouldApplyLoadedPreset`).

- [ ] **Step 8: OrderPanel — remove the pause button + `awaitingPosition`**

- In `OrderPanel.tsx`: delete the `awaitingPosition &&` "▶ ต่อ → ประกอบ" button block; change the "↻ ปรับตำแหน่ง → ประกอบใหม่" condition from `!p.awaitingPosition && p.avatarGreenUrl` to just `p.avatarGreenUrl`. Remove `awaitingPosition` from `OrderPanelProps`.
- In `page.tsx` OrderPanel render site(s): remove the `awaitingPosition={awaitingPosition}` prop; keep `onComposite={() => { void compositeWithCurrentLayout(); }}` and `compositing={running}`.

- [ ] **Step 9: Verify pure logic + types**

Run: `npx tsx scripts/verify-avatar-flow.ts`
Expected: `✅ ALL N AVATAR-FLOW CHECKS PASSED`

Run: `npx tsc --noEmit 2>&1 | grep -E "video-editor|avatar-flow" ; echo done`
Expected: `done` with no error lines above it.

- [ ] **Step 10: Commit**

```bash
git add src/lib/avatar-flow.ts scripts/verify-avatar-flow.ts "src/app/(dashboard)/video-editor/page.tsx" "src/app/(dashboard)/video-editor/_components/OrderPanel.tsx"
git commit -m "fix(avatar): auto-composite after render (remove 06-30 pause) for gen modes"
```

---

### Task 2: `runRenderOnly` (Render ▶) auto-composites the avatar

**Files:**
- Modify: `src/app/(dashboard)/video-editor/page.tsx` (`runRenderOnly`)

**Interfaces:**
- Consumes: `autoCompositeAfterRender` (Task 1); `useAvatar`, `avatarInputMode`, `avatarDirectUrl`, `pipe.current.voiceUrl`, `pipe.current.renderedVideoUrl`.

- [ ] **Step 1: Add the avatar step to `runRenderOnly`**

Find in `runRenderOnly`:

```ts
      await runRender(pipe.current.config);
      if (abortRef.current) return;
      if (!abortRef.current) toast.success("Render preview พร้อมแล้ว — กด Burn & Download ตอนจบ");
```

Replace with:

```ts
      await runRender(pipe.current.config);
      if (abortRef.current) return;
      if (useAvatar) {
        const audioUrl = avatarInputMode === "direct" ? avatarDirectUrl.trim() : (pipe.current.voiceUrl ?? "");
        await autoCompositeAfterRender(pipe.current.renderedVideoUrl, audioUrl);
        if (abortRef.current) return;
      }
      if (!abortRef.current) toast.success("Render preview พร้อมแล้ว — กด Burn & Download ตอนจบ");
```

- [ ] **Step 2: Verify types**

Run: `npx tsc --noEmit 2>&1 | grep -E "video-editor" ; echo done`
Expected: `done` with no error lines.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(dashboard)/video-editor/page.tsx"
git commit -m "fix(avatar): Render ▶ (runRenderOnly) auto-composites avatar (fixes direct re-render stuck)"
```

---

### Task 3: Wire the smart action to the LIVE pipeline-step buttons + enable direct

**Files:**
- Modify: `src/app/(dashboard)/video-editor/page.tsx` (step-button handler ≈ line 4178; RightSettingsPanel prop passing)

**Interfaces:**
- Consumes: existing `onAvatarPrimary` (page.tsx; already decides gen vs composite via `nextAvatarAction`).

- [ ] **Step 1: Make avatar/composite step buttons use `onAvatarPrimary` for all `useAvatar` (incl. direct)**

Find:

```ts
                  if (k === "avatar" || k === "avatarTail" || k === "composite") return (useAvatar && !isDirectAvatar) ? () => runAvatarPipeline() : null;
```

Replace with:

```ts
                  if (k === "avatar" || k === "avatarTail" || k === "composite") return useAvatar ? () => onAvatarPrimary() : null;
```

- [ ] **Step 2: Stop passing dead-block props to RightSettingsPanel**

At BOTH `<RightSettingsPanel ... />` render sites, remove the line:
`onAvatarPrimary={onAvatarPrimary} avatarPrimaryLabel={avatarPrimaryLabel} avatarPrimaryIsGen={avatarPrimaryIsGen}`.
Then in `RightSettingsPanel.tsx` remove those three props from `RightPanelProps` (they only fed the dead `{false}` block; leave the dead block itself untouched).

- [ ] **Step 3: Verify types**

Run: `npx tsc --noEmit 2>&1 | grep -E "video-editor" ; echo done`
Expected: `done` with no error lines.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/video-editor/page.tsx" "src/app/(dashboard)/video-editor/_components/RightSettingsPanel.tsx"
git commit -m "fix(avatar): live step buttons use smart gen-vs-composite + work for direct (no double-gen)"
```

---

### Task 4: Direct mode — Green Screen vs Full Video toggle

**Files:**
- Modify: `src/app/(dashboard)/video-editor/page.tsx` (`directCompositeMode` state; `runComposite` direct branch)
- Modify: `src/app/(dashboard)/video-editor/_components/OrderPanel.tsx` (toggle UI)

**Interfaces:**
- Produces: `directCompositeMode: "chromakey" | "full"` (default `"chromakey"`), `setDirectCompositeMode`, passed to OrderPanel.

- [ ] **Step 1: Add state in page.tsx (near other avatar state)**

```ts
const [directCompositeMode, setDirectCompositeMode] = useState<"chromakey" | "full">("chromakey");
```

- [ ] **Step 2: `runComposite` direct branch sends the chosen mode**

In `runComposite`, change the `isDirect` body. For Full video, send the route's `direct` (full overlay, no chroma); for Green Screen, keep chromakey:

```ts
      body: isDirect
        ? JSON.stringify(
            directCompositeMode === "full"
              ? { avatarVideoUrl: avatarUrl, bgVideoUrl, mode: "direct", audioFromAvatar: true }
              : {
                  avatarVideoUrl: avatarUrl, bgVideoUrl, mode: "chromakey", noScale: true,
                  chromaColor: "0x00ff00", chromaSimilarity, chromaBlend, audioFromAvatar: false,
                }
          )
        : JSON.stringify({ /* unchanged gen branch */ }),
```

(Note: `mode: "direct"` overlays the uploaded clip full-frame and takes audio from the clip — confirm `audioFromAvatar`/audio mapping against `route.ts` `directComposite` during implementation; `directComposite` maps `1:a?` so audio comes from the avatar clip regardless.)

- [ ] **Step 3: Pass + render the toggle in OrderPanel (direct section)**

Pass `directCompositeMode={directCompositeMode} setDirectCompositeMode={setDirectCompositeMode}` to OrderPanel; add the props to `OrderPanelProps`. In the OrderPanel direct-mode UI (where the green-screen upload lives), add:

```tsx
<div className="flex gap-1.5">
  {([["chromakey","Green Screen (ตัดเขียว)"],["full","วิดีโอเต็มจอ (ใส่ซับอย่างเดียว)"]] as const).map(([m,label]) => (
    <button key={m} onClick={() => p.setDirectCompositeMode(m)}
      className={cn("flex-1 py-1.5 rounded-lg border text-[10px] font-bold",
        p.directCompositeMode === m ? "bg-violet-500/15 border-violet-500/45 text-violet-300" : "bg-[#1a1a22] border-[#2a2a36] text-slate-500")}>
      {label}
    </button>
  ))}
</div>
```

- [ ] **Step 4: Verify types**

Run: `npx tsc --noEmit 2>&1 | grep -E "video-editor" ; echo done`
Expected: `done` with no error lines.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/video-editor/page.tsx" "src/app/(dashboard)/video-editor/_components/OrderPanel.tsx"
git commit -m "feat(avatar): direct upload Green Screen / Full Video toggle (chromakey vs full overlay)"
```

---

### Task 5: Build-verify, deploy, browser e2e

**Files:** none (verification + deploy)

- [ ] **Step 1: Full typecheck + verify**

Run: `npx tsc --noEmit 2>&1 | tail -5 ; npx tsx scripts/verify-avatar-flow.ts | tail -2`
Expected: no errors; `✅ ALL ... CHECKS PASSED`.

- [ ] **Step 2: Merge to main + deploy (Mew's gate — prod idle check first)**

Re-check prod idle (no active VideoJob/RenderJob), ff-merge to `main`, push, then `bash deploy/deploy.sh` (normal — no cache clear). Confirm HEAD, homepage 200, workers online.

- [ ] **Step 3: Browser e2e on prod (chrome-devtools / Claude-in-Chrome)**

Verify via Network panel for each: (a) one gen mode — Render auto-composites (`/api/heygen/composite` fires, no 2nd `/api/heygen/generate-with-bg`); tweak size → composite only. (b) Direct·Green — Render auto-composites with chromakey. (c) Direct·Full — Render composites with `mode:"direct"` (no chroma); the clip's own background shows. (d) Render ▶ on an avatar project composites (not base-only).

- [ ] **Step 4: Confirm the fix is in the served bundle**

After deploy, grep prod `.next/static` for the new direct-toggle label "วิดีโอเต็มจอ" and confirm it's present (sanity that live code shipped — unlike the dead-block strings before).

---

## Self-review

**Spec coverage:**
- Change 1 (remove pause → auto-composite) → Task 1 (gen) + Task 2 (runRenderOnly). ✓
- Change 2 (smart re-trigger on live buttons + direct) → Task 3. ✓
- Change 3 (direct green/full toggle) → Task 4. ✓
- Change 4 (cleanup awaitingPosition/pause button/shouldPauseForPositioning) → Task 1 steps 1,3,7,8. ✓
- Change 5 (keep 06-30 good parts) → constraints + untouched code. ✓
- Per-mode behavior table → covered by Tasks 1–4 + e2e Task 5. ✓

**Placeholder scan:** Task 4 Step 2 leaves the gen branch as `/* unchanged */` — acceptable (it is genuinely unchanged from current code; do not rewrite it). One flagged confirm (`audioFromAvatar` mapping vs route.ts) — resolved inline with the route behavior note. No TBD/TODO.

**Type consistency:** `autoCompositeAfterRender(renderedUrl, audioUrl)` defined Task 1, consumed Task 2 — same signature. `directCompositeMode: "chromakey" | "full"` consistent across page.tsx + OrderPanel (Task 4). `onAvatarPrimary` reused (already exists) in Task 3. ✓
</content>
