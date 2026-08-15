# ADR 0008: Subscription-first AI feature access and measurement

Status: accepted
Date: 2026-08-13

## Decision

Hero AI Image, Hero AI Script, and Brand Visual use one subscription-first
commercial policy.

Full product access is granted to a Paid-Equivalent Entitlement: an active
PRO or BUSINESS subscription, paid Bundle, active course/program GRANT coupon,
or explicit Administrator Grant. An Administrator Grant requires an audited
reason, target plan, expiry date, or an explicit permanent choice. A raw stored
plan label is not entitlement evidence by itself.

FREE users do not receive full access. A seven-day Conversion Trial receives
one lifetime allowance of eight successfully delivered Hero AI Images per
protected account/email identity. Failed or undelivered generations restore
the allowance. Unused images expire with the trial and the allowance never
renews every 30 days. Hero AI Script remains a Locked Feature Preview for a
Trial account unless that account also holds a Paid-Equivalent Entitlement.

Locked features remain visible and clickable. They explain the value and the
paid requirement, then lead to monthly or annual pricing; paid API actions
continue to fail closed until a qualifying entitlement exists.

The product North Star is Monthly Active Paying Creators (MAPC): unique active
monthly or annual recurring customers with at least one Core Creation Outcome
in the trailing 30 days. A Core Creation Outcome is a completed video, a saved
or Editor-bound Hero Script, or a usable customer-requested Hero AI Image.
Admin/team work, page views, previews, failed jobs, and system retries do not
qualify. Course coupons and Administrator Grants are tracked as conversion
cohorts but do not enter the recurring-paying numerator.

Insights presents MAPC as the primary metric. The existing signup-to-first-video
metric remains as a supporting Activation Funnel. Every specialized metric has
plain-language Metric Help covering its formula, window, denominator, cohort
inclusions/exclusions, and authoritative source, accessible by hover, keyboard,
and mobile tap.

## Why

The business goal is recurring monthly and annual subscriptions. A bounded
trial should prove the quality of a real outcome without becoming an ongoing
free image subsidy. Course students and intentionally granted accounts have
already exchanged value outside the direct subscription checkout and should
receive the capabilities promised to them, while retaining a distinct source
for conversion and revenue analysis.

MAPC joins payment with realized product value. Raw subscriber count can hide
dormant or soon-to-churn customers, while raw generation counts can be inflated
by retries, failures, internal QA, or free usage.

## Consequences

- Hero AI Image and Hero AI Script must resolve the same Paid-Equivalent
  Entitlement instead of relying on `plan` alone or separate feature rules.
- Existing recurring 30-day starter allowance semantics must migrate to a
  lifetime, trial-bounded allowance without reissuing consumed images.
- Admin grant flows need durable source, reason, expiry/permanent choice, and
  audit fields.
- Insights needs server-authoritative MAPC and conversion-funnel queries plus
  accessible metric explanations.
- Trial-to-subscription conversion, monthly/annual mix, retention, failures,
  refunds, and AI cost remain supporting metrics and launch guardrails.

## Alternatives rejected

- **Cash-payment records only:** excludes paid course students and other valid
  off-checkout commercial entitlements.
- **Any PRO/BUSINESS plan label:** unintentionally admits Trial and stale or
  accidental manual plan changes.
- **Eight free images every 30 days:** creates a renewable subsidy that weakens
  the subscription conversion boundary.
- **Hide unavailable features:** removes the product preview and upgrade moment.
- **Use signup or raw subscriber count as the North Star:** measures acquisition
  or billing without proving ongoing customer value.
