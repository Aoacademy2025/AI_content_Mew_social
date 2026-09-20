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

Review fix round 2 found that SQLite rows can also tie on `createdAt`, so first-row preservation alone was not deterministic. Its RED check supplied the same two LCP updates with equal `reportedAt` and equal `createdAt` in both orders; the pre-fix reducer selected `1,000 ms` for one order. The collector now assigns an increasing `reportSequence` only when it emits a changed value. The `web-vitals@6.2.2+report-sequence-v1` baseline requires a safe positive sequence and selects its greatest value, so both permutations retain `2,000 ms` regardless of database retrieval order.

## Change

- `onCLS`, `onINP`, and `onLCP` from the official library own browser metric semantics, including CLS session windows, INP interaction selection, BFCache, and ongoing lifecycle reports.
- The small adapter transmits only metric data: metric name/value, version, opaque metric/document IDs, navigation type, document path, report time, and a per-document changed-report sequence. It sends zero values and suppresses an unchanged callback.
- Insights accepts only `metricVersion: web-vitals@6.2.2+report-sequence-v1` and reduces update rows by session + metric + official metric ID using the causal sequence. Existing proxy and pre-sequence records remain outside this baseline.
- The admin panel labels the corrected baseline, shows the version and sample counts, and says when there are no corrected samples. It does not certify a production baseline before deployment.

## Validation

- RED: `npx tsx -e ...createWebVitalsAccumulator...` — failed as recorded above.
- GREEN: `npx tsx scripts/verify-insights-data-quality.ts` — 17 passed, including both equal-timestamp/equal-database-time orderings and missing-sequence rejection.
- `npm run verify:admin-number-telemetry-window` — 67 passed; its re-recorded 1/7/30-day golden payloads differ from the prior golden only in the six current/previous `web-vitals@6.2.2+report-sequence-v1` version labels.
- `npx tsc --noEmit` — passed.
- `npm run build` — passed; Next produced `.next/BUILD_ID`.

## Caveats and handoff

The production baseline begins only after a separate deployment and real browser traffic; existing proxy p75 values must not be compared with the new collector. Browser APIs still cannot include cross-origin iframe shifts, a documented Web Vitals limitation. No production access, write, deploy, ticket update, or customer data was used.

Proposed PR title: `fix(telemetry): measure HERO-36 Web Vitals with the official collector`

Proposed PR body: Replace the custom CLS/INP proxy accumulator with pinned `web-vitals@6.2.2`, emit versioned document metric updates including zero values, and aggregate only the latest corrected update per document metric. Insights now keeps the historical proxy records out of the corrected baseline and labels the new baseline until post-deploy samples exist.
