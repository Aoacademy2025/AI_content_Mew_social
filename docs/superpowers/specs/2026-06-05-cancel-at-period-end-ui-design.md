# Design — Cancel-at-period-end visibility + in-app resume

**Date:** 2026-06-05
**Owner:** Mew (Payment/pricing vertical)
**Status:** Approved (design), pending implementation plan

## Problem

When a card subscriber cancels via the Stripe billing portal, Stripe schedules the
subscription to end at the period end (`cancel_at_period_end = true`) and keeps it
active until then. Our webhook does **not** handle `customer.subscription.updated`, so
the app never learns the subscription is set to lapse. The user sees no indication in
`settings` that their plan will end, and has no in-app way to undo the cancellation —
they would have to return to the Stripe portal.

This is a live gap affecting current paying customers. It is **not** a bug in the
payment flow itself (payments work); it is missing visibility + a retention affordance.

## Goal

1. Reflect the "scheduled to cancel on <date>" state in the app.
2. Let the user reverse the cancellation in-app with one click ("ใช้ {plan} ต่อ").

## Non-goals (YAGNI)

- No custom in-app **cancel** button — the Stripe portal already does cancellation.
- No win-back offers / discount-to-stay flow.
- No handling of plan upgrade/downgrade via `subscription.updated` (only the
  cancel/resume flag is in scope).

## Key technical constraints (verified 2026-06-05)

- **Stripe API version `2026-04-22.dahlia`** (stripe pkg 22.1.1). In this version
  `current_period_end` is **no longer top-level** on `Subscription` — it lives on
  `subscription.items.data[].current_period_end`. We therefore read the cancellation
  date from **`sub.cancel_at`** (still top-level, populated when a cancel is scheduled),
  not from `current_period_end`.
- `activatePlan()` computes `planExpiresAt` as `base + periodDays`, **not** from
  Stripe's real period end. So `planExpiresAt` can drift from the actual Stripe lapse
  date. We store the precise cancel date separately (`cancelAt`) rather than reusing
  `planExpiresAt`.
- Stripe config lives in DB `SiteConfig` (loaded by `src/lib/load-stripe-config.ts`),
  not `.env`. The `stripe` client is created in `src/lib/stripe.ts`.

## Architecture

Four touch points.

### A) Schema — `prisma/schema.prisma` (additive)

Add to `User`:

```prisma
cancelAtPeriodEnd Boolean   @default(false)
cancelAt          DateTime?   // exact lapse date from Stripe sub.cancel_at; null when not scheduled
```

- Additive, nullable/defaulted → safe migration via `prisma db push` on deploy.
- `prisma/schema.prisma` is a **shared file** with wao1234 → coordinate deploy timing;
  the change is purely additive so merge-conflict risk is low.

### B) Webhook — `src/app/api/payments/webhook/route.ts`

Add a handler for `customer.subscription.updated`:

1. `const sub = event.data.object` (Stripe.Subscription).
2. Find the user by `stripeSubscriptionId == sub.id` (fallback: `stripeCustomerId == sub.customer`).
3. If no user → `console.warn` + return `200` (match existing pattern; avoid Stripe retry storms).
4. Update the user:
   - `cancelAtPeriodEnd = sub.cancel_at_period_end`
   - `cancelAt = sub.cancel_at ? new Date(sub.cancel_at * 1000) : null`
   - `subStatus = sub.status`

This single case covers **both directions**: cancellation sets the flag/date; a resume
(via portal or our resume route) fires the same event with `cancel_at_period_end =
false`, which clears them.

### C) Resume route — `POST src/app/api/payments/resume/route.ts`

1. Clerk auth → resolve the current user; load `stripeSubscriptionId`.
2. If no active `stripeSubscriptionId` → `400`.
3. `await stripe.subscriptions.update(subId, { cancel_at_period_end: false })`.
4. **Optimistically** update DB (`cancelAtPeriodEnd = false`, `cancelAt = null`) so the
   UI updates immediately; the `subscription.updated` webhook confirms asynchronously.
5. Stripe error → `500` with a JSON error message.

Idempotent: resuming an already-active subscription is a no-op success.

### D) Settings UI — `src/app/(dashboard)/settings/page.tsx` (billing section)

- When `cancelAtPeriodEnd` is true: render an amber status line
  **"แพ็ก {plan} จะยกเลิกวันที่ {cancelAt}"** plus a primary button
  **"ใช้ {plan} ต่อ"** that `POST`s to `/api/payments/resume`. On success, clear the
  banner locally (optimistic) — no full refetch needed; the webhook reconciles.
- Otherwise (active subscription, no scheduled cancel): keep today's
  **"จัดการการสมัคร"** (billing portal) button unchanged.

## Data flow

- **Cancel:** user → Stripe portal cancels → `customer.subscription.updated` webhook →
  `cancelAtPeriodEnd = true`, `cancelAt = <date>` → settings shows status + "ใช้ {plan} ต่อ".
- **Resume:** user clicks "ใช้ {plan} ต่อ" → `POST /api/payments/resume` →
  `stripe.subscriptions.update(cancel_at_period_end:false)` + optimistic DB clear →
  `customer.subscription.updated` webhook confirms → settings back to normal.

## Error handling

| Case | Behavior |
|---|---|
| Webhook: user not found for sub | `console.warn` + `200` (no Stripe retry storm) |
| Webhook: malformed event | existing signature/parse guards apply |
| Resume: no subscription on user | `400 { error }` |
| Resume: Stripe API error | `500 { error }`, UI shows toast, no optimistic clear |
| Resume: double-click / already active | idempotent success |

## Testing (local, Stripe test mode)

Reuse the existing E2E harness (`.env` test keys + `stripe listen`):

1. Subscribe with a test card → PRO active, `stripeSubscriptionId` set.
2. Cancel via Stripe API/portal (`cancel_at_period_end: true`).
3. Assert webhook set `cancelAtPeriodEnd = true` and `cancelAt` = the period end.
4. Assert settings renders the status line + "ใช้ {plan} ต่อ".
5. Click resume → assert `POST /api/payments/resume` 200, DB flag cleared,
   webhook confirms, settings back to normal.

## Deploy notes

- Run `prisma db push` on the VPS (additive columns) as part of deploy.
- Coordinate deploy timing with wao1234 (shared `prisma/schema.prisma`).
- No new env/SiteConfig keys required — resume uses the existing live Stripe client.
- After deploy, optionally add `customer.subscription.updated` to the live Stripe
  webhook endpoint's event list if it is not already subscribed (the endpoint
  `we_1Tet6N…` currently has 6 events — verify `customer.subscription.updated` is one).
