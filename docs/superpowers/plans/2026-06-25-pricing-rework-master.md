# Pricing & Business-Model Rework — Implementation Plan (Master)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Move HERO from BYOK-Gemini (10% activation, blocked by prepaid wall) to **managed server-Gemini + minutes-metered subscriptions + unified credits for AI-gen**, so new users generate on day 1 and the 66% retention engine fires.

**Architecture:** Server holds ONE Gemini key; pipeline resolves managed-vs-BYOK centrally. Subscription quota is metered in **minutes** (= the true cost unit). A unified **credit** balance pays for overflow minutes + AI-gen images/video (kie.ai). Every phase is flag-gated with the legacy path intact (same gate discipline as `RENDER_VIA_QUEUE` / `NEXT_PUBLIC_BROLL_WINDOW_MODE`).

**Tech Stack:** Next.js 15, Prisma 6 + SQLite (additive `db push` only), Clerk auth, Stripe, Remotion render-worker, Gemini `@google/genai`, kie.ai REST.

**Spec:** [`docs/pricing-business-model-2026-06-24.md`](../../pricing-business-model-2026-06-24.md) — all numbers/decisions locked there.

## Global Constraints

- **Additive schema only** — new columns/tables, never drop/rename; `prisma db push` must stay non-destructive (prod data safe). Back up `prisma/dev.db` before each push.
- **Flag-gated, legacy intact** — each phase behind a flag; OFF = today's behaviour byte-for-byte. Flags: `MANAGED_GEMINI`, `NEXT_PUBLIC_PRICING_V2`, `CREDITS_V1`.
- **Server Gemini key in env** (`GEMINI_SERVER_KEY`), never committed; BYOK (`user.geminiKey`) stays as the resolver fallback.
- **Test pattern (team convention):** `scripts/verify-*.ts` run logic against a throwaway SQLite via `tsx` (see existing `scripts/verify-*.ts`). No new test framework.
- **Money:** Stripe amounts in satang; credits **1 credit = ฿1**; FX **35 ฿/$**.
- **Copy:** user-facing strings in Thai.
- **Cost anchors (verified):** Gemini 2.5 Flash TTS $0.015/min (25 audio-tok/sec, $10/1M) → ~฿0.7/min all-in. kie: gpt-image-2 1K $0.03, Nano Banana 2 1K $0.04, Seedance 1.5pro 720p-noaudio $0.0175/s. **[verify before launch: Gemini TTS preview pricing, Hostinger KVM8, FX].**
- **Do not touch** subtitle-timing / render invariants (`tts-timing.ts`, `keyword-popups.ts`, window-mode).

---

## Phase Roadmap (build in order; each ships value alone)

| Phase | Subsystem | Ships | Flag | Own plan |
|---|---|---|---|---|
| **P1** | **Server Gemini key + minute-metering** | **Day-1 activation unlock** — managed gen, no key needed | `MANAGED_GEMINI` | *this doc, full* |
| P2 | Plan structure (minutes) + Free/Trial + watermark | New quotas, 3-5 free watermarked, capped reverse-trial | `NEXT_PUBLIC_PRICING_V2` | expand |
| P3 | Credit system (currency, ledger, AI-gen gating, packs) | Buy/spend credits on overflow + AI image/video | `CREDITS_V1` | expand |
| P4 | Pricing surfaces + checkout | /pricing + sale page minutes display, credit-pack checkout, Founder grandfather | — | expand |
| P5 | Relaunch + reactivation | Reactivation email to dormant cohort, Founder-100 urgency | — | expand |
| P6 | Growth: Referral → Affiliate → Agency tier | 3 growth layers | — | expand (3 sub-plans) |

**Why P1 first:** it alone flips the 96 stuck-on-key + all Free users to "can generate now" → activation jumps before any pricing change. Smallest, highest-leverage, independently shippable.

---

# PHASE 1 — Server Gemini key + minute-metering  (`MANAGED_GEMINI`)

**Outcome:** With the flag ON, a user with NO Gemini key generates using the server key, metered in minutes against their plan; BYOK users (or whales) still use their own key. Flag OFF = today's BYOK-only behaviour.

## File Structure (P1)

- Create `src/lib/gemini-key.ts` — `resolveGeminiKey(user)` central resolver (managed vs BYOK).
- Modify `prisma/schema.prisma` — add `User.minutesUsed`, `User.minutesLimit`, `User.geminiKeyMode`.
- Create `src/lib/minute-limits.ts` — `reserveMinutes` / `refundMinutes` / `checkMinuteQuota` (atomic, mirrors `usage-limits.ts`).
- Modify Gemini call sites (content/keywords/TTS routes) — pass `resolveGeminiKey(user)` instead of raw `user.geminiKey`.
- Modify pipeline TTS step — after audio duration known, `reserveMinutes(userId, ceil(durationSec/60))`.
- Create `scripts/verify-gemini-key.ts`, `scripts/verify-minute-meter.ts`.
- Env: add `GEMINI_SERVER_KEY` (prod `.env`, gitignored).

---

### Task 1: Central Gemini-key resolver

**Files:**
- Create: `src/lib/gemini-key.ts`
- Test: `scripts/verify-gemini-key.ts`

**Interfaces:**
- Produces: `resolveGeminiKey(user: { geminiKey: string | null; plan: string }): { key: string; mode: "managed" | "byok" }` — returns BYOK when the user has a key (whale/override); else the server key when `MANAGED_GEMINI` is on and `GEMINI_SERVER_KEY` is set; throws a typed `KEY_REQUIRED` error otherwise.

- [ ] **Step 1: Write the failing test** (`scripts/verify-gemini-key.ts`)

```ts
import assert from "node:assert";
import { resolveGeminiKey } from "../src/lib/gemini-key";

process.env.MANAGED_GEMINI = "1";
process.env.GEMINI_SERVER_KEY = "srv-key";

// BYOK wins when user has their own key (whale/override)
assert.deepEqual(resolveGeminiKey({ geminiKey: "user-key", plan: "PRO" }), { key: "user-key", mode: "byok" });
// managed when no user key + flag on
assert.deepEqual(resolveGeminiKey({ geminiKey: null, plan: "PRO" }), { key: "srv-key", mode: "managed" });
// flag off + no key → KEY_REQUIRED
process.env.MANAGED_GEMINI = "0";
assert.throws(() => resolveGeminiKey({ geminiKey: null, plan: "PRO" }), /KEY_REQUIRED/);
console.log("ok gemini-key");
```

- [ ] **Step 2: Run, verify it fails** — `npx tsx scripts/verify-gemini-key.ts` → FAIL (module not found)

- [ ] **Step 3: Implement** (`src/lib/gemini-key.ts`)

```ts
export class KeyRequiredError extends Error {
  constructor(public provider = "gemini") { super("KEY_REQUIRED:" + provider); }
}
export function resolveGeminiKey(user: { geminiKey: string | null; plan: string }): { key: string; mode: "managed" | "byok" } {
  if (user.geminiKey && user.geminiKey.trim()) return { key: user.geminiKey.trim(), mode: "byok" };
  const managed = process.env.MANAGED_GEMINI === "1";
  const serverKey = process.env.GEMINI_SERVER_KEY ?? "";
  if (managed && serverKey) return { key: serverKey, mode: "managed" };
  throw new KeyRequiredError("gemini");
}
```

- [ ] **Step 4: Run, verify it passes** — `npx tsx scripts/verify-gemini-key.ts` → `ok gemini-key`
- [ ] **Step 5: Commit** — `git add src/lib/gemini-key.ts scripts/verify-gemini-key.ts && git commit -m "feat(gemini): central managed/BYOK key resolver behind MANAGED_GEMINI flag"`

---

### Task 2: Minute meter (schema + atomic reserve/refund)

**Files:**
- Modify: `prisma/schema.prisma` (User model — add fields)
- Create: `src/lib/minute-limits.ts`
- Test: `scripts/verify-minute-meter.ts`

**Interfaces:**
- Consumes: existing `User.usagePeriodStartedAt` window (reuse the 30-day window from `usage-limits.ts`).
- Produces: `reserveMinutes(userId, minutes): Promise<{ allowed: boolean; remaining: number; message?: string }>`, `refundMinutes(userId, minutes)`, `checkMinuteQuota(userId): Promise<{ allowed: boolean; remaining: number }>`, `minutesLimitForPlan(plan): number` (FREE→derived from 3-5 clips, PRO 80, BUSINESS 150).

- [ ] **Step 1:** Add to `prisma/schema.prisma` `User`:
```prisma
  minutesUsed   Int @default(0)
  minutesLimit  Int @default(0)
  geminiKeyMode String @default("byok") // byok | managed
```
- [ ] **Step 2:** `npm run db:migrate` locally (additive). Verify `npx prisma validate` passes.
- [ ] **Step 3: Write failing test** (`scripts/verify-minute-meter.ts`) — seed a throwaway user (PRO, minutesLimit 80, minutesUsed 78), assert `reserveMinutes(id, 1)` → allowed remaining 1; second `reserveMinutes(id, 2)` → `allowed:false` (would exceed 80); `refundMinutes(id,1)` restores. (Mirror the atomic `updateMany` conditional-where pattern from `usage-limits.ts:92`.)
- [ ] **Step 4:** Implement `src/lib/minute-limits.ts` — copy the atomic pattern from `reserveClipUsage` (`usage-limits.ts`) but increment `minutesUsed` by N with `where: { minutesUsed: { lte: minutesLimit - N } }`; reset on window expiry via the same `usagePeriodStartedAt`. `minutesLimitForPlan`: `{ FREE: 5, PRO: 80, BUSINESS: 150 }[plan] ?? 5`. **[open: FREE = 3 or 5].**
- [ ] **Step 5:** Run → pass. Commit `feat(billing): minute meter (reserve/refund/check) mirroring clip-usage atomicity`.

---

### Task 3: Wire pipeline to resolver + meter

**Files:**
- Modify: Gemini call sites — content/keyword/TTS routes under `src/app/api/videos/*` (replace `user.geminiKey` arg with `resolveGeminiKey(user).key`).
- Modify: TTS step (where audio duration becomes known) — call `reserveMinutes(userId, Math.ceil(durationSec/60))`; on `allowed:false` abort with the Thai quota message; persist `geminiKeyMode` from the resolver.
- Test: extend `scripts/verify-minute-meter.ts` with an over-quota path returning the Thai message.

**Interfaces:**
- Consumes: `resolveGeminiKey` (Task 1), `reserveMinutes` (Task 2).

- [ ] **Step 1:** Pre-check: at pipeline entry call `checkMinuteQuota(userId)`; if `!allowed` return `409 { code:"QUOTA_MINUTES", message }` (fail-fast before heavy work — same shape as the existing `checkClipQuota` precheck).
- [ ] **Step 2:** Replace each `geminiGenerateText(user.geminiKey, …)` / TTS-key read with `resolveGeminiKey(user)`; catch `KeyRequiredError` → `409 { code:"KEY_REQUIRED", action:"/settings?tab=api-keys" }`.
- [ ] **Step 3:** After TTS produces audio, `reserveMinutes(userId, ceil(sec/60))`; if `!allowed` → stop + Thai message + `refundMinutes` any partial. (Overflow-via-credits comes in P3; P1 simply blocks at the cap.)
- [ ] **Step 4:** `npm run build` (tsc 0-error) + run both verify scripts.
- [ ] **Step 5:** Commit `feat(pipeline): use managed/BYOK resolver + reserve minutes per render`.

---

### Task 4: Telemetry + flag rollout

- [ ] **Step 1:** Emit `recordTelemetryEvent` `gemini_key_mode {mode, plan}` and `minute_reserve {minutes, remaining, plan}` (category `product`) so `/admin/insights` shows managed adoption + minute burn (reuse `recordTelemetryEvent`).
- [ ] **Step 2:** Add `GEMINI_SERVER_KEY` to prod `.env` (gitignored) — a HERO-owned Gemini key with **prepaid billing enabled** (it carries all managed users; see [[gemini-prepaid-byok-2026]]). Keep `MANAGED_GEMINI=0` until verified.
- [ ] **Step 3:** Verify-on-prod (flag OFF first): build green, BYOK path unchanged. Then flip `MANAGED_GEMINI=1` off-peak, generate 1 video with a no-key test account → confirms managed gen + minute increment in DB. Rollback = `MANAGED_GEMINI=0`.
- [ ] **Step 4:** Commit `feat(insights): managed-key + minute telemetry; ops note for GEMINI_SERVER_KEY`.

**Phase 1 acceptance:** no-key account generates a video (managed); `minutesUsed` increments; hitting `minutesLimit` blocks with Thai message; BYOK account still uses its own key; flag OFF restores BYOK-only.

---

# PHASES 2–6 (task-level outline — expand each into its own plan when picked up)

### P2 — Plan structure + Free/Trial + watermark (`NEXT_PUBLIC_PRICING_V2`)
- `minutesLimitForPlan` already added (Task 2) → set PRO 80 / BIZ 150 / FREE 3-5-clips-equiv; display "~X clips @1min" in editor + plan UI; keep per-clip max-length (`durationCapSecFor` in `plan-limits.ts`).
- **Watermark on Free render:** add overlay in the Remotion composition when `plan==="FREE"` (gate in render config); verify subtitle/b-roll invariants untouched.
- **Trial = capped reverse-trial:** extend `trial.ts` — on signup grant 7-day PRO + `trialClipCap` (~10-15); on cap/expiry auto-downgrade to FREE (cron `trial-expiry` already exists). No card.
- Verify: `scripts/verify-trial-cap.ts`, `scripts/verify-watermark-gate.ts`.

### P3 — Credit system (`CREDITS_V1`)
- Schema (additive): `CreditBalance { userId, granted Int, purchased Int }` + `CreditLedger { userId, delta, kind, action, createdAt }`. Granted = reset monthly (PRO 50 / BIZ 150); purchased = rollover (12-mo expiry).
- `src/lib/credits.ts`: `spendCredits(userId, amount, action)` (granted-first then purchased, atomic), `grantMonthlyCredits` (cron, on renewal/reset), `creditCostFor(action)` table — minute=2, gpt-image-2-1k=3, nanobanana-1k=4, seedance-5s=10.
- **Overflow minutes via credits:** in pipeline (P1 Task 3), when `reserveMinutes` would exceed cap, offer `spendCredits(2/min)` instead of blocking.
- **AI-gen gating:** kie image/video calls require `spendCredits` first; add gpt-image-2 + Seedance providers to the kie client; refund on gen failure.
- Stripe credit-pack products (฿199/499/999) + checkout + webhook → `purchased += credits`.
- Verify: `scripts/verify-credits.ts` (granted-first, rollover, reset, refund-on-fail).

### P4 — Pricing surfaces + checkout
- `/pricing` + sale page: minutes display, credit-pack cards, "included credits" per tier (reuse `plan-config.ts` DB-driven tiers — do NOT re-hardcode).
- Checkout: add credit-pack mode to `payments/checkout/route.ts` (one-time, no recurring); honor existing Founder coupon.
- **Founder grandfather:** the 1 paying Founder untouched — gate by `userId`/coupon redemption so V2 limits don't apply to them.

### P5 — Relaunch + reactivation
- Reactivation email (Resend, already wired) to users with 0 completed videos → "works now, no key, fresh 7-day trial" + re-grant trial. Batch cron, throttled.
- Founder-100 seats counter surfaced on /pricing for urgency (reuse `founding.ts`).

### P6 — Growth (3 sub-plans)
- **Referral:** `Referral { inviterId, inviteeId, rewardedAt }`; on invitee first paid/activated → `spendCredits`-grant both. Invite link + watermark CTA.
- **Affiliate:** affiliate code on signup → recurring % via Stripe; payout ledger.
- **Agency/Team tier:** `Team { ownerId, seats }` + shared credit pool + member roles; new Stripe price ฿2,990+/mo.

---

## Self-Review

- **Spec coverage:** Q1 core/credit boundary→P1+P3; Q2 managed+BYOK→P1 Task1; Q3 voice (server TTS)→P1 Task3 (clone=ElevenLabs BYOK unchanged); Q4 free/trial→P2; Q5 minutes-meter→P1 Task2+P2; Q6 prices→P4; Q7 unified credit→P3; Q8 credit pricing→P3 `creditCostFor`; Q9 Founder grandfather+reactivation→P4/P5; Q10 growth→P6. ✓ all mapped.
- **Open items carried:** FREE 3-vs-5 (P2 Task), card-trial lever, annual-discount level, premium-voice upsell — left as `[open]` in spec §8, not blocking P1.
- **Type consistency:** `resolveGeminiKey`→`{key,mode}`, `reserveMinutes`→`{allowed,remaining,message?}` used identically in P1 Tasks 1-3. ✓
- **Verify before launch:** Gemini TTS preview pricing, Hostinger KVM8, FX (spec §8) — gate the GEMINI_SERVER_KEY ops step.
