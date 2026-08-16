# Pricing Rework — P2: Minutes quota + Capped trial (Implementation Plan)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Make the user-facing generation quota MINUTES-based (the cost unit), displayed as "~X clips", and turn the 7-day trial into a capped reverse-trial. Built on P1's `minute-limits.ts`.

**Architecture:** `minute-limits.minutesLimitForPlan` becomes the single source, reading minute constants from `plan-limits.ts`. The `/api/videos/usage` API reports minutes. The legacy clip meter (`usageCount`) is left intact (still used by render-charge paths) — minutes are the new gen-gate (P1 already enforces them in `tts-gemini`); we do NOT rip out the clip meter in P2.

**Conflict note (security agent deploying in parallel):** all P2 files (`plan-limits.ts`, `minute-limits.ts`, `usage/route.ts`, `trial.ts`) are NOT touched by the security audit (render/thumbnail/fetch-stock/MCP). The **watermark** task IS deferred — it touches the Remotion render composition which overlaps the security render-crash fix; do it after the security deploy + rebase.

## Global Constraints
- Additive only; flag-gated where behaviour changes (`NEXT_PUBLIC_PRICING_V2`). Legacy OFF = today.
- Minutes per plan (from the locked spec): **FREE 5 · PRO 80 · BUSINESS 150** (1 clip ≈ 1 minute for display).
- Test pattern: `scripts/verify-*.ts` via `npx tsx`. Thai copy. Money/credit untouched here.

---

### Task 1: Minutes as the plan quota (single source + usage API)

**Files:**
- Modify: `src/lib/plan-limits.ts` (add `minutesPerMonth` to each LIMITS const + a `minutesPerMonthForPlan` getter)
- Modify: `src/lib/minute-limits.ts` (`minutesLimitForPlan` reads from plan-limits instead of its hardcoded map)
- Modify: `src/app/api/videos/usage/route.ts` (also return minute usage)
- Test: `scripts/verify-minutes-quota.ts`

**Interfaces:**
- Produces: `minutesPerMonthForPlan(plan: string): number` from plan-limits; `minutesLimitForPlan` now delegates to it. Usage API response gains `minutes: { used, limit, remaining }`.

- [ ] **Step 1:** add `minutesPerMonth` to `FREE_LIMITS` (5), `PRO_LIMITS` (80), `BUSINESS_LIMITS` (150); add `export function minutesPerMonthForPlan(plan): number { return limitsForPlan(plan).minutesPerMonth ?? 5; }`.
- [ ] **Step 2:** in `minute-limits.ts`, change `minutesLimitForPlan` to `return minutesPerMonthForPlan(plan)` (import from plan-limits) — delete the hardcoded `{FREE:5,PRO:80,BUSINESS:150}` map so there's ONE source. Keep behaviour identical (same numbers).
- [ ] **Step 3:** write `scripts/verify-minutes-quota.ts` asserting `minutesLimitForPlan("PRO")===80`, `BUSINESS===150`, `FREE===5`, unknown→5, and that it equals `minutesPerMonthForPlan`. Run → fail → implement → pass.
- [ ] **Step 4:** in `/api/videos/usage/route.ts`, add a `minutes` block to the JSON using `checkMinuteQuota(userId)` (from minute-limits) → `{ used: limit-remaining, limit, remaining }`; keep the existing `clips` fields (additive, don't remove). Build `npx tsc --noEmit` 0 errors.
- [ ] **Step 5:** commit `feat(pricing): minutes as plan quota (single source in plan-limits) + usage API reports minutes`.

---

### Task 2: Capped reverse-trial (via the existing minute meter — no new counter)

**Approach:** a trial user is on plan PRO but should NOT get the full 80 min. Cap their minute allowance to a small trial budget by having `syncMinuteWindow` reduce `minutesLimit` for active-trial users. Reuses P1's meter — no new field, no gen-path hook, no separate clip counter.

**Files:**
- Modify: `src/lib/trial.ts` (export `TRIAL_MINUTES = 15`)
- Modify: `src/lib/minute-limits.ts` (`syncMinuteWindow` also selects `trialEndsAt`; if active trial, cap `minutesLimit = min(planLimit, TRIAL_MINUTES)`)
- Test: `scripts/verify-trial-cap.ts`

- [ ] **Step 1:** add `export const TRIAL_MINUTES = 15;` to `trial.ts`.
- [ ] **Step 2:** in `syncMinuteWindow` (`minute-limits.ts`), add `trialEndsAt: true` to the user select; compute `const isActiveTrial = user.trialEndsAt && user.trialEndsAt > now;` and set the effective limit `const usageLimit = isActiveTrial ? Math.min(minutesLimitForPlan(user.plan), TRIAL_MINUTES) : minutesLimitForPlan(user.plan);` (keep the existing reset/window logic). This means a PRO-trial user gates at 15 min, not 80.
- [ ] **Step 3:** write `scripts/verify-trial-cap.ts`: seed a user plan=PRO with `trialEndsAt` in the future → assert effective minute limit is 15 (via `checkMinuteQuota` or `reserveMinutes` blocking at 15); seed plan=PRO, `trialEndsAt` null → limit 80; expired trial (`trialEndsAt` past) → 80. Run → fail → implement → pass.
- [ ] **Step 4:** confirm `verify-minute-meter.ts` + `verify-minutes-quota.ts` still pass (non-trial unchanged), `tsc --noEmit` 0 errors. Commit (`feat(pricing): capped reverse-trial — trial users gate at TRIAL_MINUTES via the minute meter`).

---

### DEFERRED (post-security-deploy + rebase)
- **Free watermark** — Remotion composition gate when `plan==="FREE"` (overlaps security render fix).
- **P1.x** — wire resolver into `fetch-stock:1304` + MCP `[transport]:144` (overlaps security SSRF/IDOR).
- Editor UI: show "X นาที (~Y คลิป)" chip from the new usage `minutes` block.
