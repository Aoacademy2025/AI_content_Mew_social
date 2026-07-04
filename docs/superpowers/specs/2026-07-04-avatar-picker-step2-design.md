# Design — Avatar picker in editor v2 Step 2

**Date:** 2026-07-04
**Branch:** `mew/avatar-picker-v2` (worktree)
**Status:** Design — awaiting spec review

## Problem

In the v2 editor's Step 2 ("องค์ประกอบ"), the presenter avatar can only be set by
**pasting a single HeyGen Avatar ID** into a text field hidden under "ตั้งค่าขั้นสูง"
(`Step2Elements.tsx` avatar group). A user with several HeyGen avatars has no way to
see and switch between them in the editor — they must go to HeyGen, copy an ID, and
paste it every time. Mew wants to "add avatars" = pick from her avatars easily, while
keeping paste-by-ID as a fast path for power users with many avatars.

## Goal

Give Step 2 a **visual avatar picker** sourced from the user's HeyGen account, so the
user can browse and select an avatar without pasting an ID — **and** keep an
always-visible paste-ID field as an equally-fast alternative. Both drive the same
`avatarId`.

This is **one avatar per clip** (unchanged). It is NOT multiple avatars within one
video.

## Non-goals (explicit scope boundaries — YAGNI)

- ❌ Multiple avatars **within one video** (different presenter per segment). Out of scope.
- ❌ v1 editor / `video-creator/page.tsx`. Only **v2 Step 2** changes.
- ❌ New DB model / storage / migration. The "library" is the HeyGen account list,
  already served by `/api/heygen/avatars` (with cache + durable-stale fallback).
- ❌ A curated HERO-side avatar shortlist. (Considered and rejected — the auto HeyGen
  list plus search/own-first ordering covers it without new storage.)
- ❌ Settings management page for avatars.
- ❌ `talking_photos`. Picker shows only the `avatars` array, matching what
  `/api/heygen/avatars` returns today.
- ❌ Changing the render pipeline, job submit, `resolveAvatarRequest`, or the saved
  default (`heygenAvatarId`). The picker only sets the project's `avatarId`, which the
  existing draft-persist + `avatarInfo` preview + job submit already handle.
- ❌ Changing avatar **mode** (bookend / bookend-both / full) or intro/tail secs — those
  stay where they are (Advanced).

## Existing architecture this reuses (verified)

- `GET /api/heygen/avatars` → `{ avatars: [{ avatar_id, avatar_name, preview_image_url,
  gender, is_public }], stale }`. Paid-only (PRO/BUSINESS); 400 if no HeyGen key; 401 on
  bad key; 403 if not paid. Backed by `getHeyGenAvatarList` — 5-min in-memory cache +
  7-day durable-stale fallback when HeyGen is slow. (`src/app/api/heygen/avatars/route.ts`,
  `src/lib/heygen-avatars.ts`)
- `useV2Project` already owns `avatarId` / `setAvatarId`, persists it in the draft, and
  fetches preview `avatarInfo` (name + thumbnail) via `/api/heygen/avatar-info` on change.
  (`src/app/(dashboard)/video-editor/_v2/useV2Project.ts`)
- `MusicLibraryModal` is a local modal pattern to mirror for the picker.
  (`src/app/(dashboard)/video-editor/_v2/MusicLibraryModal.tsx`)
- `useBgm` is a local data-loading hook pattern to mirror.
  (`src/app/(dashboard)/video-editor/_hooks/useBgm.ts`)

## UX design

Avatar group ("อวตารพิธีกร"), when `มีอวตาร` is selected:

1. **Selected-avatar card** — thumbnail (from `avatarInfo.previewUrl`) + name
   (`avatarInfo.name` / fallback the raw ID / "ยังไม่ได้ตั้งอวตาร"). Same info shown today.
2. **"เลือกจากคลัง" button** → opens the **Avatar picker modal**.
3. **Inline "หรือวาง Avatar ID เอง" field** — always visible directly under the button
   (moved UP from Advanced). Bound to `avatarId`; pasting shows the preview immediately
   (existing `avatarInfo` effect). This is the power-user fast path.
4. Both #2 and #3 write the same `avatarId` — choosing either keeps the other in sync.
5. **Advanced** now holds only: mode (bookend / เปิด+ปิด / ทั้งคลิป) + intro/tail secs.
   (The paste-ID field is relocated to #3, not deleted — honors the "move, don't cut"
   policy.)

### Avatar picker modal

- **Search box** — filters by name (case-insensitive substring).
- **Section "อวตารของคุณ"** (`is_public === false`) — always shown.
- **Section "อวตารสาธารณะของ HeyGen (N)"** (`is_public === true`) — collapsed behind a
  toggle, since HeyGen accounts often list hundreds of public/stock avatars.
- **Grid** of cards: thumbnail + name; currently-selected avatar highlighted.
- Click a card → `setAvatarId(avatar_id)` + close modal.
- **States:**
  - Loading → spinner/skeleton.
  - Not paid (403) / no key (400) / bad key (401) → friendly message + link to
    `/settings` (BYOK). The inline paste-ID field still lets them proceed.
  - Empty list → "ยังไม่มีอวตารในบัญชี HeyGen — สร้างที่ heygen.com หรือวาง ID เองด้านล่าง".
  - Stale (`stale: true`) → subtle "อาจไม่ใช่รายการล่าสุด" note + "โหลดใหม่" button
    (calls `reload`).

## Component plan (isolated, each testable alone)

| File | New/Edit | Responsibility |
|---|---|---|
| `src/app/(dashboard)/video-editor/_hooks/useHeygenAvatars.ts` | **new** | Lazy-fetch `/api/heygen/avatars`; return `{ avatars, loading, error, stale, reload }`. Mirrors `useBgm`. Maps HTTP status → typed error (`no-key` / `not-paid` / `bad-key` / `failed`). Caches within the hook so reopening the modal doesn't refetch. |
| `src/app/(dashboard)/video-editor/_v2/avatar-filter.ts` | **new** | Pure `partitionAvatars(list, query)` → `{ own, publicOnes }`, filtered by search + own-first. No React. Unit-tested by a verify script. |
| `src/app/(dashboard)/video-editor/_v2/AvatarPickerModal.tsx` | **new** | Presentation-only modal (search, sections, grid, states). Props: `open`, `onClose`, `selectedId`, `onSelect(avatarId)`, plus the hook's data. Mirrors `MusicLibraryModal`. |
| `src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx` | **edit** | Avatar group only: selected-avatar card + "เลือกจากคลัง" button (modal open state) + inline paste-ID field; move mode/secs to be the sole Advanced contents. |

Data flow: modal/inline field → `p.setAvatarId(id)` → existing `avatarInfo` effect
fetches preview → existing draft persist → existing job submit. **Nothing downstream of
`avatarId` changes.**

## Testing

- **Verify script** `scripts/verify-avatar-filter.ts` (team `tsx` pattern) — asserts
  `partitionAvatars`: own/public split, search filter, ordering, empty query.
- **Build-verify** `npm run build` in the worktree (render-backend untouched, but hygiene).
- **Browser QA** on a paid account: open Step 2 → avatar on → "เลือกจากคลัง" shows the
  HeyGen list → pick one → card + summary update → render one test clip → avatar correct.
  Also verify: paste-ID path still works and stays in sync; not-paid/no-key state shows the
  Settings link.

## Rollout / risk

- **Low risk:** additive UI, no pipeline/DB/API change, no new env flag. `avatarId`
  contract identical to today, so a bad picker can always be bypassed via paste-ID.
- No feature flag needed (the v2 editor is already live for all users). If desired we can
  gate behind nothing — it degrades gracefully for non-paid users (picker shows the
  upgrade/Settings message; paste-ID unchanged).
- PR into `main`; Mew rebases + merges + deploys. No overlap with the other agent's work
  (confirmed different area).

## Open questions

None blocking. (Optional future: "ตั้งเป็นค่าเริ่มต้น" to also PATCH `heygenAvatarId`;
include `talking_photos`. Both deferred.)
