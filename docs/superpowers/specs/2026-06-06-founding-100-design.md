# Design — Founding-100 (atomic, race-safe founding-price counter)

**Date:** 2026-06-06
**Owner:** Mew (Payment/pricing vertical)
**Status:** Approved (design), pending implementation plan
**Part of:** Campaign Phase 2 (next after Coupon DISCOUNT)

## Problem

The launch needs a **founding offer**: the first **100 annual upgraders** (PRO or BUSINESS)
get a **founding price locked for life** — then it's gone. This must be **race-safe**: the
discount is locked the moment a Stripe Checkout session is created (Stripe applies the
promotion code at session creation; it cannot be revoked after), so two concurrent
checkouts at slot 100 must never both receive the founding price. The current DISCOUNT
coupon flow increments `usedCount` in the webhook **after** payment and reads
`usedCount < maxUses` non-atomically at checkout — both are racy and unsuitable for a hard
100-seat cap. This adds an **atomic seat reservation** on top of the existing DISCOUNT
machinery.

## Decisions (confirmed)

- **Auto-applied**, no code. The pricing page shows the founding price + a live seat counter
  to anyone on an **annual** plan while seats remain. (Monthly is excluded.)
- **Reserve-at-checkout + release-if-unpaid.** A seat is claimed atomically when the Stripe
  session is created, and released if the session expires / payment fails. Guarantees the
  founding price is handed to **at most 100** purchases.
- **100 total**, shared across PRO + BUSINESS (one pool of founding members).
- Reuse the existing **DISCOUNT coupon** mechanism (Stripe coupon + promotion code,
  `discountDuration: "forever"`) as the discount engine. The founding offer is one
  designated coupon; this feature adds only the atomic counter + reservation lifecycle + the
  auto-apply UI.

## Architecture

Seven parts. The designated coupon **is** the single source of truth for the offer (code,
percent, forever-duration, Stripe promo id, cap, **and live counter**). A
`FoundingReservation` row per checkout session tracks the per-seat lifecycle so seats can be
released or confirmed.

### A) The founding coupon (no new admin UI)

- A normal DISCOUNT coupon created via the existing `POST /api/admin/coupons`, identified by
  a **sentinel code** `FOUNDING100`: `type:"DISCOUNT"`, `discountDuration:"forever"`,
  `percentOff` admin-chosen (e.g. 50), `maxUses:100`. Creation already provisions a Stripe
  Coupon + Promotion Code (with `max_redemptions:100` as a backstop) and stores
  `stripeCouponId` + `stripePromotionCodeId`.
- For **this coupon only**, `usedCount` means **seats held = reserved + confirmed**, and
  `maxUses` is the cap. The admin coupon list then shows live `usedCount/maxUses` = "X/100"
  for free.
- The sentinel code is **looked up by the system**, never entered by a user:
  `/api/coupons/validate` and `/api/coupons/redeem` reject it with a Thai message
  ("โค้ดนี้ใช้อัตโนมัติที่หน้าราคา — ไม่ต้องกรอก") so it can't be redeemed as a manual code.

### B) Schema — `FoundingReservation` (additive, new model)

```prisma
model FoundingReservation {
  id              String    @id @default(cuid())
  userId          String
  stripeSessionId String    @unique
  status          String    @default("RESERVED") // RESERVED | CONFIRMED | RELEASED
  createdAt       DateTime  @default(now())
  confirmedAt     DateTime?
  releasedAt      DateTime?

  @@index([userId])
}
```

New model only — does **not** touch `User` (stores `userId` as a plain string) to minimize
churn in the shared `prisma/schema.prisma`. Additive → safe `npx prisma db push`. Coordinate
deploy with wao1234.

### C) `src/lib/founding.ts` (new — all founding logic in one place)

- `getFoundingCoupon()` → loads the `FOUNDING100` coupon (or null). Returns id, percentOff,
  stripePromotionCodeId, usedCount, maxUses. Caches nothing security-sensitive.
- `foundingStatus()` → `{ active, remaining, total, percentOff }` where
  `remaining = max(0, maxUses - usedCount)`, `active = coupon exists && remaining > 0`.
  Runs `releaseStaleReservations()` first so the public counter self-heals.
- `claimSeat(userId)` → atomic claim. Returns `{ stripePromotionCodeId, couponId } | null`:
  1. Release this user's own stale `RESERVED` rows (mirrors checkout's PENDING→FAILED), so a
     prior abandoned attempt doesn't block them.
  2. If the user already has a `CONFIRMED` reservation → return `null` (already a founding
     member; no second seat).
  3. Atomic compare-and-increment:
     ```ts
     const claim = await prisma.coupon.updateMany({
       where: { id: foundingId, usedCount: { lt: maxUses } },
       data:  { usedCount: { increment: 1 } },
     });
     ```
     `claim.count === 1` → seat won; `=== 0` → sold out → return `null`.
- `attachReservation(userId, stripeSessionId)` → creates `FoundingReservation(RESERVED)`
  after the Stripe session exists. (Called by checkout once the session id is known.)
- `releaseSeat(stripeSessionId)` → if a `RESERVED` row exists: in one `$transaction`, set it
  `RELEASED` + `coupon.usedCount { decrement: 1 }`. Status guard makes it idempotent (a
  second call matches nothing → no double-decrement, never goes below 0).
- `confirmSeat(stripeSessionId)` → if a `RESERVED` row exists: set it `CONFIRMED`. Does **not**
  touch `usedCount` (already counted at reservation).
- `releaseStaleReservations()` → backstop for a missed `expired` webhook: set `RELEASED` on
  `RESERVED` rows older than ~35 min and decrement `usedCount` by the number released
  (`updateMany` count → single decrement). Concurrency-safe: the `status:RESERVED` filter
  means a second sweep matches 0.

### D) Checkout — `POST /api/payments/checkout` (extended)

After the existing optional manual-coupon resolution, before creating the session:

- **Manual coupon wins:** if a valid manual `couponCode` discount was resolved, do **not**
  apply founding (no stacking).
- Else if `period === "annual"` (card annual **or** PromptPay annual one-time) and
  `foundingStatus().active` → `claimSeat(userId)`:
  - On a seat: add `discounts: [{ promotion_code }]`, set `metadata.couponId` +
    `metadata.founding = "1"`, and set `expires_at = now + 30*60` on the session (all modes,
    to bound how long a seat is held). Then `attachReservation(userId, session.id)`.
  - **Leak guard:** wrap session-create + attach in try/catch; if Stripe throws after the
    claim, call `releaseSeat` (or a direct decrement) so the seat isn't lost.
- Monthly and the no-seat path proceed at full price unchanged.

### E) Webhook — `POST /api/payments/webhook` (extended)

- `checkout.session.completed`: branch on `metadata.founding === "1"`:
  - Founding → `confirmSeat(session.id)` and create the `CouponRedemption` for reporting;
    **skip** the existing `usedCount { increment }` (already counted at reservation).
  - Non-founding coupon → existing behavior unchanged (increment `usedCount`, record
    redemption).
- `checkout.session.expired`, `invoice.payment_failed`, `customer.subscription.deleted`:
  call `releaseSeat(session/related session id)` so an unpaid/failed seat returns to the pool.
  (Idempotent via the status guard.)

### F) Status endpoint — `GET /api/founding/status` (new)

Returns `foundingStatus()` → `{ active, remaining, total, percentOff }`. Auth'd (pricing
lives in the dashboard). The pricing page polls it on load (and after a cancelled return).

### G) Pricing page (auto-apply UI)

- On load, fetch `/api/founding/status`. If `active`:
  - Show a founding banner + live counter: **"🔥 ราคา Founding · ล็อกตลอดชีพ — เหลืออีก {remaining} / 100 ที่นั่ง"**.
  - On **annual** PRO/BUSINESS cards, show the founding price
    (`base * (1 - percentOff/100)`, rounded) with the original struck through and a
    "Founding · ล็อกตลอดชีพ" badge. Monthly cards unchanged.
  - The displayed price derives from the **same `percentOff`** the checkout applies → always
    consistent.
- `handleUpgrade` does not need to send anything extra; the server auto-claims. A manual
  coupon entered in `CouponBox` still takes precedence (server rule in D).

## Data flow

Admin creates the `FOUNDING100` DISCOUNT coupon (forever, 100) → Stripe coupon + promo
provisioned. User opens pricing → `/api/founding/status` shows founding price + "X/100 left".
User clicks upgrade (annual) → checkout `claimSeat` atomically increments `usedCount` (if
< 100) → Stripe session created with `discounts:[{promotion_code}]` + `metadata.founding` →
`FoundingReservation(RESERVED)`. On `completed` → `confirmSeat` (RESERVED→CONFIRMED, no
re-count). On `expired`/`payment_failed`/`subscription.deleted` → `releaseSeat`
(RESERVED→RELEASED, decrement). Stale seats self-heal via `releaseStaleReservations`.

## Error handling

| Case | Behavior |
|---|---|
| Concurrent claims at the last seat | Atomic `updateMany usedCount<cap` → exactly one wins; others get full price |
| Stripe session-create fails after claim | Catch → release the seat (decrement) so it isn't leaked |
| `completed` webhook for a founding session | `confirmSeat`; **no** second increment (idempotent) |
| `expired`/`failed`/`deleted` for a RESERVED seat | `releaseSeat` decrements once; status guard prevents double-release |
| Missed `expired` webhook | `releaseStaleReservations` frees seats older than ~35 min |
| User already CONFIRMED tries again | `claimSeat` returns null → full price (already a founding member) |
| User enters `FOUNDING100` manually | validate/redeem reject it (auto-applied only) |
| Manual DISCOUNT code + founding both possible | Manual code wins; no stacking |

## Out of scope (YAGNI)

- Claim/allowlist page (separate Phase 2 task) · free trial · admin UI redesign.
- Founding on monthly plans · per-plan pools (100 is one shared pool) · fixed-baht founding.
- Waitlist / "notify me when sold out" after seat 100.

## Testing (local, Stripe test mode + chrome-devtools)

1. Create `FOUNDING100` DISCOUNT coupon (50%, forever, maxUses 100) → app row has Stripe
   coupon + promo ids; `GET /api/founding/status` → `{active:true, remaining:100, percentOff:50}`.
2. Pricing page (annual): founding banner + "เหลืออีก 100 / 100" + founding price with the
   original struck through. Monthly: unchanged.
3. Upgrade (annual) → checkout session has the promotion code attached
   (`total_details.amount_discount > 0`), `metadata.founding:"1"`, a `FoundingReservation`
   RESERVED exists, and `usedCount` is now 1.
4. Complete the test payment → reservation CONFIRMED, `usedCount` still 1 (no double count),
   `CouponRedemption` recorded.
5. Start a second checkout then let it expire (or trigger `checkout.session.expired`) →
   reservation RELEASED, `usedCount` back to its prior value.
6. **Race test:** set `usedCount = 99`; fire two concurrent checkouts → exactly one gets a
   seat (`usedCount` ends at 100), the other is full price.
7. Sold-out: `usedCount = 100` → status `active:false`, pricing shows full price, no seat
   claimed at checkout.
8. Regression: a normal DISCOUNT coupon still increments in the webhook; a GRANT coupon still
   redeems instantly; manual `FOUNDING100` entry is rejected.

## Deploy notes

- Additive schema (new `FoundingReservation` model) → back up `prisma/dev.db`, run
  `npx prisma db push` on the VPS, then `deploy/deploy.sh`. Coordinate with wao1234
  (`schema.prisma` shared).
- No new env keys — uses the live Stripe client (SiteConfig). The `FOUNDING100` coupon
  created in prod creates a **live** Stripe Coupon/Promotion Code; set `percentOff` and the
  banner copy before launch.
- Branch `mew/founding-100` → PR into `main` (never push broken code to `main` = prod).
</content>
</invoke>
