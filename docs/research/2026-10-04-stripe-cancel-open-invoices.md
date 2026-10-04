# Stripe: cancel a past-due subscription and stop its open invoices

Research for `docs/plans/2026-10-04-promptpay-monthly.md` Task 3 (ADR 0066). The question: when a customer whose card subscription is `past_due`/`unpaid` pays a PromptPay term instead, what must we call so Stripe cannot charge that subscription again?

Pinned versions this repo uses:
- `stripe` npm package **22.1.1** (`node_modules/stripe/package.json`)
- API version **`2026-04-22.dahlia`**: `src/lib/stripe.ts:25` (`new Stripe(key, { apiVersion: "2026-04-22.dahlia" })`) and `node_modules/stripe/cjs/apiVersion.d.ts`

Sources were read on 2026-10-04. Every claim below names its source.

## Findings

### 1. Cancel endpoint and its no-proration, no-final-invoice params

- The endpoint is `DELETE /v1/subscriptions/{id}`, called as `stripe.subscriptions.cancel(id, params?)`. It "Cancels a customer's subscription immediately. The customer won't be charged again for the subscription." Source: https://docs.stripe.com/api/subscriptions/cancel and `node_modules/stripe/cjs/resources/Subscriptions.d.ts:18-25`.
- `invoice_now` (boolean): "Will generate a final invoice that invoices for any un-invoiced metered usage and new/pending proration invoice items. Defaults to `false`." Source: https://docs.stripe.com/api/subscriptions/cancel and `Subscriptions.d.ts:2433-2435`.
- `prorate` (boolean): "Will generate a proration invoice item that credits remaining unused time until the subscription period end. Defaults to `false`." Source: same page and `Subscriptions.d.ts:2436-2439`.
- With an immediate cancel, "pending prorations are removed if `invoice_now` and `prorate` are both set to false." Source: https://docs.stripe.com/api/subscriptions/cancel.
- **So the exact call is `stripe.subscriptions.cancel(subId, { invoice_now: false, prorate: false })`.** Both values are already the defaults. We still pass them explicitly, so the intent is visible and a future default change cannot slip a final invoice in.
- The cancel returns the subscription with `status: "canceled"` and emits `customer.subscription.deleted`. Source: https://docs.stripe.com/api/subscriptions/cancel ("Returns") and https://docs.stripe.com/billing/subscriptions/cancel ("Identify cancellation events").

### 2. What canceling does to open invoices and Smart Retries

- From the API reference: "By default, upon subscription cancellation, Stripe stops automatic collection of all finalized invoices for the customer … However, you can resume automatic collection of the invoices manually after subscription cancellation to have us proceed." Source: https://docs.stripe.com/api/subscriptions/cancel.
- From the billing guide: "When you cancel a subscription, all `open` and `draft` invoices for that subscription have their `auto_advance` property set to `false`. This pauses automatic collection for these invoices and prevents automatic reminder emails from sending. **You can still manually attempt to collect payment** and send emails." Source: https://docs.stripe.com/billing/subscriptions/cancel ("Handle invoice items when canceling subscriptions").
- With `auto_advance = false`, these features are **Not enabled**: "Retries (email and charge)", "Attempting payments for auto-charge invoices", and "Finalize draft subscription invoices to open". Source: https://docs.stripe.com/invoicing/integration/automatic-advancement-collection ("Automatic advancement feature comparison").
- **Conclusion:** cancel alone stops Smart Retries for that subscription's invoices, but the open invoices stay `open`, so they are still payable. Three ways they can still be paid:
  - The customer pays on the hosted invoice page. It lets customers "Pay the invoice using any of the enabled payment methods". Its URL stays valid up to 30 days after the due date or finalization, and never longer than 120 days. Source: https://docs.stripe.com/invoicing/hosted-invoice-page.
  - Someone attempts payment manually (Dashboard "Charge customer", or `POST /v1/invoices/{id}/pay`). Source: https://docs.stripe.com/invoicing/overview ("Paid invoices").
  - Someone turns automatic collection back on. Source: https://docs.stripe.com/api/subscriptions/cancel.
- Stripe's failed-payment emails link to a separate Stripe-hosted update-payment page. That link is invalidated when "The subscription status changes to `cancelled`, `incomplete_expired`, or `unpaid`". Source: https://docs.stripe.com/billing/revenue-recovery/customer-emails ("Link to a Stripe-hosted page"). This does **not** cover the hosted invoice page URL above.

### 3. Voiding an open invoice stops collection for good

- `POST /v1/invoices/{id}/void`, called as `stripe.invoices.voidInvoice(id)`: "Mark a finalized invoice as void. This cannot be undone." Source: https://docs.stripe.com/api/invoices/void and `node_modules/stripe/cjs/resources/Invoices.d.ts:96-101`.
- "Voided invoices are treated as zero-value for reporting purposes, and **aren't payable**. This status is terminal, which means that the invoice's status can never change." Also: "You can only void an invoice in `open` or `uncollectible` status." The hosted page of a voided invoice "displays a message indicating that the invoice has been voided". Source: https://docs.stripe.com/invoicing/overview ("Void invoices").
- The status table lists the possible actions for `void` as "No further actions". Source: https://docs.stripe.com/invoicing/overview ("Invoice statuses").
- `paid`, `void` and `uncollectible` invoices "always have automatic advancement turned off". Source: https://docs.stripe.com/invoicing/integration/automatic-advancement-collection.

### 4. Why "mark uncollectible" is wrong here

- For an `uncollectible` invoice, the possible actions are "Change the invoice's status to `void` or `paid`". So an uncollectible invoice can still be paid. Source: https://docs.stripe.com/invoicing/overview ("Invoice statuses").
- That is why rule (c) of the plan forbids it. The helper never calls `invoices.markUncollectible`.

### 5. Listing a subscription's open invoices

- `GET /v1/invoices?subscription={sub}&status=open`, called as `stripe.invoices.list({ subscription, status: "open", limit })`:
  - `subscription`: "Only return invoices for the subscription specified by this subscription ID."
  - `status`: one of `draft`, `open`, `paid`, `uncollectible`, `void`.
  - `limit`: "can range between 1 and 100, and the default is 10".
  - Pagination uses the `starting_after` cursor.
  - Source: https://docs.stripe.com/api/invoices/list and `Invoices.d.ts:2421-2455`.
- In stripe-node, `ApiListPromise<T>` extends `AsyncIterableIterator<T>`, so `for await (const inv of stripe.invoices.list(...))` auto-paginates past the first page. Source: `node_modules/stripe/cjs/lib.d.ts:195-200`.

### 6. Subscription statuses the helper acts on

- `past_due`: "If subscription `collection_method=charge_automatically`, it becomes `past_due` when payment is required but cannot be paid … Once Stripe has exhausted all payment retry attempts, the subscription will become `canceled` or `unpaid` (depending on your subscriptions settings)." Source: https://docs.stripe.com/api/subscriptions/object (`status`).
- `unpaid`: "no subsequent invoices will be attempted (invoices will be created, but then immediately automatically closed). After receiving updated payment information from a customer, you may choose to reopen and pay their closed invoices." Source: same.
- In the revenue-recovery settings, "Mark the subscription as unpaid" means "Invoices continue to be generated and stay in a draft state", and "Leave the subscription past-due" means "Invoices continue to be generated and charge the customer based on retry settings". Source: https://docs.stripe.com/billing/revenue-recovery/smart-retries ("Custom retry schedule").
- So an `unpaid` subscription can still hold an earlier `open` invoice that is payable by hand, which is why the helper also cancels and voids for `unpaid`.

## What the helper therefore does (rule (c))

1. `stripe.subscriptions.retrieve(subId)`. Act only if `status` is `past_due` or `unpaid`.
2. `stripe.subscriptions.cancel(subId, { invoice_now: false, prorate: false })`. Cancel goes first because it turns off `auto_advance` on every open and draft invoice of the subscription at once, which stops Smart Retries immediately (§2).
3. `for await (inv of stripe.invoices.list({ subscription: subId, status: "open", limit: 100 }))`, then `stripe.invoices.voidInvoice(inv.id)`. This makes every open invoice terminal and unpayable (§3).
4. Draft invoices are not voided. They cannot be voided (§3: only `open`/`uncollectible` can), and after the cancel nothing finalizes them automatically (§2).

## Known limits and open questions

- **`uncollectible` invoices are left alone.** Rule (c) says "voids every open invoice". An invoice that Stripe's retry settings already moved to `uncollectible` is still payable (§4), but nothing auto-collects it, since `auto_advance` is off for that status (§3). Voiding those too would close the last manual path. This is not done, because the spec scopes the void to `open`. **It is flagged for the reviewer.**
- **Docs-only proof.** None of this was run against Stripe. Plan Task 6 step 2 (a test-clock subscription in test mode) is where the cancel+void sequence gets proven end to end. Record the result here when it runs.
- **Pre-existing invoice items.** Any pending invoice items on the customer are "still charged at the end of the period" if another subscription invoices them. Source: https://docs.stripe.com/api/subscriptions/cancel. The Studio checkout does not create standalone invoice items, so nothing to do.
