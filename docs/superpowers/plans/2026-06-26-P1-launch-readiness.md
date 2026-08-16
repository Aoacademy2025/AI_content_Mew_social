# P1 — Launch-Readiness Copy + Visibility (consistency sweep)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. Source = the pre-launch-review findings in `.superpowers/sdd/progress.md` (Agents A consistency-remnants + C completeness/UX).

**Goal:** Close the consistency/visibility gaps the pre-launch review found so the new model feels coherent at go-live: no stale "fix your Gemini key"/clip copy, users can SEE their minute balance, and the trial 15-min cap + plan-change impacts are communicated.

**Architecture:** Pure copy + small UI, all flag-gated (`MANAGED_GEMINI`/`managed` for Gemini framing; `MINUTE_QUOTA`/`minuteQuota` for minutes; `NEXT_PUBLIC_CREDITS_LIVE` for credit mentions). No money-path changes. Flag-off byte-identical.

## Global Constraints
- **Flag-off byte-identical:** every changed string/UI is gated; flags off → today's copy/UI verbatim. Client surfaces use the existing signals (`managed` + `minuteQuota` from `/api/user/api-keys/status` and `/api/user/me`); server surfaces read `process.env`.
- **"คลิป" sense:** only QUOTA-count "คลิป" → minutes; b-roll/length/video "คลิป" stays.
- **Positioning:** draft sensible Thai copy following the locked model (minutes FREE5/PRO80/BIZ150; managed Gemini; credits overflow); these are display strings Mew can tweak.
- Branch `mew/managed-path-ux` (HEAD `077868d`). NOT pushed/merged/deployed. No `.superpowers/` in git. All tasks sonnet (copy/UI).

## Out of scope (separate / Mew)
- pricing usage-display "ใช้ไป X/Y คลิป" → minutes (needs `/api/user/me` to return minute usage = data-plumbing; flagged).
- plan-config DB `SiteConfig` values (Mew /admin at go-live).
- CLAUDE.md / STATUS.md doc refresh (internal; do last if time).

---

### Task 1: Gemini error-path copy → managed-aware
**Why:** Several Gemini error surfaces still tell managed users to "create a new key / open aistudio" — wrong when Gemini is server-managed (a failure is a platform issue). `gemini-errors.ts` was already made managed-aware; these are the OTHER paths the sweep missed.

**Files + spots (gate the BYOK wording behind `!managed`; when managed → platform message, no aistudio/Settings):**
- `src/app/api/videos/tts-gemini/route.ts` — its OWN `geminiErrorResponse()` (~167/181 "สร้าง key ใหม่จาก aistudio…"); thread `geminiMode`/`process.env.MANAGED_GEMINI` at the call sites (~337/374/406/422) so a managed-mode TTS failure returns a platform message.
- `src/app/(dashboard)/video-creator/page.tsx:857` — keywords error "ตรวจสอบ Gemini API Key หรือโควต้า Google" → managed: "ระบบ AI ขัดข้อง ลองใหม่หรือแจ้ง support" (read the local `managed` state this page already fetches).
- `src/app/(dashboard)/video-editor/page.tsx:1379` — the error-toast ACTION `{label:"สร้าง Key ใหม่", url:"aistudio…"}` for Gemini 401 → when managed, drop the aistudio action (platform message instead).
- `src/app/(dashboard)/docs/page.tsx:545-563` (ApiSetupDoc Gemini error boxes) + `:702-708` (VideoOnlyDoc) — wrap in `{!managed && …}`; thread `managed` into `VideoOnlyDoc` (it currently gets no managed prop).
- `src/app/api/videos/transcribe/route.ts:1016` — "Gemini API Key ไม่ถูกต้อง กรุณาตรวจสอบใน Settings" → managed-aware (lower-risk BYOK avatar path, but still reframe).

- [ ] Steps: gate each spot on managed (server `process.env.MANAGED_GEMINI==="1"`, client the fetched `managed`); `npx tsc --noEmit` 0; flag-off proof (MANAGED_GEMINI off → every string verbatim). Commit `feat(copy): Gemini error paths managed-aware (tts/creator/editor/docs/transcribe)`.

### Task 2: clip→minutes remnants + gate /pricing minutes line
**Files:**
- `src/app/(dashboard)/video-editor/page.tsx:1234` — BIZ upsell "300 คลิป/เดือน ไม่จำกัดต่อวัน" → `minuteQuota ? "150 นาที/เดือน · ~150 คลิป" : original` (the page has `minuteQuota` state from T1-copy-sweep).
- `src/app/(dashboard)/admin/page.tsx:334/336/338` — the plan-feature `useState` DEFAULTS ("2/100/300 คลิป/เดือน" + FREE's "ใช้ Gemini API key ของตัวเอง") → update to minutes copy + drop the Gemini-BYOK line (these seed the admin textarea; admin saves to DB).
- **Gate the minutes-per-tier line** (flagged by reviewers): `src/app/(dashboard)/pricing/page.tsx` (~:287-290 / the `{minutesPerMonthForPlan(key)} นาที/เดือน…` line) + `src/components/marketing/pricing-toggle.tsx` (the `minutesPerMonth` Tier display) — wrap in `MINUTE_QUOTA`/`minuteQuota` so the minutes copy doesn't show while clip-cap is still enforced.

- [ ] tsc 0; flag-off proof. Commit `feat(copy): clip→minutes remnants (editor upsell, admin defaults) + gate pricing minutes line`.

### Task 3: minute-usage visibility
**Why:** Users can't see their minute balance → hitting the cap is a surprise. The `chip` variant of `QuotaStatus` already shows minutes; extend the rest.
**Files:**
- `src/components/quota-status.tsx` — the **`row` variant** (~137-204) still renders "ใช้ไป X/Y คลิป" with no minutes branch; mirror the `chip` variant's `if (mins)` branch so the settings/billing row shows minutes when the usage payload has them.
- `src/app/(dashboard)/dashboard/page.tsx` — add a `<QuotaStatus variant="chip" />` (minute balance) on the landing screen (it currently shows only content/style `UsageBar`).
- Wire `refreshKey` on the existing `<QuotaStatus variant="chip" />` in `video-creator` (~2573) + `video-editor` (~3945) so the chip re-fetches after a render completes (the component supports `refreshKey` at quota-status.tsx:25; pass a counter incremented on render-done).

- [ ] tsc 0; flag-off proof (no behavior change when usage payload lacks minutes / flags off). Commit `feat(ux): minute balance visible in settings row + dashboard + refresh after render`.

### Task 4: trial-cap + plan-change comms
**Files:**
- Trial 15-min cap (`TRIAL_MINUTES=15`) is never communicated — a trial user thinks PRO=80 but is capped at 15. Add it to the trial banner (`src/components/**/trial-banner.tsx` or wherever the trial state shows) + the pricing trial band: e.g. "ทดลอง PRO: 15 นาที ใน 7 วัน". (gate on `minuteQuota` where client.)
- Plan downgrade notification (`src/lib/entitlements.ts` downgrade-notification body ~:165) — add the minute impact: "…กลับเป็น Free (เหลือ 5 นาที/เดือน)" when minute-quota mode. (gate `MINUTE_QUOTA`.)
- Credits-survive-plan-change: add one line in the settings credit section (or downgrade notice) that purchased credits persist across plan changes (gate `NEXT_PUBLIC_CREDITS_LIVE`).

- [ ] tsc 0; flag-off proof. Commit `feat(copy): communicate trial 15-min cap + plan-change minute/credit impacts`.

### Task 5: onboarding model panel + refund toast
**Files:**
- New-user onboarding has NO explanation of the model. Add a short managed-aware panel (in `KeyOnboardingWizard` / `DashboardOnboarding` / a first-run notice) explaining: "คุณมี X นาที/เดือน · ระบบจัดการ Gemini ให้ ไม่ต้องตั้งค่า · เกินโควต้าซื้อเครดิตเพิ่มได้" — gate the minutes part on `minuteQuota`, the managed part on `managed`, the credits part on `NEXT_PUBLIC_CREDITS_LIVE`.
- Refund toast: when a render fails/supersedes and minutes (or credits) are refunded, show "คืน X นาที" (or "คืน X เครดิต") alongside the error so the user knows they weren't charged. Source from the render status / the refund amount. (gate `minuteQuota`/`NEXT_PUBLIC_CREDITS_LIVE`.)

- [ ] tsc 0; flag-off proof. Commit `feat(ux): onboarding minutes/credits/managed panel + render-refund toast`.

---

## Final review (after T5)
Sonnet whole-branch review: flag-off byte-identical across MANAGED_GEMINI/MINUTE_QUOTA/NEXT_PUBLIC_CREDITS_LIVE; "คลิป" sense held; no money-path touched; the managed/minute signals sourced consistently. Triage minors. Then present to Mew — new model fully launch-ready (pending her merge/deploy + /admin DB + the data-plumbing usage-display follow-up).

## Self-Review
- Covers Agent-A remnants (T1 Gemini errors + T2 clip copy) + Agent-C UX (T3 visibility, T4 trial-cap/plan-change, T5 onboarding/refund). ✓
- Flag-gated; "คลิป" sense; out-of-scope (usage-display data switch, plan-config DB, docs) deferred. ✓
