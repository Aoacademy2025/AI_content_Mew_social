# P0 — Credit Earn/Surface Port + Overflow-Reachability + Trial-Credit Fix

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. This is the launch-blocker fix set from the pre-launch review (ledger `.superpowers/sdd/progress.md`).

**Goal:** Make the credit/overflow half of the new model actually FUNCTION at go-live: users get monthly granted credits, the render path can REACH the overflow, users can SEE/BUY credits, the buy→return loop works — and trial credits can't be farmed.

**Architecture:** Port the P3.5 credit-EARN+SURFACE work from `mew/pricing-rework-p2` (which has it) onto `mew/managed-path-ux` (which lacks it), using the by-hand-port + selective-cherry-pick sequence the merge-strategy agent mapped (in the ledger). PLUS two managed-path-ux-only fixes: the render precheck (Blocker #2, not on p2) and the trial-credit design (ข)+(ก). Everything stays flag-gated (`CREDITS_LIVE`/`NEXT_PUBLIC_CREDITS_LIVE`), flag-off byte-identical.

## Global Constraints
- **Source branch for ports:** `mew/pricing-rework-p2` (HEAD `ce9e532`). Use `git show mew/pricing-rework-p2:<path>` to read its versions. Do NOT merge/cherry-pick blindly — **p2 commit `d3a53ff` REVERTS our work** (the `MANAGED` Gemini framing `622a047` + ฿599 fix `bfd2b28`). Port by-hand where noted; keep OUR framing/price/`minuteQuota`.
- **Flag-off byte-identical:** all new behavior gated `CREDITS_LIVE` (server) / `NEXT_PUBLIC_CREDITS_LIVE` (client). Flags OFF → current behavior verbatim. Grant/spend/reset are no-ops when `CREDITS_LIVE!=="1"`.
- **Trial-credit design (LOCKED by Mew):** (ข) trial gets NO credits — do NOT port p2's `grantTrial` credit hook. (ก) reset `granted` to `MONTHLY_GRANT[newPlan]` on plan DOWNGRADE/revert (once per transition, idempotent, `CREDITS_LIVE`-gated) — closes the PRO→FREE churn credit-leak.
- **Money-safety:** the credit foundation is shared by overflow (managed-path-ux) AND AI-image (p2, deferred) — keep `refundCredits`/`spendCredits` signatures coherent; build-verify all callers.
- Branch `mew/managed-path-ux` (HEAD `dd8e153`). NOT pushed/merged/deployed. No `.superpowers/` in git. Tasks T1/T2/T5 = opus (core/money); T3/T4 = sonnet (UI).

## Out of scope (separate decisions — NOT P0)
- P3.4 AI-image credit-spend (`2d7fdbb`/`a68f4b7`, fetch-stock) + kie cost helpers — bring only if AI-image metering is wanted now.
- tts-gemini minute-refund (`9ebb8af`).
- P1 copy remnants (~10 spots) + minute-visibility UI + trial-cap copy + plan-config DB — the next phase after P0.

---

### Task 1: credits.ts foundation port (CORE — opus)
**Files:** Modify `src/lib/credits.ts`, `src/lib/minute-credits.ts`, `scripts/verify-credit-overflow.ts`; Create `scripts/verify-credit-earn.ts`.

Bring from `git show mew/pricing-rework-p2:src/lib/credits.ts`:
- `refundCredits(userId, fromGranted, fromPurchased, action)` (4-arg per-bucket, no-op on 0, negative-bucket guard) — REPLACES our 3-arg version.
- `spendCredits` WIDENED return `{ ok, balanceAfter, fromGranted, fromPurchased }` (additive — our `minute-credits.ts:34` reads only `.ok`/`.balanceAfter`, stays compatible).
- `ensureMonthlyGrant(userId)` (no-op if `CREDITS_LIVE!=="1"` OR plan allowance ≤0 OR already granted within the `USAGE_PERIOD_DAYS` window via `grantedResetAt`; else `resetMonthlyGranted(userId, plan)` hard-sets `granted` to `MONTHLY_GRANT[plan]`, stamps `grantedResetAt`; never touches `purchased`). Add the `import { USAGE_PERIOD_DAYS } from "@/lib/usage-limits"`.
- Do NOT port the kie cost helpers (P3.4, out of scope).

- [ ] **Step 1:** read both branches' `credits.ts`; apply p2's `refundCredits`/`spendCredits`/`ensureMonthlyGrant` onto our file, preserving anything ours has that p2 lacks.
- [ ] **Step 2:** fix the now-broken caller `src/lib/minute-credits.ts:54` → `refundCredits(userId, 0, res.creditsSpent, action)` (overflow refunds to purchased — same effect as before).
- [ ] **Step 3:** update `scripts/verify-credit-overflow.ts` for the 4-arg `refundCredits` (refund asserts → `refundCredits(u,0,4,"...")`).
- [ ] **Step 4:** write `scripts/verify-credit-earn.ts` — assert `ensureMonthlyGrant`: PRO → granted=50; idempotent within window (2nd call no-op); FREE (allowance 0) → no grant; `CREDITS_LIVE` off → no-op; purchased untouched.
- [ ] **Step 5:** `npx tsx scripts/verify-credit-earn.ts && npx tsx scripts/verify-credit-overflow.ts && npx tsx scripts/verify-minute-credits.ts` all green; `npx tsc --noEmit` 0. Commit `feat(credits): port refundCredits 4-arg + spendCredits split + ensureMonthlyGrant from p2`.

### Task 2: grant hooks + trial (ข) + downgrade-reset (ก) (CORE — opus)
**Files:** Modify `src/app/api/payments/webhook/route.ts`, `src/lib/entitlements.ts`; Test extend `scripts/verify-credit-earn.ts`.

- [ ] **Step 1: webhook grants** — from `git show mew/pricing-rework-p2:src/app/api/payments/webhook/route.ts`: add `ensureMonthlyGrant(userId)` at plan-activation (`checkout.session.completed`) AND `invoice.paid` renewal (CREDITS_LIVE-gated, fire-and-forget). Also bring p2's `eee3c1e` hardening (validate user exists + `payment_status==="paid"` before grant; CREDITS_LIVE guard on the credits branch; req.json try/catch→400). Our pack-purchase block stays.
- [ ] **Step 2: trial (ข) — NO credit grant.** Do NOT add any credit grant to `src/lib/trial.ts grantTrial`. (Trial users get only `TRIAL_MINUTES`; credits are a paid benefit.) Leave `trial.ts` credit-free.
- [ ] **Step 3: (ก) downgrade reset.** In `src/lib/entitlements.ts syncUserEntitlement`, at the point it WRITES a downgraded plan (trial/sub expiry → FREE, or any plan drop), add (CREDITS_LIVE-gated, ONCE per transition — only where the plan actually changes, not every sync): `resetMonthlyGranted(userId, newPlan)` so `granted` drops to the new plan's allowance (FREE→0). Import `resetMonthlyGranted` from `@/lib/credits`. ⚠️ idempotency: ensure this fires only on the actual plan-change write, never on a steady-state sync.
- [ ] **Step 4:** extend `verify-credit-earn.ts`: grant fires on PRO activation; trial grant does NOT happen (grantTrial leaves credits 0); downgrade PRO(granted 50)→FREE resets granted→0 (purchased preserved); CREDITS_LIVE off → all no-ops.
- [ ] **Step 5:** `npx tsx scripts/verify-credit-earn.ts` green; tsc 0. Flag-off proof (CREDITS_LIVE off → webhook/entitlements byte-identical). Commit `feat(credits): grant-on-subscribe/renewal + trial-no-credits + reset-granted-on-downgrade`.

### Task 3: balance route + credits route + settings credit UI (sonnet)
**Files:** Modify `src/app/api/credits/balance/route.ts`, `src/app/api/payments/credits/route.ts`, `src/app/(dashboard)/settings/page.tsx`; Create `src/components/settings/credits-billing-section.tsx`.

- [ ] **Step 1:** take p2's `balance/route.ts` (superset: `CREDITS_LIVE` guard, calls `ensureMonthlyGrant`, returns `live` field). Confirm `@/lib/api-error` exists on this branch (if not, inline the error shape).
- [ ] **Step 2:** take p2's `payments/credits/route.ts` (fixed `cancel_url` → `/settings?tab=billing&credits=cancelled`, CREDITS_LIVE 403 guard, missing-pack 400). `success_url` already correct.
- [ ] **Step 3:** create `src/components/settings/credits-billing-section.tsx` from `git show mew/pricing-rework-p2:src/components/settings/credits-billing-section.tsx` (balance card granted/purchased/total + 3 buy cards 199/499/999 → POST /api/payments/credits → Stripe; self-hides unless `balance.live`; the `?credits=success/cancelled` useEffect handler = toast + balance refetch + strip param). Mount it (gated `NEXT_PUBLIC_CREDITS_LIVE`) in `settings/page.tsx` between `ManageSubscriptionButton` and payment history (per p2's mount).
- [ ] **Step 4:** `npx tsc --noEmit` 0. Flag-off proof (NEXT_PUBLIC_CREDITS_LIVE off → section absent / `balance.live` false → hidden; settings byte-identical). Commit `feat(credits): balance route + buy-credits settings UI + return handlers (NEXT_PUBLIC_CREDITS_LIVE)`.

### Task 4: pricing/marketing credit-pack section (sonnet)
**Files:** Modify `src/app/(dashboard)/pricing/page.tsx`, `src/app/page.tsx`, `src/components/marketing/pricing-toggle.tsx`.

Port the credit-pack display from p2's `d3a53ff` BY HAND — **KEEP ours, ADD theirs:**
- [ ] **Step 1: `pricing-toggle.tsx`** — apply p2's patch as-is (new `minutesPerPlan?` prop + credit-pack display block; managed never touched this file).
- [ ] **Step 2: `pricing/page.tsx`** — ADD p2's `minutesPerPlan` + credit-pack section; PRESERVE our `minuteQuota` conditional (lines ~147/163) + the `Me` type field. Do NOT let p2's clip-copy win.
- [ ] **Step 3: `page.tsx`** — ADD p2's `minutesPerPlan` object + `<PricingToggle minutesPerPlan=…>` wiring; PRESERVE our `MANAGED` const + 3 framing conditionals + ฿599. (p2 reverts these — keep ours.)
- [ ] **Step 4:** gate credit-pack content on `NEXT_PUBLIC_CREDITS_LIVE`. `npx tsc --noEmit` 0. Flag-off proof. Commit `feat(credits): credit-pack section on pricing + marketing (preserve managed framing/฿599)`.

### Task 5: render precheck credit-aware — Blocker #2 (CORE — opus)
**Files:** Modify `src/app/api/videos/render/route.ts`.

**Why:** the precheck at `:309-310` hard-returns 403 when out of minutes, BEFORE the overflow reserve at `:423` — so overflow is unreachable in the normal case.

- [ ] **Step 1:** read the precheck block (~290-314) + the reserve block (~402-438). The minute-precheck early-return must NOT fire when overflow is possible. Simplest correct fix: when `useMinuteQuota && creditsLive`, SKIP the minute-precheck early-return entirely and let execution reach the reserve site at `:423` (`reserveMinutesOrCredits`), which already handles minutes-then-credits and returns `quotaExceededResponse(..., { canBuyCredits: creditsLive })` on true exhaustion. (The precheck is only a fail-fast; the reserve is the real gate.) Keep the clip-path precheck unchanged.
- [ ] **Step 2:** verify flag-off byte-identical: `CREDITS_LIVE` off → precheck behaves exactly as today (hard-wall, no canBuyCredits); `MINUTE_QUOTA` off → clip path untouched. `npx tsc --noEmit` 0; the 4 verify suites still green.
- [ ] **Step 3:** Commit `fix(credits): render precheck credit-aware so overflow is reachable (Blocker #2)`.

---

## Final review (after T5)
Opus whole-branch review of the P0 set: (1) credit EARN now functional end-to-end — grant on subscribe/renewal, NOT on trial, reset on downgrade; (2) overflow REACHABLE — precheck no longer blocks it when creditsLive; (3) buy→return loop works (balance UI + handlers + cancel_url); (4) money-safety (refundCredits 4-arg coherent across overflow + AI-image callers; no double-grant; trial-farm closed); (5) flag-off byte-identical across CREDITS_LIVE/NEXT_PUBLIC_CREDITS_LIVE. Then present to Mew + update the go-live checklist (P0 done; P1 next).

## Self-Review
- Covers all 4 P0 launch-blockers (grant T1/T2 · overflow-reachable T5 · credit UI T3 · return-loop T3/credits-route) + trial-design ข/ก (T2). ✓
- Port-not-merge avoids p2 reverting our work; refundCredits signature reconciled (T1) + caller fixed. ✓
- Flag-gated throughout; out-of-scope (P3.4 AI-image, P1 copy/visibility) explicitly deferred. ✓
