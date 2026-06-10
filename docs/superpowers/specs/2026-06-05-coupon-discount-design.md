# Design — Coupon DISCOUNT type (% off via Stripe promotion codes)

**Date:** 2026-06-05
**Owner:** Mew (Payment/pricing vertical)
**Status:** Approved (design), pending implementation plan
**Part of:** Campaign Phase 2 (extend Coupon GRANT → add DISCOUNT)

## Problem

The current `Coupon` system only does **GRANT**: redeeming a code instantly sets
`user.plan` for `durationDays` (free access — no payment). It cannot give a **discount on
a paid purchase**. The campaign needs discount codes — founding pricing (e.g. 50% off,
locked for life), public launch (e.g. 17% off), and course-group discounts — applied at
Stripe checkout. This adds a `DISCOUNT` coupon type that reduces the price via Stripe
promotion codes, without breaking the existing GRANT flow.

## Decisions (confirmed)

- Discount is **percent-only** (`percent_off`); no fixed-baht discounts (YAGNI).
- Discount **duration is admin-chosen per coupon**: `forever` (founding lifetime lock on
  renewals) or `once` (first payment only). Duration only affects card subscriptions; a
  one-time PromptPay payment is simply discounted once regardless.
- Code entry stays **in the app's CouponBox** (Approach A): the app validates the code and
  passes the linked Stripe promotion code to the checkout session via `discounts`.
  (Not Stripe's `allow_promotion_codes` page entry.)

## Architecture

Six parts. Stripe is the discount engine; the app is the source of truth for creation,
validation, and redemption tracking.

### A) Schema — `Coupon` model (additive)

```prisma
type                  String   @default("GRANT")  // GRANT | DISCOUNT
percentOff            Int?                          // 1–100, DISCOUNT only
discountDuration      String?                       // "once" | "forever", DISCOUNT only
stripeCouponId        String?                       // Stripe Coupon id (DISCOUNT)
stripePromotionCodeId String?                       // Stripe Promotion Code id (DISCOUNT)
```

Additive/nullable → safe `prisma db push`. `prisma/schema.prisma` is shared with wao1234
→ coordinate deploy. Existing rows default to `GRANT` (no behavior change).

### B) Admin create — `POST /api/admin/coupons` (extended)

- Accepts `type`, `percentOff`, `discountDuration` in addition to existing fields.
- Validation: if `type === "DISCOUNT"` → require `percentOff` 1–100 and
  `discountDuration ∈ {once, forever}`; `plan`/`durationDays` are ignored for DISCOUNT.
- Side effect for DISCOUNT (after `ensureStripeConfig()`):
  1. `stripe.coupons.create({ percent_off, duration, name })`
     (duration `forever` or `once`).
  2. `stripe.promotionCodes.create({ coupon, code, max_redemptions?, expires_at? })`
     (max_redemptions = `maxUses` when > 0; expires_at from `expiresAt`).
  3. Persist `stripeCouponId` + `stripePromotionCodeId` on the app `Coupon` row.
- If a Stripe step fails, do not create the app row (or roll it back) so the two stay in sync.
- GRANT creation path is unchanged.

### C) Validate — `POST /api/coupons/validate` (new, no side effects)

Given `{ code }`, returns coupon info **without granting or redeeming**:
- 404 if not found; 400 if expired, fully used (`usedCount >= maxUses`), or the current
  user already redeemed it (existing `CouponRedemption`).
- On success returns `{ type, plan, percentOff, discountDuration, durationDays }`.
- The pricing page uses this to preview a DISCOUNT before checkout. (GRANT codes still use
  the existing `/api/coupons/redeem` for instant grant.)

### D) CouponBox + pricing page

- `CouponBox` gains an optional prop `onDiscountApplied?: (c: ValidatedCoupon) => void`.
  - On submit: call `/api/coupons/validate`.
  - If `type === "GRANT"` → behave as today (POST `/api/coupons/redeem`, reload).
  - If `type === "DISCOUNT"` → call `onDiscountApplied(coupon)` (no grant). If the prop is
    absent (e.g. on settings), show a toast: "ใช้โค้ดส่วนลดนี้ที่หน้าราคา".
- Pricing page holds `appliedCoupon` state:
  - Shows a "ลด {percentOff}%" badge + the discounted price on each paid card
    (`price * (1 - percentOff/100)`), with the original price struck through.
  - `handleUpgrade` includes `couponCode: appliedCoupon?.code` in the checkout body.
  - A "ลบ" affordance clears `appliedCoupon`.

### E) Checkout — `POST /api/payments/checkout` (extended)

- Accepts optional `couponCode`.
- If present, look up the coupon; if `type === "DISCOUNT"`, valid (not expired/used, user
  hasn't redeemed), and has `stripePromotionCodeId` → add
  `discounts: [{ promotion_code: coupon.stripePromotionCodeId }]` to the session and put
  `couponId` in session `metadata`. Works for both `mode:"subscription"` and the
  PromptPay `mode:"payment"` one-time session.
- If the coupon is invalid, ignore the discount (session still created at full price) and
  do not fail the purchase.

### F) Webhook — `checkout.session.completed` (extended)

- If the completed session's `metadata.couponId` is set, in the same flow that activates
  the plan: create a `CouponRedemption` (couponId + userId) and increment `usedCount`
  (idempotent — guard on the `@@unique([couponId, userId])`). This enforces 1-per-user on
  the next attempt and tracks usage. Stripe's `max_redemptions` is the global backstop.

## Data flow

Admin creates DISCOUNT coupon → app creates Stripe Coupon + Promotion Code, stores ids.
User types code in pricing CouponBox → `/validate` → pricing shows discounted price →
`handleUpgrade` sends `couponCode` → checkout attaches `discounts:[{promotion_code}]` +
`metadata.couponId` → Stripe applies the % (and `duration` for subscriptions) → on
`checkout.session.completed`, webhook records the redemption.

## Error handling

| Case | Behavior |
|---|---|
| Validate: not found / expired / used-up / already-redeemed-by-user | 4xx with Thai message |
| Admin create: Stripe coupon/promo fails | do not persist app row (kept in sync); 500 |
| Checkout: couponCode invalid at purchase time | proceed at full price (no hard failure) |
| Webhook: redemption already recorded | unique-constraint guard → no double count |
| GRANT codes | unchanged behavior throughout |

## Out of scope (YAGNI)

- Fixed-baht (amount_off) discounts; coupon stacking (one code per checkout).
- Founding-100 atomic counter (separate Phase 2 task); claim/allowlist page.
- An admin UI page redesign — extend the existing admin coupon route/form fields only.

## Testing (local, Stripe test mode + chrome-devtools)

1. Admin-create a DISCOUNT coupon (50%, forever) → assert app row has
   `stripeCouponId` + `stripePromotionCodeId`, and the Stripe Promotion Code exists.
2. `/api/coupons/validate` returns `{type:"DISCOUNT", percentOff:50, ...}`; a GRANT code
   still returns GRANT.
3. Pricing page: enter the code → discounted price + "ลด 50%" badge shown.
4. Click upgrade with the code → checkout session has `total_details.amount_discount > 0`
   and the discount/promotion code attached (assert via Stripe API).
5. Complete the test payment → `CouponRedemption` created, `usedCount` incremented;
   re-validating the same code as the same user is now blocked (already redeemed).
6. Regression: a GRANT coupon still redeems instantly via `/api/coupons/redeem`.

## Deploy notes

- Additive schema → run `npx prisma db push` on the VPS (backup DB first), then
  `deploy/deploy.sh`. Coordinate with wao1234 (`schema.prisma` shared).
- No new env keys — uses the live Stripe client (SiteConfig). DISCOUNT coupons created in
  prod will create **live** Stripe Coupons/Promotion Codes.
