# PromptPay for monthly plans (30-day prepaid term)

## Goal

Let a customer whose card fails buy a monthly plan anyway. Each paid tier (PRO ฿599, BUSINESS ฿990) gets a one-time PromptPay **30-day prepaid term** at the card monthly price. A customer whose card was declined is offered PromptPay at the moments they fail: the Stripe cancel return, the past-due notice, and the past-due banner. Decision and evidence: ADR 0066. Terms: CONTEXT.md "Recurring Subscriber", "Paid-Equivalent", "MAPC", "Prepaid Base".

Evidence (prod, 2026-10-04):
- Monthly card checkout clicked→paid is 6 of 34.
- 61 of 65 failed charges in 60 days were prepaid cards.
- 6 of 12 lost card-on-file trials failed at the first charge.

## Architecture

The PromptPay **annual** one-time term already exists end to end, and this feature reuses all of it:
- `PLANS[x].annualOnetime` / `resolvePrice` (`src/lib/stripe.ts:42-83`)
- the mode=payment branch of `handleCheckoutSession` (`src/app/api/payments/webhook/route.ts`)
- term activation (`src/lib/checkout-plan-activation.ts:118-141`)
- renewal reminders for cash-backed terms (`src/lib/renewal-reminders*.ts`)
- revenue bucketing (`revenue-cohorts.ts` already buckets a 30-day one-time term as `oneTimeMonthly` and Prepaid Base, so no change there)

New pieces:
1. A `monthlyOnetime` price per tier. Its price IDs come from SiteConfig `stripe_price_<tier>_monthly_onetime` / env `STRIPE_PRICE_<TIER>_MONTHLY_ONETIME`, editable in `/admin` settings.
2. A server flag `PROMPTPAY_MONTHLY=1`, read in one helper module (`src/lib/promptpay-monthly.ts`) and passed to client components as props (the `PRESERVE_TRIAL_ON_CONVERT` pattern, no `NEXT_PUBLIC_` twin).
   - "Offered" for a tier means flag on AND that tier's monthly-onetime price ID is non-empty.
   - **Every new behavior in this plan is gated by the flag**: monthly PromptPay checkout and UI, the cancel-return PromptPay banner (monthly and annual variants), auto-cancel of a past-due subscription, `method=promptpay` on renewal links, the 30-day renewal copy, the d30/d14 gating, and the past-due copy and banner changes.
   - With the flag off, every surface is exactly today's. The one exception is the BUSINESS "renew" fix in Task 2: it is a standalone pre-existing bug, ungated.
3. The cancel return carries what the customer tried to buy (whitelisted params), so the pricing page can offer a one-click PromptPay checkout for the same plan and period.
4. On a **settled** one-time plan payment, a Stripe subscription of the same user that Stripe itself reports as `past_due` or `unpaid` is canceled, and its open invoices are voided.
5. Renewal reminders give a 30-day term only d3/d1, with 30-day copy, and their links preselect PromptPay. Past-due surfaces offer PromptPay.

## Global Constraints

- **Prices.** Stripe Prices are one-time THB 599 (PRO) and THB 990 (BUSINESS), matching the card monthly Stripe prices. Displayed `{price}` = the same admin-editable `planConfig[tier].price` the card monthly option already shows, formatted exactly like that card (`toLocaleString()`, `pricing-client.tsx:269,277`). periodDays = 30. Stripe `mode: "payment"`, `payment_method_types: ["promptpay"]`.
- **Card is the default on the monthly toggle, always.** It is independent of `NEXT_PUBLIC_PRICING_DEFAULT_RECURRING`. Only an explicit `?method=promptpay` (whitelisted, honored only when offered) or a user click selects PromptPay on monthly. Annual keeps today's default logic.
- **Activation is unchanged.** A PromptPay monthly purchase uses the existing one-time activation:
  - with `PRESERVE_TRIAL_ON_CONVERT=1` (prod: on) and an unconverted trial, the term starts at trial end
  - with a running cash term, it extends from `planExpiresAt`
  - otherwise it starts now
  - `billingPeriod = "monthly"` in every case
- **Gating.** Flag off → byte-for-byte today's behavior on every surface (except the ungated BUSINESS renew fix). Flag on but a tier's price missing → that tier behaves as flag off for monthly PromptPay. Annual PromptPay and the other new behaviors still follow the flag.
- **Affiliate.** Metadata on a PromptPay monthly session = exactly what a card monthly session gets (`studioProductSlug(plan, "monthly")`).
- **Auto-cancel rules:**
  - (a) It runs only for a one-time **plan** payment (never a credit pack, `webhook/route.ts:54` branch), only after it is settled (`payment_status === "paid"`, which covers `checkout.session.async_payment_succeeded`), and never on an unpaid `checkout.session.completed`.
  - (b) It targets only the user's `stripeSubscriptionId`. It retrieves that subscription from Stripe and acts only if Stripe's own `status` is `past_due` or `unpaid`. It never touches `active`, `trialing`, `canceled` or Bundle subscriptions, or a different subscription id.
  - (c) It cancels with no proration and no final invoice, then **voids** every open invoice of that subscription. Never "mark uncollectible", because those invoices can still be paid.
  - (d) It is idempotent. It also runs on the `already_paid` retry branch for a settled mode=payment plan session, so a crash between activation and the Stripe call is recovered by Stripe's webhook retry.
  - (e) If the Stripe call fails, the payment and term stay recorded, the webhook does not throw, and `notifyAdmins` is called with ERROR text containing the user id, the sub id, and `Smart Retries ยังทำงาน — ยกเลิก subscription นี้ใน Stripe ทันที ไม่งั้น invoice.paid จะเขียนทับวันหมดอายุที่ลูกค้าจ่าย PromptPay`. The paid term is never rolled back by this feature.
  - (f) Annual PromptPay plan payments get the same auto-cancel, under the flag.
- **Renewal reminders.** The matched term is the most recent qualifying cash payment. d30/d14 only when its `periodDays >= 300`. d3/d1 for every cash-backed term. 30-day copy is used when `periodDays < 300` (same predicate). All of this applies only under the flag; flag off, everything is unchanged.
- **Cancel-return params** `plan` / `period` / `method` are whitelisted on read: `PRO|BUSINESS`, `monthly|annual`, `card|promptpay`. Anything else is ignored.
- **Testability.** Testable logic lives in `src/lib` pure or injectable functions; route files only wire them. Required functions:
  - `buildCheckoutSessionParams(...)`: the checkout session param builder
  - `cancelSupersededSubscription(stripe, ...)`: takes the Stripe client as a parameter
  - `selectRenewalKind(daysLeft, periodDays)`
  - Route wiring is asserted by source-text checks, the existing repo pattern (e.g. `verify-renewal-receipts.ts:14`).
- **Tests.** `scripts/verify-*.ts` with `tsx`. Throwaway SQLite where a DB is needed. Stripe is always stubbed, never a real Stripe call in a test. Every task's checklist includes `npx tsc --noEmit` and lint on the changed files, with exit codes reported.
- **CI wiring.** One npm script `verify:promptpay-monthly` chains every new verify script, and one CI step runs it. Task 1 creates both, and Tasks 2–4 append to that npm chain only.
- No schema change. No new npm dependency.
- **Telemetry.** The cancel-banner button fires `pricing_cta_clicked` with `surface: "cancel_return_promptpay"`, plus plan/period/method like the other pricing CTAs.
- Every Thai UI string is exactly the copy in "Copy".

## Copy (Thai, verbatim; all new strings render only under the flag)

| Where | Text |
|---|---|
| Monthly method toggle, option 1 | `บัตร · ต่ออัตโนมัติ` (same label as annual) |
| Monthly method toggle, option 2 | `PromptPay · 30 วัน` |
| Pricing card, monthly + PromptPay selected | Replaces the monthly `sub` line (`ต่ออัตโนมัติรายเดือน · ยกเลิกได้`) with `จ่ายครั้งเดียว ฿{price} · ใช้ได้ 30 วัน · ไม่ตัดเงินอัตโนมัติ` |
| `marketingPriceBlock` monthly `billingNote`, when offered | `บัตร (ต่ออัตโนมัติ) หรือ PromptPay (ครั้งละ 30 วัน)` |
| `marketingPriceBlock` monthly `billingNote`, not offered | unchanged `ชำระด้วยบัตร · ต่ออัตโนมัติและยกเลิกได้` |
| Cancel-return banner, title (cancelled session was **card**; PromptPay offered for that plan+period) | `บัตรใช้ไม่ได้? จ่ายด้วย PromptPay แทนได้` |
| Cancel-return banner, body, monthly | `สแกนจ่าย ฿{price} ใช้ {TIER} ได้ 30 วัน ไม่ต้องใช้บัตร` |
| Cancel-return banner, body, annual (no amount; "no annual total" pricing rule) | `สแกนจ่ายครั้งเดียว ใช้ {TIER} ได้ 1 ปี ไม่ต้องใช้บัตร` |
| Cancel-return banner, button | `จ่ายด้วย PromptPay` |
| Cancel return otherwise (PromptPay session, not offered, flag off) | unchanged `ยกเลิกการชำระเงินแล้ว — กลับมาเลือกแพ็กได้ทุกเมื่อ` |
| Renewal reminder body (in-app and email), 30-day term | `ต่ออีก 30 วันด้วย PromptPay ก่อนหมด เพื่อสร้างและส่งออกงานต่อได้ไม่สะดุด` |
| Renewal reminder, annual term | unchanged |
| Past-due notice, still entitled, body | existing body + ` · ไม่มีบัตรที่ใช้ได้? จ่าย PromptPay แทนได้ที่หน้าราคา` (link unchanged: card update) |
| Past-due notice, not entitled, body | `บัตรที่ผูกไว้ถูกปฏิเสธ บัญชีจึงกลับเป็น FREE ชั่วคราว — อัปเดตบัตร หรือจ่าย PromptPay เพื่อกลับมาใช้ {TIER} ทันที` |
| Past-due notice, not entitled, CTA / link | CTA unchanged `กลับมาใช้ {TIER}`. Link `/pricing?source=past_due&period={monthly\|annual}&method=promptpay#plan-{pro\|business}`, using the user's `billingPeriod` (default monthly). |
| Past-due banner (`src/components/layout/past-due-banner.tsx`), secondary link | `หรือจ่ายด้วย PromptPay` → same link as the row above |

`{TIER}` is `PRO` / `BUSINESS`.

## Tasks

### Task 1 — Server purchase path (flag, prices, checkout, cancel URL, admin config, CI step)
Files:
- `src/lib/stripe.ts`: `monthlyOnetime` on both tiers; `resolvePrice` method-aware for monthly.
- `src/lib/load-stripe-config.ts` `DB_KEYS`, `src/instrumentation.ts:~82` preload list, and `src/lib/site-config.ts:44-52` `resolveSettingValue` envMap: add both keys.
- `src/app/api/admin/settings/route.ts` (`KEYS` + `envMap`) and `src/app/(dashboard)/admin/settings/page.tsx`: two inputs following the `stripe_price_pro` pattern, labelled `Stripe Price — PRO รายเดือน PromptPay (one-time)` / `Stripe Price — BUSINESS รายเดือน PromptPay (one-time)`.
- New `src/lib/promptpay-monthly.ts`:
  - `promptpayMonthlyEnabled()`
  - `async promptpayMonthlyOffered(plan)`: returns false immediately when the flag is off, with no DB call; otherwise awaits `ensureStripeConfig()` and checks the price
  - `parseCancelReturnParams(searchParams)`: the whitelist
- New `buildCheckoutSessionParams(...)` in `src/lib`, used by `src/app/api/payments/checkout/route.ts`:
  - coerce monthly→card only when not offered
  - `cancel_url = /pricing?payment=cancelled&plan={PLAN}&period={period}&method={method}`, only under the flag; flag off keeps today's URL

Checklist:
- [ ] Flag off, or price missing → a monthly+promptpay request builds today's card subscription params, and `cancel_url` is unchanged (test).
- [ ] Flag on + price set → `mode: "payment"`, `payment_method_types: ["promptpay"]`, metadata period `monthly`, periodDays `30`, affiliate metadata identical to card monthly (test).
- [ ] A past_due user and an active-cash-term user can check out monthly PromptPay. `checkoutAllowed` is unchanged (test).
- [ ] Activation of a 30-day term via `checkout-plan-activation.ts` with a throwaway DB covers these cases (test):
  - (i) no trial → now +30
  - (ii) unconverted trial with `PRESERVE_TRIAL_ON_CONVERT=1` → trial end +30
  - (iii) running cash term → `planExpiresAt` +30
  - `billingPeriod` monthly and a PAID Payment with periodDays 30 in all three
- [ ] `parseCancelReturnParams` rejects non-whitelisted values (test).
- [ ] `scripts/verify-promptpay-monthly.ts` + npm `verify:promptpay-monthly` + one CI step in `.github/workflows/ci.yml`.
- [ ] `npx tsc --noEmit` and lint report exit 0.

### Task 2 — Pricing UI (monthly toggle, preselect, cancel-return one-click, marketing note, BUSINESS renew)
Files:
- `src/app/(dashboard)/pricing/page.tsx`: compute `promptpayMonthlyOffered` per tier server-side and pass it as props. Parse `method` / `plan` / `period` with `parseCancelReturnParams`, and extend the searchParams type (`page.tsx:29`).
- `src/app/(dashboard)/pricing/pricing-client.tsx`:
  - per-period method state, monthly defaulting to card
  - `effectiveMethod` (~184) honors PromptPay on monthly when offered
  - toggle (~382-397) renders for monthly when offered
  - card note per Copy (replaces `sub`)
  - `?method=promptpay` preselect, only when offered for that period
  - cancel banner per Copy; its button calls the existing checkout with `{plan, period, method: "promptpay"}` and fires the telemetry from Global Constraints
- `src/lib/pricing-display.ts:105-111`: `marketingPriceBlock` takes an `offered` input.
- `src/app/page.tsx` and `src/components/marketing/pricing-toggle.tsx`: pass `offered` from the server.
- `src/lib/plan-change.ts` `paidPlanCardMode`:
  - (a) `recurring` derives from the selected method, so monthly PromptPay never returns "wait"
  - (b) **ungated fix:** a BUSINESS cash user with no live subscription gets "renew" like PRO (today only PRO, lines 90-92), so BUSINESS prepaid buyers can renew from a reminder

Checklist:
- [ ] Monthly opens on card with `NEXT_PUBLIC_PRICING_DEFAULT_RECURRING` both on and off (test).
- [ ] Choosing PromptPay on monthly shows the note and sends `method: "promptpay"`.
- [ ] Not offered or flag off → no monthly toggle, and `?method=promptpay` is ignored on monthly. Card and marketing copy are unchanged (test).
- [ ] The cancel banner variants follow Copy exactly, and the button fires `cancel_return_promptpay` (test).
- [ ] `paidPlanCardMode` covers monthly PromptPay (no "wait") and BUSINESS renew (test).
- [ ] Existing `verify:pricing-defaults`, `verify:marketing-pricing`, `verify:pricing-lcp` and plan-change checks stay green, updated only for the intended behavior.
- [ ] The marketing homepage makes no extra DB query when the flag is off (the `promptpayMonthlyOffered` short-circuit).
- [ ] `npx tsc --noEmit` and lint report exit 0.

### Task 3 — Webhook: cancel a past-due subscription after a settled PromptPay plan payment
Files:
- `src/app/api/payments/webhook/route.ts`: the mode=payment plan settlement path in `handleCheckoutSession`, and its `already_paid` early return (~193-196)
- new `src/lib/cancel-superseded-subscription.ts` (`cancelSupersededSubscription(stripe, ...)`)

Checklist:
- [ ] Research before coding, written to `docs/research/2026-10-04-stripe-cancel-open-invoices.md` with Stripe primary-doc citations: what happens to open invoices and Smart Retries when a past_due subscription is canceled; that void stops collection; the exact API params for no proration and no final invoice.
- [ ] The helper follows all Auto-cancel rules (a)–(f) in Global Constraints, and runs only under the flag.
- [ ] Test with an injected Stripe stub covers:
  - Stripe status past_due and unpaid → canceled, open invoices voided
  - app says past_due but Stripe says active → untouched
  - trialing, canceled and Bundle subscriptions → untouched
  - a sub id different from the user's `stripeSubscriptionId` → untouched
  - an unpaid async session and a credit pack → untouched
  - retry after success → no-op
  - the `already_paid` retry path triggers the helper
  - a Stripe error → payment kept, no throw, admin notified with the required text
- [ ] Source-text check: the `customer.subscription.deleted` handler still only clears sub fields and never touches `plan` / `planExpiresAt`.
- [ ] `npx tsc --noEmit` and lint report exit 0.

### Task 4 — Reminders (renewal d3/d1 for 30-day terms, PromptPay links, past-due surfaces)
Files:
- `src/lib/renewal-reminders.ts`:
  - `isCashBackedRenewalTerm` returns the matched (most recent) payment, or an equivalent new function
  - `selectRenewalKind(daysLeft, periodDays)`
  - `renewalReminderLink` adds `&method=promptpay`
  - 30-day copy
- `src/lib/renewal-reminders.server.ts`: use the matched `periodDays`.
- `src/lib/send-email.ts:380-394` `sendRenewalReminderEmail`: 30-day body per Copy.
- `src/lib/past-due-dunning.ts` and `past-due-dunning.server.ts`:
  - copy and not-entitled link per Copy
  - skip the d3 follow-up when a PAID cash Payment exists after the failed invoice
- `src/components/layout/past-due-banner.tsx`: the secondary PromptPay link.
- Everything here is gated by the flag.

Checklist:
- [ ] Flag on: a 30-day term gets only d3/d1 with 30-day copy (in-app and email) and `method=promptpay` links. An annual term keeps d30/d14/d3/d1 and its copy, and its link gains `method=promptpay`. Flag off: exactly today's behavior (test).
- [ ] Past-due copy, links and banner follow Copy. The still-entitled link is unchanged. d3 is skipped after a cash payment (test).
- [ ] `verify:renewal-reminders`, `verify:renewal-receipts` and `verify:past-due-dunning` are updated only for the intended changes and green.
- [ ] `npx tsc --noEmit` and lint report exit 0.

### Task 5 — Glossary + ADR (done in interview session)
`CONTEXT.md` "Recurring Subscriber" now names the 30-day monthly term. `docs/adr/0066-promptpay-monthly-prepaid-term.md` is written. Both are committed with the plan.

### Task 6 — Release (session, after Mew's go)
1. Whole-branch review (mew-reviewer, opus) and `security-review` are green, and PR CI is green. The PR body carries the rollback steps. Then merge.
2. **Test-mode proof**, if the Stripe MCP gives test-mode access: make a test-clock subscription go past_due, run the cancel+void sequence the helper uses, and confirm no invoice stays collectable. Record it in the research doc. Without test-mode access, record that the proof is docs-only.
   - **2026-10-05:** the Stripe MCP exposes only the live account (`acct_1TZBIjL39kyExJWO`), so the proof is docs-only (`docs/research/2026-10-04-stripe-cancel-open-invoices.md`).
3. Create two one-time Stripe Prices in **live** mode via the Stripe MCP: THB 599 on the PRO product and THB 990 on the BUSINESS product. The products are the ones the configured card monthly prices belong to. Record the IDs here.
   - **Done 2026-10-05 (live):** PRO ฿599 `price_1UMtNLL39kyExJWO1g2j5BUG` on `prod_Udyx4PpeOiclyQ` (Hero AI PRO); BUSINESS ฿990 `price_1UMtLTL39kyExJWOmbxkcfmz` on `prod_Udyx1QfllkLdOA` (Hero AI BUSINESS). Not yet pasted in `/admin`.
4. **Affiliate check:** confirm with the hero-affiliate side (repo if reachable, otherwise Mew) that a paid `mode=payment` session with `product_id=hero-studio-<tier>-monthly` is credited once and only after payment. Monthly product ids were previously recurring-only. A mismatch does not block go-live, but it is reported.
5. Prod `.env`: `PROMPTPAY_MONTHLY=1` (Mew or a `!` command). Deploy with the standard command (Mew approved "go live when done"). Confirm the flag reached the process: `/proc/<pid>/environ`, or re-register the app if not (prior incident: `.env` keys did not apply on restart). Paste both price IDs in `/admin` settings.
6. **Smoke test preconditions:** the test account has no active or trialing subscription, no running term and no active trial. Mew buys PRO monthly PromptPay ฿599. Check: PRO, `planExpiresAt` = +30 days, `billingPeriod` monthly, PAID Payment periodDays 30, affiliate metadata present if a ref was set. Then refund in Stripe and **revert the plan by hand**, because `charge.refunded` only marks the Payment. Use `/admin` or an approved script, and record which.
7. **Rollback:** unset `PROMPTPAY_MONTHLY` and restart with the env actually applied (step 5 check). Every new surface reverts. Terms already sold stay valid.

### Task 7 — Measurement (session)
- Day 14 after go-live: monthly clicked→paid by method (baseline 6/34), cancel-banner clicks (`cancel_return_promptpay`) → paid, and new payers per 30 days.
- Day 45: PromptPay-monthly renewal rate (share of 30-day terms that bought again by expiry +7 days).
- Report in a short markdown under `docs/audits/`, plus one line to Mew.

## Assurance and Budget
- Profile: high-assurance
- Risk: high — payments, Stripe side effects (subscription cancel, invoice void), live prices
- Automatic fix rounds per task: 5
- Maximum subagent runs: 20
- Concurrency: Task 1 first; then Tasks 2, 3, 4 in parallel. The npm chain line in `package.json` is merged by the session.
- Usage checkpoints: before execute, after each frontier wave, before final gate

## Execution Directive
| # | Task | Agent | Mode | Blocked by | Review gates |
|---|------|-------|------|-----------|--------------|
| 1 | Server purchase path | mew-worker-heavy | subagent | — | build+test, mew-reviewer, security review |
| 2 | Pricing UI | mew-worker | subagent | 1 | build+test, mew-reviewer |
| 3 | Webhook auto-cancel past-due | mew-worker-heavy | subagent | 1 | build+test, mew-reviewer, security review |
| 4 | Reminders | mew-worker | subagent | 1 | build+test, mew-reviewer |
| 5 | Glossary + ADR | (session model) | inline | — | done |
| 6 | Release | (session model) | inline | 1,2,3,4 | whole-branch mew-reviewer (opus) + security-review, CI green, smoke test |
| 7 | Measurement | (session model) | inline | 6 | day 14 + day 45 reports |

## Acceptance Criteria
- [ ] With the flag on and prices configured, a FREE or trial user can pick monthly → PromptPay on `/pricing` (card is still the default) and reach a Stripe PromptPay checkout for ฿599 (PRO) / ฿990 (BUSINESS). (Tasks 1, 2)
- [ ] A settled payment grants the tier for 30 days, extends a running cash term, and with `PRESERVE_TRIAL_ON_CONVERT=1` keeps unused trial days. Payment PAID with periodDays 30, `billingPeriod` monthly. (Task 1 test + Task 6 smoke)
- [ ] With the flag off, every surface behaves exactly as before, except the ungated BUSINESS renew fix. With the flag on and a tier's price missing, that tier has no monthly PromptPay. (Tests in Tasks 1–4)
- [ ] A card checkout that returns cancelled shows the PromptPay banner and a one-click checkout for the same plan and period, tracked as `cancel_return_promptpay`. (Task 2)
- [ ] A user whose subscription Stripe reports past_due/unpaid and who pays PromptPay ends with that subscription canceled and its open invoices voided. Retries and crashes recover it, and a failure alerts admins without rolling back the term. (Task 3 + Task 6 step 2)
- [ ] A 30-day term gets only d3/d1 renewal reminders with 30-day copy and a PromptPay-preselected link. Past-due notices and the banner offer PromptPay per Copy. BUSINESS prepaid buyers can renew. (Tasks 2, 4)
- [ ] Affiliate metadata on a PromptPay monthly session equals card monthly's, and hero-affiliate crediting is checked. (Task 1 + Task 6 step 4)
- [ ] All new and changed verify scripts run in CI via `verify:promptpay-monthly` and the existing steps. `tsc` and lint exit 0. PR CI is green. (All)
- [ ] Smoke test passed on prod, then was refunded and reverted. Rollback steps are in the PR. (Task 6)
- [ ] Day-14 and day-45 measurement reports are delivered. (Task 7)

## Out of scope
- Clip-cap CTA on the classic video-creator page (separate small job).
- Nudging PromptPay buyers to switch to card auto-renew.
- Founding offer on monthly (stays annual-only).
- Blocking a past_due user from starting a second **card** subscription (pre-existing gap).
- Stripe-side price verification for one-time sessions in the webhook. The one-time branch trusts server-set metadata, as annual one-time already does.
- Renewal reminders for **stacked** terms (bought more than 7 days early): pre-existing `TERM_START_TOLERANCE_MS` gap. Measure in Task 7 before fixing.
- Making `invoice.paid` keep `max(planExpiresAt, periodEnd)`. Covered operationally by the auto-cancel's Stripe-status check and the admin alert.
- Changes to the external hero-affiliate service.

## Status
interviewed 2026-10-04 | approved: 2026-10-04 (Mew) | executed: Tasks 1–4 2026-10-05 (branch reviewed, security-reviewed, local full CI green); Task 6 in progress | delivered: -
