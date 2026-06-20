# Background Music UX Simplify — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make background music foolproof in the video editor — selecting a track = it's in the video. Remove the on/off toggle gate and the audition-vs-select confusion that left users (e.g. nattasat) with silent output.

**Architecture:** UI-only. `bgmFile` is the single source of truth; `bgmEnabled` becomes derived (`= !!bgmFile`) so the render/burn/save pipeline is untouched. Both editor music panels (RightSettingsPanel, OrderPanel) drop the toggle, always show the track list, add a "None" option, and clearly separate the ▶ audition button from selection.

**Tech Stack:** Next.js 15 / React 19 / TypeScript. Gate = `tsc` + `npm run build` + live browser QA (no unit-testable logic — pure UI).

## Global Constraints

- UI-only: do NOT modify the render/burn routes, `runRender`, `saveToGallery`, or any pipeline logic. `bgmEnabled`'s meaning is preserved (now derived from `bgmFile`).
- The render reads `bgmEnabled && bgmFile` (page.tsx:1956) and the save reads it (1830) — these MUST keep working unchanged.
- Apply the identical UX change to BOTH `RightSettingsPanel.tsx` and `OrderPanel.tsx`.
- Preserve the existing track-row markup, the ▶ audition/preview button + its handler, and the upload control — only restructure the gating/selection.
- `tsc --noEmit --pretty false` → 0 errors; `BUILD_NO_LINT=1 npm run build` → exit 0 (`/video-editor` compiles).

---

## Task 1: Derive `bgmEnabled` from `bgmFile` (page.tsx)

**Files:**
- Modify: `src/app/(dashboard)/video-editor/page.tsx`

**Interfaces:**
- Produces: `bgmEnabled` is now always `=== !!bgmFile` at render time; consumers (`bgmEnabled && bgmFile` at 1830/1956, chip at 4505, draft save/restore) keep working.

- [ ] **Step 1: Add the derivation effect** — near the other BGM state (`const [bgmEnabled, setBgmEnabled] = useState(false)` ~line 323), add an effect right after the BGM state declarations:

```ts
// BGM is "on" exactly when a track is selected — the UI no longer has a
// separate enable toggle. Deriving it here keeps every bgmEnabled consumer
// (render patch, save config, status chip, draft) working unchanged.
useEffect(() => { setBgmEnabled(!!bgmFile); }, [bgmFile]);
```

(`useEffect` is already imported in this file.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit --pretty false`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(dashboard)/video-editor/page.tsx"
git commit -m "feat(editor): derive bgmEnabled from bgmFile (track selected = music on)"
```

---

## Task 2: Restructure the Background Music block in BOTH panels

**Files:**
- Modify: `src/app/(dashboard)/video-editor/_components/RightSettingsPanel.tsx` (Background Music block, ~lines 350-414)
- Modify: `src/app/(dashboard)/video-editor/_components/OrderPanel.tsx` (Background Music block, ~lines 211-330)

**Interfaces:**
- Consumes: existing props `bgmFile: string`, `setBgmFile: (v: string) => void`, `bgmVolume`, `setBgmVolume`, `systemTracks`, `userTracks` (and the panel's existing audition/preview helper). `setBgmEnabled`/`bgmEnabled` are no longer used by the panel UI (leave the props in the type if other code passes them; just stop rendering the toggle and stop gating on `bgmEnabled`).

Read each file's current "Background Music" block first. Apply the SAME four changes to both, preserving the existing track-row, audition (▶) button, and upload markup:

- [ ] **Step 1: Remove the on/off toggle** — delete the toggle `<button onClick={() => p.setBgmEnabled(!p.bgmEnabled)} ...>` (the rounded switch next to the "Background Music" label). Keep the "Background Music" heading.

- [ ] **Step 2: Always show the content** — remove the `{p.bgmEnabled && ( ... )}` wrapper around the volume + track list + upload, so that content always renders.

- [ ] **Step 3: Add a "None" option** as the FIRST row of the track area (above System Tracks). It is selected when no track is chosen, and clicking it clears the selection:

```tsx
<button type="button" onClick={() => p.setBgmFile("")}
  className={cn("w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11px] transition-all border",
    !p.bgmFile
      ? "bg-violet-500/15 border-violet-500/40 text-violet-300"
      : "bg-[#1a1a22] border-[#2a2a36] text-slate-500 hover:border-[#3a3a4a]")}>
  <span className="shrink-0">🚫</span>
  <span className="truncate">ไม่ใส่เพลง</span>
  {!p.bgmFile && <span className="ml-auto text-violet-400">✓</span>}
</button>
```

- [ ] **Step 4: Volume only when a track is selected** — wrap the existing Volume slider row in `{p.bgmFile && ( ... )}` so it appears only after a track is chosen.

- [ ] **Step 5: Audition button clarity** — ensure the per-track ▶/preview button has `title="ฟังตัวอย่าง"` (add it if missing). Do not change its behavior. (The select target stays the track-title button that calls `setBgmFile`.)

- [ ] **Step 6: Typecheck + build**

Run: `npx tsc --noEmit --pretty false` → 0 errors.
Run: `BUILD_NO_LINT=1 npm run build` → exit 0, `/video-editor` in the route list.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(dashboard)/video-editor/_components/RightSettingsPanel.tsx" "src/app/(dashboard)/video-editor/_components/OrderPanel.tsx"
git commit -m "feat(editor): BGM panels — drop toggle, always-show list, None option, clearer audition"
```

---

## Task 3: Live browser QA + close-out

**Files:** none (verification only).

- [ ] **Step 1:** Logged in as duckyhero, open `/video-editor`. Under "Background Music" (both the right Settings panel and the Order panel) confirm: no on/off toggle; the track list (with "🚫 ไม่ใส่เพลง" at top) shows immediately; "ไม่ใส่เพลง" is selected by default; Volume is hidden until a track is picked.
- [ ] **Step 2:** Click a track → ✓ appears, the bottom `🎵` chip shows the file, Volume appears. Click "ไม่ใส่เพลง" → chip shows "No music selected".
- [ ] **Step 3:** Render a short clip with a track selected → prod log shows `[render] bgmFile: /music/...`; render with "ไม่ใส่เพลง" → `bgmFile: undefined`.
- [ ] **Step 4:** Confirm the ▶ audition button still previews a track WITHOUT changing the current selection.

---

## Notes for the implementer
- Both panels already have the track rows calling `setBgmFile(selected ? "" : url)` and an audition button — keep those. The ONLY structural changes are: remove toggle, un-gate from `bgmEnabled`, add the None row, gate Volume on `bgmFile`.
- Do not add a new prop. `setBgmEnabled` may remain in the props type (passed by page.tsx) but is simply no longer rendered as a toggle.
