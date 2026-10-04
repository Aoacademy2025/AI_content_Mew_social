# Pre-flight critic — 2026-10-04-promptpay-monthly

Plan: `docs/plans/2026-10-04-promptpay-monthly.md`. I checked it against the cited code in the same worktree and against Stripe's "Cancel subscriptions" doc (docs.stripe.com/billing/subscriptions/cancel).

**Overall: FAIL.** 7 blocking, 16 advisory.

## 1. Acceptance criteria verdicts

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | FREE or trial user picks monthly → PromptPay and reaches a ฿599/฿990 Stripe checkout | Partially met | Tasks 1 and 2 build the path. The amount is only checked in the Task 6 smoke test, and only for PRO. The BUSINESS path is broken for some users (B4). |
| 2 | Settled payment gives 30 days, keeps unused trial days, extends a running cash term; Payment PAID with periodDays 30; billingPeriod monthly | **Not met** | No task tests activation for a 30-day one-time term. Trial preservation depends on a flag the plan never mentions (B2). |
| 3 | Flag off or price missing → behaves exactly as before | **Not met** | Several surfaces are not gated by the flag (B3). |
| 4 | Cancelled card checkout shows the PromptPay banner and a one-click checkout for the same plan and period | Partially met | Task 2 delivers it. The annual `{price}` is undefined and conflicts with the project's pricing rule (B7). |
| 5 | Past-due sub is canceled, no open invoice stays collectable, failure alerts admins, no rollback | Partially met | Task 3 covers it, but with gaps: "mark uncollectible" is allowed (B5), the guard reads only app-side status (B6), there is a crash window (A1) and an invoice.paid overwrite (A2). Nothing proves it against real Stripe (A12). |
| 6 | 30-day term gets only d3/d1 with a PromptPay-preselected link; past-due offers PromptPay | Partially met | Task 4 delivers it. The link fails for BUSINESS (B4). The email copy is not covered (A9). The in-app past-due banner is not covered (A10). |
| 7 | Affiliate metadata on a PromptPay monthly session equals card monthly's | Met | Task 1 checklist item 2. Today's `affiliateMeta` is computed once per period (`checkout/route.ts:72-74`). |
| 8 | Verify scripts in CI; tsc and lint clean; PR CI green | Partially met | No checklist runs `tsc` or lint. `next.config.ts` has `ignoreBuildErrors`, so "build+test" does not prove tsc (A11). |
| 9 | Smoke test passed and refunded; rollback steps written in the PR | Partially met | Task 6 writes rollback steps in the plan, not in the PR. Smoke test preconditions are missing (A13). |
| 10 | 14-day report: clicked→paid by method, new payers, PromptPay-monthly renewal rate | **Not met** | No task delivers it (B1). |

## 2. Blocking findings

**B1 — AC10 has no task, and one of its metrics cannot be measured at day 14.**
- No task schedules or produces the report.
- A 30-day term bought in the first 14 days has not reached renewal by day 14, so the "renewal rate" is undefined then.
- Fix: add Task 7 (session, after go-live), assigned to the session model.
  - Day 14: clicked→paid by method (baseline 6/34) and new payers per 30 days.
  - Day 45 or later: PromptPay-monthly renewal rate.
  - Name the data sources: `pricing_cta_clicked.method` and `checkout_completed.method` telemetry, and Payment rows with periodDays 30.

**B2 — Trial preservation is claimed unconditionally, but the code ties it to `PRESERVE_TRIAL_ON_CONVERT`, and no task tests AC2.**
- `checkout-plan-activation.ts:123-141`: when the flag is off, `preservation.preserved` is false and `onTrial` is true. The base is then `now`, and line 157 clears `trialEndsAt`, so the trial days are lost.
- Global Constraint line 32 and AC2 both say the term "starts at trial end" with no condition.
- No checklist item tests `activatePaidCheckout` with periodDays 30.
- Fix:
  - State the dependency, and add "confirm `PRESERVE_TRIAL_ON_CONVERT=1` on prod" to Task 6. Otherwise reword AC2.
  - Add to Task 1 (or Task 3) a throwaway-SQLite test of `activatePaidCheckout({mode:"payment", periodDays:30, billingPeriod:"monthly"})` for four cases: unconverted trial with flag on and off, running cash term, and no term. Assert expiry, `billingPeriod`, and the Payment row (PAID, 30).

**B3 — "Flag off = byte-for-byte today" (Global Constraint line 33, AC3) contradicts several surfaces that are not gated.**
- **Annual cancel banner.** Copy line 51 shows the new banner whenever "PromptPay is offered for that plan+period". Annual PromptPay is always offered, so with `PROMPTPAY_MONTHLY` off the annual cancel return changes.
- **Webhook auto-cancel.** Architecture item 4 and line 35 apply it to any settled one-time payment, which includes annual PromptPay, regardless of the flag.
- **Task 4.**
  - Renewal links always get `&method=promptpay`.
  - The 30-day copy says "ต่ออีก 30 วันด้วย PromptPay".
  - The past-due not-entitled body and link (`period=monthly&method=promptpay`) are unconditional.
  - When the flag is off or a price is missing, these notices send customers to a pricing page that hides monthly PromptPay. This happens during the deploy→price-paste window (Task 6 steps 3-4) and after rollback (step 6).
- Fix:
  - Gate each surface on `promptpayMonthlyOffered(plan)` for monthly. Keep annual banner and annual auto-cancel either explicitly ungated or gated on the flag, and write that decision into Global Constraints and AC3.
  - Task 4 then depends on Task 1 for the helper. Update the Blocked-by column (A14).
  - Add flag-off cases to the `verify:renewal-reminders` and `verify:past-due-dunning` checklists.

**B4 — BUSINESS cash-term users cannot buy again from /pricing, so the 30-day renewal loop fails for BUSINESS.**
- `plan-change.ts:90-92`: a non-subscriber whose current plan equals the card's plan gets `"renew"` only when `cardPlan === "PRO"`. Otherwise it gets `"current"`.
- `pricing-client.tsx:548-549` then renders a disabled "แผนปัจจุบัน" with no button.
- Effects:
  - A BUSINESS PromptPay-monthly buyer who follows the d3/d1 link (`#plan-business&method=promptpay`) cannot renew.
  - A past_due BUSINESS customer who is still entitled cannot pay with PromptPay.
- No task touches this. Task 2 only fixes the `"wait"` case.
- Fix: in Task 2, return `"renew"` for any paid tier when the user has no live subscription and the selected method is PromptPay. Add a `verify-plan-change` case for BUSINESS.

**B5 — "void or mark them uncollectible" (Global Constraint line 36) permits an option that fails AC5.**
- Stripe docs: canceling sets `auto_advance=false` on open and draft invoices, and "You can still manually attempt to collect payment". The invoices stay open and payable.
- An `uncollectible` invoice can still be paid as well.
- Only **void** makes an invoice uncollectable.
- Fix: replace the clause with: "After cancel, list the subscription's `open` invoices and void each. A void failure (for example a PaymentIntent in `processing`) alerts admins as an ERROR." Add a void-failure case to the Task 3 tests.

**B6 — The auto-cancel guard trusts the app-side `subStatus` alone.**
- Webhooks arrive out of order. A Smart Retry can succeed (Stripe status `active`) before `customer.subscription.updated` or `invoice.paid` updates the row.
- The helper would then cancel a subscription the customer just paid, which breaks "never touches active".
- Fix: the helper retrieves the subscription from Stripe and cancels only if **both** the app status and the Stripe status are `past_due` or `unpaid`.
  - If Stripe says `active`, do not cancel. Notify admins that the customer was charged twice.
  - If Stripe says already `canceled`, treat it as success.
  - Add these as test cases.

**B7 — Annual cancel-banner `{price}` is undefined and conflicts with the pricing display rule.**
- Copy line 52 (annual) says `สแกนจ่าย ฿{price} ใช้ {TIER} ได้ 1 ปี` and line 61 says "same formatting as the pricing card".
- The pricing card shows the annual plan as a *monthly equivalent* (`pricing-client.tsx:271`).
- The project rule (CLAUDE.md "Pricing display rule") says "NO annual total" on pricing surfaces.
- The value is also unspecified: full ฿5,990 / ฿9,900, or the Founding-discounted amount that checkout auto-applies on annual.
- Fix: decide and write the exact annual value. For example, drop the price for annual: `สแกนจ่ายครั้งเดียว ใช้ {TIER} ได้ 1 ปี ไม่ต้องใช้บัตร`. Or record an explicit exception to the rule.

## 3. Advisory findings

- **A1 — Crash window.** Auto-cancel runs after the activation transaction commits. If the process dies before the Stripe call, every retry returns early on `already_paid` (`webhook/route.ts:193-196`), so nothing cancels the subscription and no admin alert fires.
  - Fix: on the `already_paid` branch for `mode === "payment"` plan sessions, call the (idempotent) helper again.
- **A2 — "Never rolled back" has a hole.** If the cancel fails or races, a later `invoice.paid` sets `planExpiresAt = entitlement.periodEnd` (`webhook/route.ts:331`). That overwrites the PromptPay-extended expiry.
  - Fix: the failure alert should say "Smart Retries still active; cancel now or the paid term will be overwritten". Optionally, in `invoice.paid`, keep `max(current planExpiresAt, periodEnd)` when a newer cash Payment exists.
- **A3 — Config loading is unspecified.**
  - `promptpayMonthlyOffered` reads the price from `process.env`. That is only filled by `ensureStripeConfig()`, and `instrumentation.ts:82-87` does not load the new keys. `/pricing`, the marketing page and both reminder senders must call `ensureStripeConfig()` first.
  - Two new keys that stay unset make `ensureStripeConfig` query the DB on every call (`load-stripe-config.ts:22-23`). That adds cost to the LCP-sensitive homepage until the prices are pasted.
  - Files missing from Task 1/2 lists:
    - `src/lib/site-config.ts:44-52`: the `resolveSettingValue` envMap. Without it, GET shows blank for env-only values.
    - `src/app/page.tsx` and `src/components/marketing/pricing-toggle.tsx`: they must pass the "offered" input.
- **A4 — Monthly default can silently become PromptPay.** `pricing-client.tsx` keeps one shared `method` state. With `NEXT_PUBLIC_PRICING_DEFAULT_RECURRING` off, the default is `"promptpay"` (`pricing-display.ts:89`), so once monthly honors PromptPay, monthly opens on PromptPay. That breaks "Card stays the default".
  - Fix: reset to card when switching to monthly unless `?method=promptpay` is present, or keep a separate method state per period. Add a test with the recurring-default flag off.
- **A5 — Copy conflict on the card.** `priceBlock` monthly `sub` is `ต่ออัตโนมัติรายเดือน · ยกเลิกได้` (`pricing-client.tsx:269`). Copy does not say whether the PromptPay note replaces it. Showing both says "auto-renew" next to "ไม่ตัดเงินอัตโนมัติ".
  - Fix: state that the note replaces `sub` when monthly + PromptPay is selected.
- **A6 — `{price}` source and format.**
  - Global Constraint says `PLANS[x].thb`, but the card displays the admin-editable `planConfig[x].price`. Pick one.
  - Wrong claim: the pricing card formats with `toLocaleString()` without a locale (`pricing-client.tsx:269,277`), not `"th-TH"`. Only `marketingPriceBlock` uses th-TH.
- **A7 — Test feasibility.** The repo tests route files by source text (e.g. `verify-renewal-receipts.ts:14`) and keeps settlement logic outside routes so it can be tested (`checkout-plan-activation.ts:49-50`). The "stubbed Stripe" tests in Tasks 1 and 3 need extracted pure functions.
  - Fix: name them, e.g. `buildCheckoutSessionParams()` in `src/lib`, and a cancel helper that takes the Stripe client as a parameter.
  - Say that the `customer.subscription.deleted` check (Task 3 item 5) is a source-text assertion.
- **A8 — Task 3 scope and cases.**
  - "Settled one-time payment" must exclude credit packs explicitly (that branch is `webhook/route.ts:54`), and must state whether annual PromptPay is included (ties to B3).
  - Add test cases: Bundle subscription, a sub id that differs from the user's `stripeSubscriptionId`, and a sub Stripe already canceled.
- **A9 — Task 4 details.**
  - `isCashBackedRenewalTerm` returns a boolean, so "matched periodDays" needs it to return the matched payment. Define which one wins when several match: the most recent.
  - Stacked terms fall outside the 7-day `TERM_START_TOLERANCE_MS` and get no reminders at all (pre-existing, but likely with monthly). Examples: buying more than 7 days early, or two months back to back.
  - Pick the 30-day copy with the same predicate as the gating (`periodDays < 300`).
  - `sendRenewalReminderEmail` (`send-email.ts:380-394`) has its own text and ignores `renewalReminderCopy`. Say whether the email changes; otherwise the 30-day copy reaches in-app only.
  - Task 2: ignore `?method=promptpay` when monthly PromptPay is not offered.
- **A10 — Past-due surfaces.**
  - The persistent `src/components/layout/past-due-banner.tsx` is the most visible past-due notice. It stays card-only and is not mentioned. Mark it in scope or out of scope.
  - If auto-cancel failed, the d3 follow-up still tells a customer who has paid to "update card". Either skip d3 when a PAID cash payment exists after the failure, or accept that.
- **A11 — AC8.** Add `npx tsc --noEmit` and lint, with exit codes, to every task's checklist. The build ignores type errors.
- **A12 — AC5 has no real-Stripe proof.** Tests must stub Stripe and the smoke test never makes a subscription past_due.
  - Fix: add a Stripe **test-mode** run, using a test clock, of cancel plus void on a past_due subscription before going live. Record it in the research doc.
- **A13 — Task 6 gaps.**
  - Smoke-test preconditions are missing. Mew's account must have no active or trialing sub (otherwise `active_sub` blocks it), no running term and no trial; otherwise "+30 days" is wrong.
  - A refund does not revoke the plan (the `charge.refunded` handler only marks the Payment), so write the manual revert step.
  - Write the rollback steps into the PR body (AC9).
  - After `pm2 restart --update-env`, check that `PROMPTPAY_MONTHLY` actually reached the process. There is a prior incident where `.env` keys did not.
  - Check that hero-affiliate attributes a `mode=payment` session with `product_id=hero-studio-<tier>-monthly`, and only once it is paid. Monthly product ids were previously recurring-only.
- **A14 — Dependencies.**
  - Tasks 1, 3 and 4 each add npm scripts and lines to `.github/workflows/ci.yml` in parallel, so they will conflict. Assign the CI wiring to one task, or merge serially.
  - With the B3 fix, Task 4 becomes Blocked by 1.
- **A15 — Task 1 accuracy and input safety.**
  - "`isSub` comes from the resolved config" is already true (`checkout/route.ts:42`), so that item is a no-op.
  - The `plan`, `period` and `method` params in `cancel_url` are reflected into UI and into a checkout call. Whitelist them on read (`PRO|BUSINESS`, `monthly|annual`, `card|promptpay`). `page.tsx:29` searchParams types need the new fields.
- **A16 — Funnel attribution.** The cancel-banner one-click must fire `pricing_cta_clicked` with a distinct `surface` (e.g. `cancel_return_promptpay`). Otherwise the by-method report cannot isolate that moment.

## 4. Claims checked

- Correct: `stripe.ts:42-83`, `checkout-plan-activation.ts:118-141`, `checkout/route.ts` ~32, `pricing-client.tsx` ~184 and ~382-397, `pricing-display.ts:105-111`, `checkoutAllowed` allows a past_due non-recurring buyer (`plan-change.ts:114-133`), revenue-cohorts `oneTimeMonthly`, ADR 0066 and the CONTEXT "Recurring Subscriber" entry exist.
- Wrong or incomplete: the `{price}` formatting claim (A6), the "isSub" change (A15), the admin settings file list (A3), unconditional trial preservation (B2), and the open-invoice remedy (B5).

## 5. Readability for the executor

Tasks 1, 3 and 4 can mostly be done from the text once B3, B5 and B6 are fixed. Task 2 cannot be finished without decisions on B4, B7, A4 and A5. AC10 has no executor.
