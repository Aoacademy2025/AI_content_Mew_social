# Pricing Rework — P3.5: Credit earn-paths + surfacing (go-live-ready, FLAG-OFF)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.
> Branch: continue on `mew/pricing-rework-p2`. **Overnight build (Mew mandate 2026-06-25): finish the system, DO NOT go to production** — no push / no merge / no deploy / no flag-flip / no VPS. All new behavior behind flags default-OFF; flag-off must be byte-identical.

**Goal:** Make the credit system functionally complete and *ready to flip live* (without flipping). Builds on P3.4 (spend on AI-image, done). Adds the EARN paths (monthly grant + buy packs) and surfaces balance/packs. Nothing is user-visible or chargeable until Mew sets the flags + un-gates AI-image + deploys.

## Flags
- `CREDITS_LIVE` (server, `process.env.CREDITS_LIVE === "1"`) — from P3.4. Gates all server credit behavior.
- `NEXT_PUBLIC_CREDITS_LIVE` (client, NEW, default off) — gates UI visibility of credit features. (Next bakes this at build → flipping it requires a rebuild, which is part of go-live.)

## Global Constraints
- **Additive only. Everything behind a flag; flag-off byte-identical.** No prod, no push.
- 1 credit = ฿1. Monthly grant: FREE 0 · PRO 50 · BUSINESS 150 (`MONTHLY_GRANT` in credits.ts). Packs: starter ฿199→200cr · popular ฿499→540cr · pro ฿999→1150cr (`CREDIT_PACKS`).
- Reuse existing primitives — `src/lib/credits.ts` (`grantCredits`/`resetMonthlyGranted`/`getBalance`/`CREDIT_PACKS`/`creditPack`), `/api/payments/credits` (exists, P3.2), webhook credit-grant branch (exists, P3.2). Do NOT duplicate.
- **No new PM2 cron / no new deploy action:** tie monthly granted reset to the EXISTING 30-day usage window (lazy reset on activity), NOT a calendar cron.
- Tests: `scripts/verify-*.ts` via `npx tsx` (throwaway SQLite). UI tasks: `tsc --noEmit` clean + follow the existing design system (single-accent violet `#8b5cf6`, Bai Jamjuree headings, shadcn/ui); **visual QA is Mew's** (note it, don't block).
- Thai user-facing copy. Don't re-hardcode tier features (DB-driven `plan-config.ts`).
- If an implementer hits a minor ambiguity, pick the safest default and note it — do NOT block overnight. Only escalate genuine blockers (park the task, continue others, report in the morning summary).

---

### Task 1: Grant credits — on-subscribe + lazy monthly reset (P3.3), flag-gated, NO new cron

**Files:** modify `src/lib/credits.ts` (add `ensureMonthlyGrant`); hook initial grant into the subscription-activation path (`payments/webhook` plan-activation and/or `src/lib/entitlements.ts syncUserEntitlement`); Test `scripts/verify-credit-grant.ts`.

**Mechanism (lazy, reliable, no cron):**
- `ensureMonthlyGrant(userId): Promise<void>` in credits.ts: read the user's `plan` + `CreditBalance.grantedResetAt`. If `CREDITS_LIVE` AND plan ∈ {PRO,BUSINESS} AND (`grantedResetAt` is null OR older than `USAGE_PERIOD_DAYS` (30) ago) → `resetMonthlyGranted(userId, plan)` (sets granted := allowance, stamps grantedResetAt). Else no-op. FREE → no-op (allowance 0). Flag-off → no-op.
- Call `ensureMonthlyGrant(userId)` at: (a) the credit-balance read (Task 2's GET route) and (b) the AI-image spend path in fetch-stock BEFORE `spendCredits` (so a returning PRO/BIZ user's monthly credits are topped up before they spend) — both already CREDITS_LIVE-gated.
- Initial grant: in the plan-activation path (when a user becomes PRO/BIZ via webhook/entitlement sync), call `ensureMonthlyGrant(userId)` (gated CREDITS_LIVE) so they get their allowance immediately on subscribe/trial-PRO. Idempotent via the grantedResetAt window guard.

- [ ] **Step 1:** write `scripts/verify-credit-grant.ts` asserting: PRO user, no balance row → `ensureMonthlyGrant` → granted 50, grantedResetAt set; BUSINESS → 150; FREE → 0 (no-op); calling twice within the window → still 50 (no double-grant, leftover not stacked); simulate window expiry (grantedResetAt = 31 days ago, granted spent down to 10) → `ensureMonthlyGrant` → granted back to 50 (use-it-or-lose-it: the 10 is overwritten, not added); with CREDITS_LIVE unset → no-op (granted unchanged). Run → fail.
- [ ] **Step 2:** implement `ensureMonthlyGrant` in credits.ts. Reuse `resetMonthlyGranted`; read plan from `prisma.user`; reuse `USAGE_PERIOD_DAYS` from usage-limits. Run → pass; `tsc` 0.
- [ ] **Step 3:** wire the initial-grant call into the subscription-activation path (find where plan is set to PRO/BUSINESS on payment + where the 7-day PRO trial is granted in clerk-auth lazy-create) — call `ensureMonthlyGrant(userId)` there, CREDITS_LIVE-gated, fire-and-forget `.catch(()=>{})`. Confirm flag-off = no behavior change. Commit `feat(credits): monthly grant on-subscribe + lazy 30-day reset (CREDITS_LIVE)`.

---

### Task 2: Buy-credits UI + balance (Settings → billing tab), flag-gated

**Files:** new `src/app/api/credits/balance/route.ts` (GET); harden `src/app/api/payments/credits/route.ts` (403 when `!CREDITS_LIVE`); settings billing UI + a small client island for the pack buttons.

- [ ] **Step 1:** `GET /api/credits/balance` — auth via `getCurrentUser`; call `ensureMonthlyGrant(user.id)` then return `getBalance(user.id)` (`{granted,purchased,total}`); when `!CREDITS_LIVE` return `{granted:0,purchased:0,total:0, live:false}` (so UI can hide). Wrap in try/catch → apiError.
- [ ] **Step 2:** harden `payments/credits/route.ts`: at the top, if `process.env.CREDITS_LIVE !== "1"` → 403 `{code:"CREDITS_NOT_LIVE"}` (defense; UI is hidden anyway).
- [ ] **Step 3:** Settings billing tab — add a **Credits** section, only rendered when `process.env.NEXT_PUBLIC_CREDITS_LIVE === "1"`:
  - Balance card: granted / purchased / total (Thai labels, e.g. "เครดิตแถมเดือนนี้ / เครดิตที่ซื้อ / รวม"), fetched from the balance route.
  - 3 pack cards (Starter ฿199 → 200, Popular ฿499 → 540 +8%, Pro ฿999 → 1,150 +15%) → on click `POST /api/payments/credits {pack}` → `window.location = url`.
  - On mount, if `?credits=success` in the URL → success toast + refetch balance; if `?credits=cancelled` → subtle info.
  - Follow existing settings/billing component patterns + design system.
- [ ] **Step 4:** `tsc --noEmit` 0. Confirm: with `NEXT_PUBLIC_CREDITS_LIVE` unset the section does not render, and `/api/payments/credits` 403s with `CREDITS_LIVE` unset (state both). Note visual QA pending for Mew. Commit `feat(credits): buy-credits UI + balance in settings billing (NEXT_PUBLIC_CREDITS_LIVE)`.

---

### Task 3: Pricing surfacing — minutes + credit packs, flag-gated

**Files:** `/pricing` page + `src/components/marketing/pricing-toggle.tsx` (+ `plan-config` display); no new limits (minutes already single-source in `plan-limits`).

- [ ] **Step 1:** surface **minutes/plan** on both pricing surfaces using the existing display rule ("~X clips @ ~1 min", monthly price no annual total). Pull from the same source the usage API uses; do not re-hardcode.
- [ ] **Step 2:** add a **credit-packs** section (Starter/Popular/Pro with pay→get + bonus %), rendered only when `NEXT_PUBLIC_CREDITS_LIVE === "1"`. On `/pricing` (lean convert page) keep it compact; on the marketing page it may be fuller. Keep Founder pricing/grandfather display untouched.
- [ ] **Step 3:** `tsc --noEmit` 0; flag-off = packs section absent, pricing unchanged. Note visual QA pending. Commit `feat(pricing): surface minutes + credit packs on pricing surfaces (flag-gated)`.

---

### Final whole-branch review (opus) + full verification
- Run all credit suites (`verify-credits`, `verify-credit-packs`, `verify-credit-spend`, `verify-credit-grant`) + `tsc --noEmit`. Final opus review of the P3.5 range. Fix Critical/Important. Then **STOP** — do not push/merge/deploy. Write the morning summary + **go-live checklist** (env vars to set, AI-image un-gate decision, deploy order p1→p2).

### Out of scope (Mew's deferred decisions — DO NOT build overnight)
- Overflow-minutes via credits (P3.4 Task 3) · Seedance AI-video · un-gating AI-image from admin-only · reactivation email (outreach) · `allowVideoEditor` FREE security gate (escalated, separate).
