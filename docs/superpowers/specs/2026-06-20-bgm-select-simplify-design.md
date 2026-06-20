# Background Music UX — "Select = It's In Your Video" Design Spec

**Date:** 2026-06-20
**Origin:** Bug report from nattasat.p@gmail.com ("ฝัง sub แล้วคลิปไม่มี music background"). Root cause (reproduced live): NOT a code bug — the render/burn pipeline bakes + preserves BGM correctly for both non-avatar and avatar when music is properly set. nattasat's videos had `renderConfig.bgmFile` empty in both — he never successfully enabled+selected music. The failure is a UX trap.
**Status:** Design approved, pending implementation plan.

## The UX trap (diagnosed from code + the reproduced case)

In the editor's "Background Music" section (in BOTH `RightSettingsPanel.tsx` and `OrderPanel.tsx`):

1. **Two-step gate:** BGM is OFF by default (a toggle). The user must first flip the toggle ON, and only then is the track list shown, and only then can they select a track. Two separate actions; forget either and the output is silent.
2. **Audition vs Select confusion:** each track row has a ▶ "preview/audition" button right next to the select target. A user clicks ▶, *hears* the track, assumes it's applied, but never selects it → `bgmFile` stays empty → render is silent.
3. The render bakes BGM only when `bgmEnabled && bgmFile` (page.tsx:1956). With the toggle on but no track (or a track auditioned but not selected), `bgmFile` is empty → no music.

## Goal

Make background music foolproof: **selecting a track = that track is in the video.** Remove the toggle gate and the audition/select ambiguity. UI-only; the render/burn pipeline is not touched.

## Design (option A, approved)

### Interaction model
- **Remove the separate BGM on/off toggle.** Under "Background Music", the track list is **always visible**.
- The list starts with a **"🚫 ไม่ใส่เพลง" (None)** item, selected by default = no music.
- **Clicking a track selects it = music ON** — sets `bgmFile`; the row shows a ✓ + selected styling.
- Clicking **"ไม่ใส่เพลง"** (or clicking the already-selected track again) = OFF (`bgmFile = ""`).
- The **▶ audition** button stays per track but is visually clearly a separate small icon button with a "ฟังตัวอย่าง" tooltip — auditioning never changes the selection.
- The **Volume** slider shows only when a track is selected (no point when there is none).

### Under the hood (minimal, safe)
- `bgmFile` is the single source of truth.
- **Derive `bgmEnabled` from `bgmFile`:** in `page.tsx`, `useEffect(() => setBgmEnabled(!!bgmFile), [bgmFile])`. This keeps every existing consumer of `bgmEnabled` working unchanged — the render patch (`bgmEnabled && bgmFile`, page.tsx:1956), the save config (1830), the burn flow, the status chip (4505), draft save/restore (838-839). Effectively `bgmEnabled && bgmFile` collapses to "a track is selected."
- The panels stop rendering/owning the toggle; they only call `setBgmFile`. No new prop contract needed beyond what exists (`bgmFile`, `setBgmFile`, `bgmVolume`, `setBgmVolume`, `systemTracks`, `userTracks`).
- Apply the SAME restructure to **both** `RightSettingsPanel.tsx` and `OrderPanel.tsx` so the two panels stay consistent.

### Result
- No "enabled-but-no-track" silent state can exist.
- No toggle to forget; one action (pick a track) guarantees music.
- The render-time-warning safety net (the rejected option B) is unnecessary.

## Files

- `src/app/(dashboard)/video-editor/page.tsx` — add the `bgmEnabled = !!bgmFile` derivation effect; remove `setBgmEnabled` from the props passed to the panels if it becomes unused (or leave the setter, just unused by the panel UI). Ensure draft-restore (`838-839`) still ends with `bgmEnabled` correct (the effect covers it).
- `src/app/(dashboard)/video-editor/_components/RightSettingsPanel.tsx` — restructure the Background Music block (lines ~350-414): drop the toggle, always show list, add "None" option, volume-when-selected, audition tooltip.
- `src/app/(dashboard)/video-editor/_components/OrderPanel.tsx` — same restructure (lines ~211-330).

## Edge cases
- **Draft restore** with a saved `bgmFile`: the derivation effect sets `bgmEnabled = true` → music applies. With empty `bgmFile`: `bgmEnabled = false` → "None" selected. Correct.
- **Uploaded track** still selectable the same way (sets `bgmFile` to the uploaded url) → music ON.
- **Clearing**: selecting "None" or re-clicking the selected track sets `bgmFile = ""` → derived OFF.

## Out of scope
- Live BGM playback in the editor video preview ("what you hear = what you get", option C) — separate, larger.
- A render-time "you enabled BGM but picked no track" warning (option B) — made moot by this design.

## Testing
- Live browser QA (logged in as duckyhero): under Background Music, confirm the list shows without any toggle; click a track → ✓ appears + the `🎵` chip shows the file; render → prod log `[render] bgmFile: /music/...`; click "ไม่ใส่เพลง" → chip shows "No music selected" and a render logs `bgmFile: undefined`. Verify both panels behave the same.
- `tsc --noEmit` 0 errors, `npm run build` exit 0.

## Risk
Low — UI-only. The render/burn/save/draft pipeline is untouched because `bgmEnabled` keeps its exact meaning (now derived). The only behavior change is in how the user picks music.
