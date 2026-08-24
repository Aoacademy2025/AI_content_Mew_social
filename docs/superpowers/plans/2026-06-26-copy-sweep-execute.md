# New-Model Copy Sweep — EXECUTE (piece 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Customer-facing copy reflects the NEW model when its flags are on — "X คลิป/เดือน" → "X นาที/เดือน · ~X คลิป", and "ใส่ Gemini key ฟรี"/BYOK → managed framing. Flag-off = today's copy verbatim.

**Architecture:** Pure copy/display, gated. Minutes-copy gates on a new `minuteQuota` boolean (from the status + me endpoints, mirroring piece-2's `managed`); managed/BYOK-copy gates on `MANAGED_GEMINI` (server surfaces) / the `managed` signal (client surfaces). Supersedes the stale `2026-06-26-new-model-copy-sweep.md` (its enforcement/฿499/gemini-errors items are already done; piece-2 already HID most BYOK surfaces).

## Global Constraints

- **Flag-off byte-identical:** `MINUTE_QUOTA` off → "คลิป" copy verbatim; `MANAGED_GEMINI` off → BYOK copy verbatim. Every changed string is behind a flag (server `process.env.X==="1"`, client a gated boolean defaulting false).
- **Locked values (single source):** minutes FREE 5 / PRO 80 / BUSINESS 150 (`minutesPerMonthForPlan` in `plan-limits.ts` — use the helper, don't hardcode where it's reachable). Prices ฿599/฿990. **Display rule: "X นาที/เดือน · ~X คลิป"** (minutes = real meter; ~clips = relatable @ ~1 min/clip).
- **Distinguish "คลิป" senses:** only the QUOTA "คลิป" (count per month) → minutes. "คลิป" meaning the video itself, clip LENGTH, or b-roll clips STAYS (e.g. mcp `whatFor:"คลิป b-roll"`, "คลิปยาวสุด N นาที", "รองรับคลิปยาวขึ้น", avatar "ทั้งคลิป").
- **Positioning:** use the pre-approved drafts below (Mew approved "เอาตามที่แนะนำ ไล่แก้ทั้งระบบ"); she can tweak wording later at /admin or in copy.
- Build on `mew/managed-path-ux` (HEAD 779f5f6). NOT pushed/merged/deployed. No `.superpowers/` in git.

## Out of scope → FLAG for Mew (not pure copy / her action)
- **Live usage-display** on `pricing/page.tsx:139/155/170` ("ใช้ไป X/Y คลิปเดือนนี้") reads `me.usageCount/usageLimit` = CLIP counts. Switching to minutes needs `/api/user/me` to return minute usage (data-plumbing) → separate small follow-up, NOT this sweep.
- **plan-config DB values:** prod plan FEATURES come from DB `SiteConfig` (admin-editable), not the code DEFAULTS. This sweep updates the DEFAULTS (fresh-install/fallback baseline); **Mew updates the live values at /admin at go-live.**

---

### Task 1: client `minuteQuota` signal + in-app feature/selling copy คลิป→นาที

**Files:** `src/app/api/user/me/route.ts` (+ `src/app/api/user/api-keys/status/route.ts` for consistency); `src/components/ui/upgrade-modal.tsx`; `src/app/(dashboard)/pricing/page.tsx`; `src/lib/mcp/onboarding.ts`.

**Interfaces:** Produces `minuteQuota: boolean` on the `/api/user/me` JSON (gated) — clients read it. (Status route gets it too, mirroring `managed`.)

- [ ] **Step 1: add the gated signal.** In `/api/user/me` response, add (gated): `...(process.env.MINUTE_QUOTA === "1" ? { minuteQuota: true } : {})`. Same in `api-keys/status/route.ts`. (Byte-identical when off.)
- [ ] **Step 2: upgrade-modal.tsx:21** — `"100 คลิป/เดือน ไม่จำกัดจำนวนต่อวัน"` → when minuteQuota, `"80 นาที/เดือน · ~80 คลิป"` (source 80 from `minutesPerMonthForPlan("PRO")` if importable client-side; else the literal 80 with a comment). The modal must receive `minuteQuota` (thread from its parent which has `me`/status, or read once). Off → original string.
- [ ] **Step 3: pricing/page.tsx plan-NUDGE copy** (NOT the usage line — that's deferred):
  - `:147` `"เหลือ 2 คลิป/เดือน"` → minuteQuota ? `"เหลือ 5 นาที/เดือน · ~5 คลิป"` : original.
  - `:163` `"100 คลิป/เดือน"` → minuteQuota ? `"80 นาที/เดือน · ~80 คลิป"` : original.
  Source `minuteQuota` from the `me` fetch this page already does.
- [ ] **Step 4: mcp/onboarding.ts:103** — `"มีโควต้าคลิปตามแผน"` → `\`มีโควต้า${process.env.MINUTE_QUOTA==="1" ? "นาที" : "คลิป"}ตามแผน\``.
- [ ] **Step 5:** `npx tsc --noEmit` 0. Flag-off proof (minuteQuota absent→false→original copy) in report. Commit `feat(copy): in-app feature copy คลิป→นาที behind MINUTE_QUOTA + minuteQuota signal`.

---

### Task 2: sale page managed framing + plan-config DEFAULTS

**Files:** `src/app/page.tsx`; `src/lib/plan-config.ts`.

**Pre-approved drafts (sale page, gate on `process.env.MANAGED_GEMINI === "1"` — server component):**
- `:76` pain 🔑 `"ใช้คีย์ฟรีของคุณเอง (Gemini + Pexels/Pixabay) ตั้ง 5 นาที..."` → managed: `"ไม่ต้องตั้งค่า AI เอง — ระบบจัดการ Gemini ให้ · ใส่แค่ Pexels/Pixabay สำหรับ B-roll (ฟรี)"`.
- `:80` FAQ `"เริ่มด้วย Gemini key (ฟรี) ของคุณ..."` → managed: `"AI หลักจัดการให้ — ไม่ต้องใส่ Gemini key เอง; Avatar / โคลนเสียง ค่อยใส่คีย์ HeyGen / ElevenLabs เพิ่มได้ มีคู่มือพา"`.
- `:334` `"...ตั้งคีย์ฟรี 5 นาที มีคู่มือพา"` → managed: drop the Gemini-key part, e.g. `"PRO ฟรี 7 วัน · ไม่ใช้บัตร · เริ่มได้ทันที"`.

- [ ] **Step 1: page.tsx** — for each of :76/:80/:334, render the managed string when `process.env.MANAGED_GEMINI === "1"`, else the original verbatim. (If these are in module-level arrays, compute the strings via a small `const managed = process.env.MANAGED_GEMINI === "1"` at render and branch.)
- [ ] **Step 2: plan-config.ts DEFAULTS** — update the leading QUOTA segment of each (display rule), leave other feature segments intact:
  - `:22 free_features` `"2 คลิป/เดือน · ยาวสุด 2 นาที"` → `"5 นาที/เดือน · ~5 คลิป · ยาวสุด 2 นาที"`.
  - `:29 pro_features` `"100 คลิป/เดือน · ยาวสุด 6 นาที"` → `"80 นาที/เดือน · ~80 คลิป · ยาวสุด 6 นาที"`.
  - `:36 business_features` `"300 คลิป/เดือน (3 เท่าของ PRO)"` → `"150 นาที/เดือน · ~150 คลิป (เกือบ 2 เท่าของ PRO)"`.
  (DEFAULTS are static fallbacks; prod reads DB → prod display unchanged until Mew edits /admin. This sets the new-model baseline for fresh installs.)
- [ ] **Step 3:** `npx tsc --noEmit` 0. Flag-off proof (MANAGED_GEMINI off → sale page strings verbatim; plan-config DB-backed so prod unaffected). Commit `feat(copy): sale page managed framing + plan-config minutes defaults`.

---

### Task 3: server / MCP managed copy

**Files:** `src/lib/mcp/onboarding.ts`; `src/lib/gemini-errors.ts`.

- [ ] **Step 1: mcp/onboarding.ts `PROVIDERS.gemini.whatFor`** (~13, `"...— จำเป็นเสมอ"`) — when managed, the guide already sets `required:false`; make the `whatFor` text managed-aware: `process.env.MANAGED_GEMINI==="1" ? "จัดการโดยระบบ — ไม่ต้องตั้งค่า" : "...— จำเป็นเสมอ"` (only the gemini entry).
- [ ] **Step 2: SERVER_INSTRUCTIONS BYOK block** (~88 "BYOK — ผู้ใช้ใช้ API key ของตัวเอง" + ~89 "ตั้ง key ทั้งหมด...") — gate the Gemini-specific framing behind `!managed` (the Gemini-required line is already gated from piece-2; finish the BYOK-intro wording so managed users get "ระบบจัดการ Gemini ให้; ใส่เฉพาะ Pexels/Pixabay (+ ElevenLabs ถ้าจะโคลนเสียง)"). Keep the non-Gemini key guidance.
- [ ] **Step 3: gemini-errors.ts `quota` message** (the `"...ผูกบัตร Google..."` / free-quota wording) — `quota` is a transient kind kept as-is by piece-2, but its text assumes a user key. When `managed`, replace the "bind your Google card / free quota" instruction with a platform-framed line ("ระบบกำลังใช้งานหนาแน่น ลองใหม่อีกครั้งสักครู่"). Thread `managed` (already passed from `gemini.ts:43`). Off → original.
- [ ] **Step 4:** `npx tsc --noEmit` 0; `npx tsx scripts/verify-gemini-managed.ts` still green. Flag-off proof. Commit `feat(copy): MCP whatFor/SERVER_INSTRUCTIONS + gemini quota message managed-aware`.

---

## Final review (after T3)
Opus: flag-off byte-identical (MINUTE_QUOTA off → คลิป copy; MANAGED_GEMINI off → BYOK copy); the "คลิป"-sense distinction held (no video/length/b-roll "คลิป" wrongly changed); numbers match `minutesPerMonthForPlan`; no logic touched (pure copy + 1 gated signal field). Triage minors. Then present to Mew with the flagged follow-ups (usage-display data switch; plan-config DB /admin update).

## Self-Review
- Covers: in-app feature copy (T1), marketing + defaults (T2), server/MCP copy (T3). Deferred/ flagged: live usage-display data switch, plan-config DB values. ✓
- Flag-off: every string flag-gated; the new `minuteQuota` field is gated-spread (absent when off). ✓
- "คลิป" sense: only quota-count strings changed; b-roll/length/video "คลิป" untouched. ✓
