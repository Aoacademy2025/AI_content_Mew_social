# Avatar Position Lock — Design Spec

- **Date:** 2026-06-29
- **Owner:** Mew
- **Status:** Approved design (pending spec review → implementation plan)
- **Branch:** `mew/avatar-position-lock`

## 1. Goal

Let a user position a HeyGen avatar **once per Avatar ID**, **save & lock** that position/size, and have it **auto-applied every time that avatar is used — in the web editor AND in MCP/AI automation**. The avatar must always come into the system **whole (head + arms not cut)**; size can be small or large because the user adjusts it themselves.

Driven by team reports after launch:
- "ใส่ ID Avatar ขนาดปกติหัวไม่ตัด แต่พอเจนใน studio หัวตัด + zoom ใกล้มาก" (sumawadee, ticket `cmqyqxmn`)
- "ขยับ AVATAR แล้วต้องเรนเดอร์ใหม่ เปลืองเครดิต / อยากปรับ avatar realtime ไม่ต้องเจนใหม่" (veerawich, ticket `cmqrqvcf`)

## 2. Root cause (verified by audit + live HeyGen test, 2026-06-29)

- We send a **single hardcoded** `scale=2.02, offset.y=0.13` to HeyGen's avatar `character` config (`generate-with-bg/route.ts`) for **every avatar, every user** (verified: 35+ prod generate-payloads all identical).
- HeyGen avatars are **custom photo-avatars whose native framing differs per person** (head height / headroom / body crop vary). A fixed zoom can't fit all: it cuts some heads and makes others float-small. Live test on duckyhero ("Mew Social") + veerawich ("Emmie") confirmed: same 2.02 → different result per avatar.
- The web **preview is a CSS approximation using the static thumbnail** (`avatarScale*62%`, `objectPosition: center 130%`) → it does **not** match the real render. This is the historical "HeyGen ไม่ตรงกับที่โชว์ในระบบ (ซูม/เพี้ยน)" bug. Adjusting is therefore unreliable, so in practice nobody changes the default.
- **HeyGen v3 `fit:contain/cover` is NOT usable here:** it returns the avatar on its *own* background (no green screen), so it cannot be chroma-keyed onto our b-roll. Our pipeline requires a **green-screen** avatar. (v3 fit would only suit a future "full-avatar, no b-roll" mode.)

## 3. Pipeline context (confirmed with Mew)

HeyGen renders the avatar on a **green** background → we chroma-key the green out → **composite the avatar layer over b-roll** → add subtitles / headline / subheadline. Position-lock is about **where the (green-keyed) avatar layer sits on the 9:16 canvas** — it does not touch b-roll or subtitles.

## 4. Requirements

1. Avatar always enters **whole / uncut** (head + arms visible), even if small.
2. User can **move + scale** the avatar layer in the **Video Editor**.
3. The editor preview **matches the final render** (close the historical mismatch).
4. Adjusting is **free and instant** — no HeyGen re-generation, no credit burn (fixes `cmqrqvcf`).
5. A **Save** action locks the position **per Avatar ID** (per user).
6. On reuse of that Avatar ID, the saved position is **auto-applied** in the web editor **and** in MCP `create_video_job` (automation).

## 5. Non-goals (YAGNI)

- **Multiple named presets per avatar** — design the data model to allow it later (add `name`/`isDefault`), but ship **one position per (user, avatar)** now. (Mew: simpler first-time UX; upgrade later.)
- **Migrating avatar generation to HeyGen v3** — green-screen requirement rules it out for the b-roll mode.
- **Changing offset units / dimension / the chroma-key math** — see Regression Guardrails (§10).
- Position presets for uploaded (non-API) avatar clips — those already work; out of scope.

## 6. Architecture & data flow

```
HeyGen generate (GREEN, whole/uncut, fixed conservative scale)   ← one credit, once
        │  green-screen avatar video
        ▼
Editor loads AvatarPreset[user, avatarId]  →  prefills scale/offset (or conservative default)
        │
        ▼
User drags / scales avatar layer  ──(live)──►  FAITHFUL preview (2a: same geometry as render)
        │                                        no HeyGen call — pure client + composite math
        ▼
[Save position]  →  upsert AvatarPreset[user, avatarId] = {scale, offsetX, offsetY}
        │
        ▼
Render / Burn  →  /api/heygen/composite  with avatarLayout={scale,offsetX,offsetY}
                  →  layoutGeometry()  →  ffmpeg  [fg]scale=w:h ; overlay=x:y  over b-roll
```

Key idea: **generation framing and on-canvas positioning are decoupled.** HeyGen only brings the avatar in whole on green; **all sizing/positioning happens in our composite** (`layoutGeometry`, already implemented), so it is adjustable without re-generating.

## 7. Data model

New Prisma model (additive → `prisma db push` on deploy):

```prisma
model AvatarPreset {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  avatarId  String                // HeyGen avatar_id (or talking_photo_id)
  scale     Float                 // layoutGeometry scale (1.0 = full canvas height)
  offsetX   Float    @default(0)  // layoutGeometry offset units (same as composite, px/400 convention)
  offsetY   Float    @default(0)
  updatedAt DateTime @updatedAt
  createdAt DateTime @default(now())

  @@unique([userId, avatarId])    // one locked position per (user, avatar) — today
  @@index([userId])
}
// Future multi-preset: drop @@unique, add `name String` + `isDefault Boolean`.
```

Stored values are in the **composite `layoutGeometry` coordinate space** (canvas-relative), so Save → Load → render are all the same numbers with no conversion.

## 8. Component changes

- **Schema** — add `AvatarPreset` + back-relation on `User`.
- **Preset lib** (`src/lib/avatar-preset.ts`, pure + thin DB) — `clampLayout({scale,offsetX,offsetY})` (pure, reuse composite bounds: scale 0.05–4, offset −400..400), `getPreset(userId, avatarId)`, `savePreset(userId, avatarId, layout)`.
- **API** — `GET/PUT /api/avatar-presets/[avatarId]` (auth'd; PUT validates via `clampLayout`).
- **HeyGen generation** (`generate-with-bg/route.ts`) — change the default `character.scale`/`offset` to a **conservative "whole avatar" framing** (value validated in the plan; see §9). Generation no longer encodes the user's chosen position — positioning moved to composite.
- **Composite** (`composite/route.ts`) — for avatar-on-broll mode, **always use the `avatarLayout` path** (never the legacy full-cover `scale2ref` for positioned avatars). `layoutGeometry` already does the work; no math change.
- **Video Editor** (`video-editor/*`) — (a) on avatar load, fetch `AvatarPreset` → prefill the existing `avatarScale/offsetX/offsetY` state (else conservative default); (b) make the preview faithful (§9, approach 2a); (c) add a **"Save / Lock position"** button → PUT preset; (d) editor already sends `avatarLayout` to composite (keep).
- **Video Creator** (`video-creator/page.tsx`) — currently sends `avatarScale` as a **flat** field that `/api/heygen/composite` ignores (falls back to full-cover). Change it to send `avatarLayout: {scale, offsetX, offsetY}` (same shape the editor uses) seeded from the preset, so the initial composite is positioned (whole), not stretched-to-fill.
- **MCP** (`/api/[transport]` `create_video_job` → worker) — when an `avatarId` is supplied and no explicit layout is passed, **load `AvatarPreset` and apply it**. This is what gives automation the locked position for free.

## 9. Faithful preview (approach 2a) + default framing

**Preview (2a):** The editor's avatar preview box must be computed from the **same geometry as `layoutGeometry`** (the function that drives the ffmpeg overlay), not the current ad-hoc CSS (`scale*62%`, `objectPosition 130%`). Concretely:
- Extract `layoutGeometry` into a **pure shared module** importable by both the composite route and the editor, returning normalized box `{leftPct, topPct, widthPct, heightPct}` for a given `{scale, offsetX, offsetY}` against a 1080×1920 canvas.
- The editor renders the avatar box using those exact percentages, over the real b-roll, using the **avatar's actual video frame / green-keyed preview** (not the mismatched thumbnail). → "what you see = what renders."
- This is the regression-closing piece: **the preview can no longer disagree with the render**, because both read one geometry function.

**Default framing (whole/uncut):** When no preset exists, generation uses a **fixed conservative scale** chosen so the **full avatar (head + arms) is always inside** the green frame — accepting a smaller avatar that the user then scales up. The exact value is determined in the implementation plan by a quick render test across a few differently-framed avatars (incl. a previously-cut one), since HeyGen `scale` is platform-defined. The on-canvas default layout is likewise conservative (avatar fully visible, centered-lower).

## 10. Regression guardrails (Mew's primary concern — do NOT reopen the old bug)

- **Keep** the offset unit conversion in `generate-with-bg` (px ↔ −1..1 via `/400`) and the `720×1280` generation dimension / `1080×1920` composite dimension — untouched.
- **Keep** the chroma-key filter chain (`chromakey`/`despill`) and `layoutGeometry` math byte-identical; we only *extract/share* it, never change its formula.
- The preview is made to **follow** the render geometry, never the reverse — eliminating the "preview says one thing, render does another" class of bug by construction.
- Generation change is limited to the **default scale/offset constants**; the request shape to HeyGen is otherwise unchanged.
- Uploaded-clip avatar path is not touched.

## 11. Testing (team `verify-*.ts` pattern)

- **Pure:** `verify-avatar-layout-geometry.ts` — `layoutGeometry`/normalized-box: known scale/offset → expected w,h,x,y and leftPct/topPct/widthPct/heightPct (locks the editor↔render shared math); `clampLayout` bounds.
- **DB (throwaway SQLite):** `verify-avatar-preset.ts` — save→load round-trip, `@@unique(userId,avatarId)` upsert (re-save overwrites), per-user isolation, unknown avatar → null (conservative default applied).
- **MCP:** extend MCP avatar input test — `create_video_job` with a saved preset applies it; without one, uses the conservative default.
- `tsc --noEmit` clean; `prisma generate` for the new model.

## 12. Open / validation items (resolve during the plan)

1. **Exact conservative generation scale/offset** for "always whole" — pick via a quick HeyGen render test (a few avatars, including one that previously cut). Free on Mew's beta key.
2. Confirm the editor's avatar **frame source** for the preview (live green-keyed frame vs avatar preview video) renders cleanly in the box.
3. MCP: confirm where in the worker the layout is applied (compose step) and that an explicit caller-supplied layout still overrides the saved preset.
4. **Reconcile offset units (highest regression risk).** The editor's `avatarOffsetX/Y` state and `layoutGeometry`'s `−400..400` space are not obviously the same unit — `parseAvatarLayout` treats `|offset| < 0.5` as a no-op and falls back to full-cover. The shared geometry module (§9) must define **one** offset unit that the editor, the stored `AvatarPreset`, and the composite all use; the geometry unit test pins it. This is the single most likely place to silently reintroduce the preview≠render bug.
