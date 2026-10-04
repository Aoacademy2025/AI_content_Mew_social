---
status: accepted
---

# Monthly plans can be paid by PromptPay as a 30-day prepaid term

Monthly plans used to be card-only, because PromptPay cannot back a recurring Stripe subscription. Measured on 2026-10-04: monthly card checkouts completed 6 times out of 34, 61 of 65 failed charges in 60 days were on prepaid Thai cards (mostly `insufficient_funds`), and 6 of 12 lost card-on-file trials failed at their first charge. Customers wanted to pay and had no card that worked. So each paid tier also sells a one-time PromptPay **30-day prepaid term** at the same price as the card monthly plan. The term uses the same activation path as the PromptPay annual term: unused trial days are kept and a running term is extended. A buyer is a Paid-Equivalent user, not a Recurring Subscriber. They count toward MAPC but not toward the Trial Conversion Rate, and they renew by buying again after a d3/d1 renewal reminder.

## Considered Options

- **Keep monthly card-only and only improve decline messaging.** Rejected: the failing cards are prepaid cards with low balances, and better copy does not give those customers a working way to pay.
- **Price PromptPay monthly above card to steer people toward auto-renew.** Rejected: it would penalise exactly the customers who have no working card.

## Consequences

- Card stays the default on the monthly toggle, so customers with a working card still become Recurring Subscribers.
- A past-due subscription is canceled in Stripe when the same customer completes a PromptPay purchase. Otherwise Stripe's retries could charge them a second time once their card has funds.
- Affiliates earn on every paid PromptPay month, the same as every card monthly invoice.
- The share of new payers who are Recurring Subscribers may fall. Read MAPC and the Prepaid Base together with the Recurring Base.
