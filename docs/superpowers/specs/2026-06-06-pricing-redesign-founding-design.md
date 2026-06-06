# Spec — Pricing redesign × Founding-100 merge (in-app `/pricing`)

- **Date:** 2026-06-06
- **Owner:** Mew (Payment/pricing vertical)
- **Status:** Design approved — pending spec review

## Problem / context

- A richer "landing-page style" redesign of `/pricing` (~707 lines) was built in a prior session but left **uncommitted** on branch `mew/coupon-discount`. It is now backed up at `creator studio/pricing-redesign-707.tsx.bak`.
- Meanwhile `main` advanced: the live `/pricing` (438 lines) gained **Founding-100** (live seat counter + founding price) and the coupon flow.
- The redesign has the **coupon** flow but **no Founding-100**. Shipping it as-is would regress founding (the sticky "Founding Offer" bar there is static text only).
- **Goal:** ship the redesign as the in-app `/pricing` **with** Founding-100 fully working.

**Scope confirmed:** the redesign is the in-app (logged-in) `/pricing` only. The public sale/landing page is a **separate** spec.

## Approach (chosen: "redesign-as-base + graft founding")

Use the 707-line redesign as the page foundation; port the ~4 Founding-100 integration points from main's pricing page into it. Lowest total effort — founding logic is small and well-isolated. (Rejected: main-as-base + rebuild redesign sections = more work; git 3-way merge = heavy overlapping rewrites → conflict mess.)

## Design

### Branch & files
- Branch `mew/pricing-redesign` off latest `origin/main` (has founding + coupon + trial).
- Replace `src/app/(dashboard)/pricing/page.tsx` (redesign body + founding grafts).
- New `src/lib/pricing-display.ts` — pure price-calc helper (testable + shared).
- New `scripts/verify-pricing-display.ts` — `tsx` verification of the helper.
- **No** changes to founding API / checkout / webhook / Prisma schema — already live on `main`. This page only *displays* status.

### Founding integration points (ported from main)
1. **State:** `founding: { active: boolean; remaining: number; total: number; percentOff: number } | null` (null = unknown/failed).
2. **Fetch:** add `fetch("/api/founding/status")` to the existing `useEffect` (alongside `/api/plans`, `/api/user/me`), with `.catch(() => {})` → graceful null.
3. **Price rule** (extracted to pure helper `computeDisplayPrice`):
   - `base = annual ? monthly * 10 : monthly`
   - `foundingPct = (!coupon && founding.active && annual) ? founding.percentOff : 0`
   - `pct = coupon?.percentOff ?? foundingPct`
   - `isFounding = !coupon && foundingPct > 0`
   - `final = pct > 0 ? round(base * (1 - pct / 100)) : base`
   - returns `{ base, final, pct, isFounding }`
   - **Rule:** manual coupon always wins; founding applies on **annual only**; founding is "ตลอดชีพ". (Mirrors main exactly.)
4. **Plan-card price badge:** `isFounding` → amber "Founding · ลด X% ตลอดชีพ"; else emerald "ลด X%". Show strike-through base + badge only when `pct > 0`.

### Founding surface — sticky top bar (decided)
The redesign's sticky top bar becomes **dynamic**:
- When `founding.active && !appliedCoupon`: show
  `🔥 ราคา Founding ลด {percentOff}% ล็อกตลอดชีพ — เหลือ {remaining}/{total} ที่นั่ง` + "ดูราคา" CTA (`#pricing` anchor).
- Else (sold out / inactive / coupon applied / status null): fall back to the current generic text ("รายปีมีทั้งแบบบัตรต่ออัตโนมัติ และ PromptPay จ่ายครั้งเดียว").
- **No separate inline founding banner** — the sticky bar carries seat urgency; avoids duplication.
- The founding message names "รายปี" so it reads correctly regardless of the period toggle and nudges users toward annual (where founding price applies).

### Must-not-regress (carried from redesign + main)
- Coupon: `CouponBox`, applied-coupon display + remove.
- Period toggle (monthly / annual); selecting monthly resets `method = "card"`.
- Payment-method toggle (card / PromptPay), annual-only.
- Payment-result banners (success / cancelled) from `?payment=`.
- Current-plan detection, "Active" state, FREE / Pro / Business CTA states.
- Checkout POST body unchanged: `{ plan, period, method, couponCode }`.

### Data flow
On mount: `/api/plans`, `/api/user/me`, `/api/founding/status`. Display only — founding seat claiming happens server-side in checkout (already implemented on main). No new endpoints, no checkout changes.

### Edge cases
- `/api/founding/status` fails → `founding` stays null → no founding UI anywhere; page still works.
- Sold out (`active:false` or `remaining:0`) → generic sticky bar, normal price, no badge.
- Coupon applied → coupon wins everywhere (no founding price / badge / founding bar text).
- Monthly period → no founding price (annual-only rule).

## Verification (team pattern — no test runner; `tsx` + build)
- `src/lib/pricing-display.ts` is pure → `scripts/verify-pricing-display.ts` asserts: none / coupon-only / founding-annual / coupon-beats-founding / founding-on-monthly (= none) / sold-out.
- `npx tsc --noEmit` + `npm run build`.
- Local E2E (`npx next dev -p 3005`, Stripe test mode): period & method toggles; coupon apply/remove; founding seats in sticky bar; founding price + amber badge on annual cards; checkout redirect.

## Out of scope (YAGNI)
- Public sale/landing page (separate spec).
- Founding API / checkout / webhook / schema changes.
- Refactoring redesign colors to the app's design tokens (keep the intentional landing-page look).
- Any other dashboard page.

## Risks
- Mis-replicating the founding price rule → mitigated by the pure, unit-verified helper mirroring main's logic.
- Redesign visual style differs from the app design system → accepted (intentional for `/pricing`).
