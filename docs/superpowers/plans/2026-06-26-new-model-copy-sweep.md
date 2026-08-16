# New-Model Copy/Display Sweep + Quota Enforcement (#3/#4/#5)

> Branch: continue on `mew/managed-path-ux` (the "new-model UX" branch — it already has #1 managed-gates + #2 modal). **DEPLOY COUPLING:** this branch's copy assumes the NEW MODEL is LIVE → deploy it TOGETHER with `MANAGED_GEMINI=1` + minute-enforcement (Phase 2). Do NOT deploy the copy to current prod before flipping the flag (would mismatch). Mew approved "เอาตามที่แนะนำ ไล่แก้ทั้งระบบ" (2026-06-26).

## Values (single source)
Minutes: FREE 5 / PRO 80 / BUSINESS 150 (`minutesPerMonthForPlan`, plan-limits). Prices: ฿599 / ฿990 (DB plan-config). Display rule: **"X นาที/เดือน · ~X คลิป"** (minutes = real meter, ~clips = relatable estimate @ ~1 min/clip).

## PHASE 1 — Copy/Display (safe, this sweep)

### Task 1: Quota copy คลิป → นาที (display "X นาที/เดือน · ~X คลิป")
Spots (from audit): `src/lib/plan-config.ts` DEFAULTS (free_features ~22 "2 คลิป", pro ~29 "100 คลิป", business ~36 "300 คลิป"); `src/app/(dashboard)/admin/page.tsx` plan-feature defaults (~334/336/338); `src/app/(dashboard)/pricing/page.tsx` (~156 trial band, ~172 FREE upgrade nudge); `src/components/ui/upgrade-modal.tsx` (~21 PRO); `src/app/(dashboard)/video-editor/page.tsx` (~1223 BIZ upsell); `src/lib/mcp/onboarding.ts` (~100 "มีโควต้าคลิป"→"นาที"). Numbers from `minutesPerMonthForPlan` (don't hardcode where a helper exists). **EXCLUDE** `usage-limits.ts:81` (that's the CLIP-cap error message — tied to Phase 2 enforcement, not yet).

### Task 2: Sale page `src/app/page.tsx`
- ฿499 → ฿599 (pains 💰 line ~74).
- pains 🔑 (~77 "ใช้คีย์ฟรีของคุณเอง (Gemini...)") → managed selling point e.g. "ไม่ต้องตั้งค่า AI เอง — ระบบจัดการ Gemini ให้ · ใส่แค่ Pexels/Pixabay สำหรับ B-roll".
- FAQ (~81 "เริ่มด้วย Gemini key (ฟรี)") → managed framing ("AI หลักจัดการให้ ไม่ต้องใส่ Gemini key เอง; Avatar/เสียงโคลนใส่ HeyGen/ElevenLabs เพิ่มได้").

### Task 3: Key-required copy → managed framing
`src/components/settings/api-key-settings.tsx` (Gemini guide "จำเป็น" → "ไม่บังคับ / ระบบมีให้ · BYOK ออปชัน"); `src/app/(dashboard)/docs/page.tsx` (Gemini key setup section → optional/managed); `src/lib/mcp/onboarding.ts` SERVER_INSTRUCTIONS + `whatFor`/`buildSetupGuide` text ("Gemini จำเป็นเสมอ" → managed); onboarding `KeyOnboardingWizard.tsx` / `KeySetupChecklist.tsx` (Gemini row label "จำเป็น" → "ระบบจัดการให้ ✓ / ออปชัน").

### EXCLUDED from copy sweep (need managed-vs-BYOK LOGIC, not text → follow-up)
- `src/lib/gemini-errors.ts` (msgs telling user to fix their key) — for managed a Gemini failure = platform issue, for BYOK = their key → needs the mode per-request, not a blind copy change. Flag as managed-aware follow-up.

## PHASE 2 — Enforcement (careful, core; pending Explore + 1 policy Q)
Make MINUTES the sole governing quota (relax old clip-cap `reserveClipUsage`). ⚠️ minute-enforcement runs only in managed mode → removing clip-cap unguarded = quota hole for BYOK/flag-off. Must gate. POLICY Q for Mew: should BYOK users be minute-capped too, or keep a render-load cap? → present after the enforcement Explore returns, then build gated.

## Build: subagent-driven-development (implementer→reviewer per task). Final review at the end.
