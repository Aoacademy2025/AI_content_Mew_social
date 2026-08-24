# Quota / credit production audit — 2026-07-22

## Implementation follow-up — 2026-07-23

The UI fix is now implemented locally and protected by
`npm run verify:quota-credit-ui`:

- the compact editor status explicitly labels the first meter `โควต้านาที`;
- it independently fetches `/api/credits/balance` and shows `เครดิต AI` beside it;
- the credit value links to the detailed Billing balance;
- both balances refresh when the browser window regains focus or the tab becomes visible,
  so an admin/manual top-up no longer requires a full reload.

The accounting model remains unchanged. Fresh isolated database suites passed 34 monthly
grant checks, 39 general credit checks, 9 minute-overflow checks, 52 refund/bucket checks,
15 minute-enforcement checks, and 12 plan-limit checks. Production was not mutated and
the `duckyhero` balance did not require an adjustment.

A final read-only production recheck after the UI implementation still found 53 ledger
rows, a net balance of 1,048, zero running-balance mismatches, 48 granted credits and
1,000 purchased credits. The minute meter also remained 134/150 used (16 remaining).

## Outcome

The `duckyhero` top-up is present and the credit ledger reconciles exactly. The
`16/150 นาที` badge is also numerically correct, but it is a different balance:
the remaining monthly render-minute quota. The current UI puts the minute badge
near the editor while showing AI credits only in Settings > Billing, which makes
a successful credit top-up look as if it did not change the badge.

No production balance repair was required or performed.

## Production evidence

Account: `du***@gmail.com`, BUSINESS plan.

| Meter | Production value |
| --- | ---: |
| Render minutes used | 134 |
| Monthly render-minute limit | 150 |
| Render minutes remaining | 16 |
| Monthly granted AI credits remaining | 48 |
| Purchased AI credits remaining | 1,000 |
| Total AI credits remaining | 1,048 |

The ledger has 53 rows and its running balance matches every stored
`balanceAfter` value with zero inconsistencies:

- monthly BUSINESS grant: `+150`;
- manual purchased-credit top-up on 2026-07-22 13:21 ICT: `+1,000`;
- 51 managed AI-image spends at two credits each: `-102`;
- reconciled balance: `150 + 1,000 - 102 = 1,048`.

The top-up row itself committed with `balanceAfter=1,128`. Subsequent image
generation continued to drain the granted bucket first, as designed; the
purchased bucket is still exactly 1,000.

## Why the screenshot did not increase

`QuotaStatus` fetches `/api/videos/usage` and renders
`minutes.remaining/minutes.limit`. With `MINUTE_QUOTA=1`, the screenshot is
therefore calculated as `150 - 134 = 16` minutes.

Credits use a separate endpoint, `/api/credits/balance`, and are displayed by
`CreditsBillingSection` under Settings > Billing. Buying or manually granting
credits intentionally does not change `minutesUsed` or `minutesLimit`. Once the
monthly minutes are exhausted, render overflow can consume AI credits at two
credits per minute.

There is one additional refresh limitation: `CreditsBillingSection` fetches on
mount and after its own Stripe `?credits=success` redirect, but it does not poll
or listen for an admin manual-credit event. A tab that was already open while a
team member added credits can therefore retain its old client-side number until
the user reloads or re-enters Billing. This does not affect the server balance.

## Verification

- Production flags: `MINUTE_QUOTA=1`, `CREDITS_LIVE=1`.
- Production database read-only reconciliation: 53/53 ledger rows consistent.
- Credit monthly grant suite: 34 checks passed.
- Minute-to-credit overflow suite: 9 checks passed.
- Credit spend/refund/bucket suite: 52 checks passed.

## UX finding

The accounting logic is healthy, but the editor badge does not identify itself
as the monthly minute allowance and does not show the separate AI-credit total.
A follow-up UI change should label the badge `โควต้านาที` and surface a second
`เครดิต AI` balance near it (or link directly to Billing). The two balances must
remain separate; merging them into one number would be incorrect because they
reset and spend differently. The same follow-up should refresh the balance when
the tab regains focus so admin/manual top-ups appear without a full page reload.
