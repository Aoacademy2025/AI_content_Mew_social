# Studio remediation integration — 2026-10-11

## Review target and scope

Source/test/package review target: `057cea77d83e997ccdbbb41fd5c97fa5fd0722e0`.
Baseline: `149efd9647911821ba90f1eede601e141afb2f67`.
Branch: `mewic/studio-fixes-integrated-20261011`.
Worktree: Orca `studio-fixes-integrated-20261011`. Root checkout unchanged.

Integrated source commits: `c0eafd7558eadf866244d7cbdc3e7cda81ec4861`, `a1839b4b2729588cc945d49a18b8e1525059c60d`, `efef6da1fe250e4b1e4aaa8d14979ea168fb2d66`, cherry-picked as `60684483`, `a0c3d255`, `88c7880c`.

- HERO-72 reliability: fill generated one-frame gaps; accept unchanged, frame-aligned legacy gaps during unrelated edits while retaining source/bounds/overlap guards.
- HERO-77 reliability: handle known browser transport rejections for the optional conversion lookup, allowing later clip events to retry; retain unrelated application/JSON errors.
- HERO-78 observability only: classify local SQLite scene failures as `DB_CONTENTION`; true provider polling errors, retry policy, generation, credits/refunds and billing remain unchanged.
- HERO-46 remains unresolved: the enhanced real editor harness does not reproduce maximum-depth under the tested delayed-autosave/input sequence.
- Underlying SQLite contention (HERO-10/HERO-70) remains unresolved by this branch. No SQLite behavior, billing, subtitle policy, schema, or support operation change is included.

## Integration changes and CI contract

`package.json` appends the real browser regression to `verify:first-clip-convert` and the scene taxonomy regression to `verify:hero-image-scene-retry`. Existing CI already invokes both. The B-roll regression is imported by the existing boundary-drift test and reaches CI through window-management. Existing CI also runs the expanded editor script probe. No workflow or dependency/lock changes were needed.

The repository has no pre/post lifecycle scripts for either changed verification command and no prebuild/postbuild hooks. CI runs `npm ci` without ignoring lifecycle scripts; installed Puppeteer 25.6.0 has a browser-install `postinstall`, and the workflow has no browser-download skip flag. Existing CI browser suites use that installation. Node 22/Ubuntu CI remains the cross-platform verification gate; local execution used Node 26.7.0/macOS.

Puppeteer 25.6.0 `executablePath()` returns a Promise. The new recovery harness's non-macOS branch originally passed that Promise to launch. A temporary copy forcing the managed-browser branch failed **exit 1**, `Browser was not found at the configured executablePath ([object Promise])`. Adding the missing `await` passed the full recovery probe **exit 0** through that same branch. Temporary copies were removed. Normal macOS suite execution also passed. This tests managed browser-path resolution locally, not an actual Linux machine.

Dependencies reuse the existing ignored cache via a symlink after `package-lock.json` byte comparison succeeded (exit 0). No install, Prisma client generation, or mutation of shared dependencies occurred. Orca copied an ignored local environment file; it was moved aside in this owned worktree. The final build ran without that file and with a dummy SQLite URL. The initial build also passed; `SENTRY_AUTH_TOKEN` was explicitly empty from its start, and all three Sentry compiler messages said no token/no release. No source-map upload attempt or success was logged.

## Verification evidence

All following integrated suites returned **exit 0**. Each used synthetic fixtures/local databases, without provider generation or customer media:

| Command | Exit |
|---|---:|
| `npm run verify:broll-timeline` | 0 |
| `npm run verify:broll-coverage` | 0 |
| `npm run verify:broll-rerender` | 0 |
| `npm run verify:broll-window-management` | 0 |
| `npm run verify:first-clip-convert` | 0 |
| `npm run verify:hero-image-scene-retry` | 0 |
| `npm run verify:hero-image-scene-coverage` | 0 |
| `npm run verify:ai-image-reconcile` | 0 |
| `npm run verify:runpod-image-cost` | 0 |
| `npm run verify:hero-image-price` | 0 |
| `npm run verify:editor-script-loop` | 0 |
| `npm run verify:editor-script-loop-sensitivity` | 0 |
| `npm run verify:partial-alignment` | 0 |
| `npm run verify:acoustic-subtitle-clock` | 0 |
| `npm run verify:build-worker-config` | 0 |

Additional checks:

- Initial `tsc --noEmit --incremental false`: **exit 0**. The application tsconfig excludes scripts, so the browser-path issue above required runtime coverage.
- Final sequential `tsc --noEmit --incremental false`: **exit 0**, after the completed build; no diagnostics.
- Initial `DATABASE_URL=file:/tmp/hero-studio-integration-build.db NEXT_TELEMETRY_DISABLED=1 SENTRY_AUTH_TOKEN= npm run build`: **exit 0**.
- Final environment-isolated `DATABASE_URL=file:/tmp/hero-studio-integration-build.db NEXT_TELEMETRY_DISABLED=1 SENTRY_AUTH_TOKEN= CI=true npm run build`: **exit 0**, compiled, typechecked, prerendered 193 pages and completed build tracing.
- ESLint changed regression scripts and B-roll helpers: **exit 0**.
- Scoped ESLint across all touched scripts/application files: **exit 1**, only the unchanged conversion armed-session effect (`react-hooks/set-state-in-effect`, integrated line 121) plus two pre-existing route warnings. Exact baseline component piped to ESLint: **exit 1**, same rule/expression at baseline line 114: `setExportedViewShown(true)`. No waiver or unrelated lint cleanup introduced.
- One typecheck started concurrently with the second build: **exit 2**, `TS6053: File .../.next/types/app/(auth)/forgot-password/page.ts not found` (and other generated paths). Next had removed/regenerated those outputs. This was a verification scheduling error; the check was rerun sequentially after the build, without source edits.
- `git diff --check`: **exit 0**.

Raw local logs are ignored under `artifacts/studio-integration/`; this report carries the sanitized durable evidence. Full remote CI has not run yet; do not describe the entire CI workflow as passed based on these scoped local checks.

## PR-ready description

Suggested title: **Fix generated B-roll gaps and first-clip lookup recovery; classify local image failures**

Generated B-roll windows can contain an accepted one-frame gap that blocks unrelated timing edits. Fill new generated gaps and permit only unchanged frame-aligned legacy gaps while preserving source and boundary validation. Optional first-clip conversion lookups now recover from known browser network failures and can retry on later events.

Separately, image-scene telemetry now labels local SQLite contention as `DB_CONTENTION` instead of provider polling failure. This is a taxonomy correction; it does not fix underlying SQLite contention or change retries, credits, refunds, or costs. HERO-46's editor depth issue also remains unresolved; its expanded bounded browser probe passes without reproducing the incident.

Validation: 15 integrated regression suites, full application types and production build, targeted lint; disclose the unchanged baseline conversion lint finding. New regressions are included in existing CI commands. No deployment, restart, merge or production support operation is part of this PR.

## Release status

Independent source reviews and final integrated correctness/security reviews are **PASS** with no blocking findings for `e18347411307e6b38abb93544c67e760190d97f7`. The two final review reports are stored beside this report. Only documentation changed after that reviewed source/test/package target; full suites were not repeated for report-only edits.

The correctness review records a low-priority harness cleanup advisory: a browser launch rejection occurs before the new test's HTTP server enters its cleanup scope. Track this as test infrastructure follow-up; no source expansion was included for this nonblocking observation.

Publication is authorized after those PASS gates: create a draft PR and leave Node 22/Linux CI as the remote gate. No merge, deployment, restart, or production write is authorized by this publication step.
