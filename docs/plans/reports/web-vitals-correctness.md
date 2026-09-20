# HERO-36 — Correct Web Vitals collection

## Scope and base

Base: `origin/main` at `b9d0d574b0ae71e99cdf3aaaca5889ed1cf55f43`.

This changes only browser Web Vitals collection and the Insights presentation of those metrics. It adds the maintained, pinned `web-vitals@6.2.2` collector; no schema, Prisma diagnostic, support, production, or deployment action is included.

## TDD evidence

The pre-change RED check was:

```text
npx tsx -e '...createWebVitalsAccumulator()...'
Error: expected zero CLS and largest 0.12 session window; got zero=undefined window=0.16
```

It demonstrates the two audited defects with independent literal expectations: zero CLS was omitted and separate shift values were summed. The retained behavioral check then passes: zero CLS emits once; unchanged lifecycle reports do not duplicate it; an updated document metric collapses to its newest value; historical proxy rows do not enter the corrected baseline; and initial document-path attribution remains pinned.

Review fix round 1 added a second RED check: two newest-first update rows for the same LCP metric with equal `reportedAt: 100` originally resolved to the older `1,000 ms` value. Aggregation now preserves the first row on an equal timestamp, so the newer `2,000 ms` value remains authoritative.

## Change

- `onCLS`, `onINP`, and `onLCP` from the official library own browser metric semantics, including CLS session windows, INP interaction selection, BFCache, and ongoing lifecycle reports.
- The small adapter transmits only metric data: metric name/value, version, opaque metric/document IDs, navigation type, document path, and monotonic report time. It sends zero values and suppresses an unchanged callback.
- Insights accepts only `metricVersion: web-vitals@6.2.2` and reduces update rows by session + metric + official metric ID. Existing records remain historical proxies and are excluded.
- The admin panel labels the corrected baseline, shows the version and sample counts, and says when there are no corrected samples. It does not certify a production baseline before deployment.

## Validation

- RED: `npx tsx -e ...createWebVitalsAccumulator...` — failed as recorded above.
- GREEN: `npx tsx scripts/verify-insights-data-quality.ts` — 15 passed, including the equal-timestamp update case.
- `npm run verify:admin-number-telemetry-window` — 67 passed; the checked-in golden was deliberately re-recorded from this version because the versioned baseline payload intentionally changes.
- `npx tsc --noEmit` — passed.
- `npm run build` — passed; Next produced `.next/BUILD_ID`.

## Caveats and handoff

The production baseline begins only after a separate deployment and real browser traffic; existing proxy p75 values must not be compared with the new collector. Browser APIs still cannot include cross-origin iframe shifts, a documented Web Vitals limitation. No production access, write, deploy, ticket update, or customer data was used.

Proposed PR title: `fix(telemetry): measure HERO-36 Web Vitals with the official collector`

Proposed PR body: Replace the custom CLS/INP proxy accumulator with pinned `web-vitals@6.2.2`, emit versioned document metric updates including zero values, and aggregate only the latest corrected update per document metric. Insights now keeps the historical proxy records out of the corrected baseline and labels the new baseline until post-deploy samples exist.
