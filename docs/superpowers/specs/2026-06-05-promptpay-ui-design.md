# Design — PromptPay payment option on the pricing page

**Date:** 2026-06-05
**Owner:** Mew (Payment/pricing vertical)
**Status:** Approved (design), pending implementation plan
**Closes:** Phase 1 (pricing/subscription/PromptPay + new pricing page + Quick Wins)

## Problem

The checkout backend already fully supports PromptPay — `resolvePrice(plan, period, method)`
returns the annual one-time price for `method:"promptpay"`, and
`/api/payments/checkout` sets `payment_method_types:["promptpay"]` and `mode:"payment"`.
It is live and proven. But the pricing page UI never exposes it: `handleUpgrade()` in
`src/app/(dashboard)/pricing/page.tsx` hardcodes `method:"card"`, so every purchase goes
through card subscription. Thai customers who prefer paying once via PromptPay (no
auto-charge) have no way to choose it.

This is a frontend-only gap. The fix surfaces a payment-method choice without touching
the backend.

## Goal

Let the user choose **PromptPay (จ่ายครั้งเดียว/ปี, ไม่ตัดซ้ำ)** as an alternative to
**card (ต่ออัตโนมัติ)** when buying an **annual** plan, and pass that choice to the
existing checkout route.

## Business rules (from `resolvePrice`)

- **Monthly → card only** (subscription). PromptPay is NOT available for monthly.
- **Annual → card** (recurring subscription) **OR PromptPay** (annual one-time, 365 days, no auto-renew).
- Applies to **both PRO and BUSINESS** (both define `annualOnetime` prices).

## Chosen approach — Option A: inline payment-method toggle

(Chosen over B "two buttons per card" and C "method modal on click" — A has the lowest
friction, keeps the single existing CTA, and mirrors the period toggle already on the page.)

A second pill toggle appears **only when `period === "annual"`**, directly below the
existing monthly/annual toggle:

```
[ รายเดือน | (รายปี · ประหยัด 2 เดือน) ]      ← existing period toggle
[ 💳 บัตร · ต่ออัตโนมัติ | 📱 PromptPay · จ่ายครั้งเดียว ]   ← NEW, annual only
```

## Architecture

Single file: `src/app/(dashboard)/pricing/page.tsx` (Mew's vertical, NOT a shared file).
No schema change, no route change, no new component file (the toggle is small and local
to this page, matching the existing inline period toggle).

### State
- Add `const [method, setMethod] = useState<"card" | "promptpay">("card")`.

### Period/method coupling
- The existing monthly button's `onClick` also resets method:
  `onClick={() => { setPeriod("monthly"); setMethod("card"); }}`
  (PromptPay is invalid for monthly, so leaving it selected would send a bad combo.)
- The annual button keeps `onClick={() => setPeriod("annual")}` (method stays whatever it was, default `"card"`).

### Method toggle (new, rendered only when `period === "annual"`)
- Same pill markup/classes as the period toggle (`inline-flex rounded-full border ...`).
- Two buttons: `💳 บัตร · ต่ออัตโนมัติ` (method `"card"`) and `📱 PromptPay · จ่ายครั้งเดียว` (method `"promptpay"`).
- The active pill uses the same purple→cyan gradient highlight as the active period pill.

### Checkout call
- `handleUpgrade()` posts `method` from state instead of the hardcoded `"card"`:
  `body: JSON.stringify({ plan: planKey, period, method })`.

### Sales caption (small, under each plan's price or button)
A one-line caption that reflects the current selection (reinforces the PromptPay selling point):
- annual + card → `ต่ออัตโนมัติทุกปี · ยกเลิกได้ทุกเมื่อ`
- annual + promptpay → `จ่ายครั้งเดียว ไม่ตัดเงินอัตโนมัติ`
- monthly → `ต่ออัตโนมัติทุกเดือน · ยกเลิกได้ทุกเมื่อ`

## Data flow

`method` toggle → `handleUpgrade(plan)` → `POST /api/payments/checkout {plan, period, method}`
→ (unchanged) `resolvePrice` returns `annualOnetime` for promptpay → Stripe Checkout
`mode:"payment"`, `payment_method_types:["promptpay"]` → user pays via PromptPay QR →
`checkout.session.completed` webhook activates the plan for 365 days (no subscription).

## Error handling

No new error paths. If a PromptPay price is unconfigured, the existing checkout route
returns `500 {"error":"Stripe price not configured"}` and `handleUpgrade` already shows a
toast. Selecting PromptPay then switching to monthly resets to card, so an invalid
monthly+promptpay combo can never be sent.

## Out of scope (YAGNI)

- PromptPay for monthly plans (not supported by the pricing model).
- Any price/amount change, new schema, or new API route.
- Persisting the user's method preference across sessions.

## Testing

Frontend-only; verify with build + local E2E (Stripe test mode — backend already proven live):

1. **Build** (`npm run build`) — typecheck the page change.
2. **Toggle visibility:** monthly selected → method toggle hidden; switch to annual → it appears (default card).
3. **Reset:** select annual + PromptPay → switch to monthly → method resets to card.
4. **Checkout payload:** with annual + PromptPay, clicking upgrade calls `/api/payments/checkout`
   with `method:"promptpay"`; assert the created Stripe Checkout Session has
   `payment_method_types:["promptpay"]` and `mode:"payment"` (assert via the route response /
   Stripe API in test mode).
5. **Card path unchanged:** annual + card still creates a `mode:"subscription"` session.

## Deploy notes

- Frontend-only, no schema → standard `deploy/deploy.sh` is sufficient (no `prisma db push`).
- Pricing page is not a shared file, so collision risk with wao1234 is low; still align deploy timing.
- No new env/SiteConfig keys — the PromptPay annual price IDs are already live in prod SiteConfig.
