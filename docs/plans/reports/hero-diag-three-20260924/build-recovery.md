# Build recovery for the HERO-10 / HERO-41 / HERO-51 release

Date: 2026-09-24 (Asia/Bangkok)

## Delivery record

- Base: `origin/main` at `bf0fbf82cfde823dbcf146872be1817ec3a6fb00`
- Worktree: `/Users/mewsocialmacmini/orca/workspaces/AI_content_Mew_social/hero-build-worker-recovery-20260924`
- Branch: `codex/hero-build-worker-recovery-20260924`
- Head: `e5b6b303bf8297c61e9957f9958245b355f54aa4`
- Pull request: [#546 — fix(build): unblock HERO-10/41/51 release](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/546)
- PR outcome: merged by `mewic` at `2026-09-24T07:11:50Z` after CI passed on the exact PR head.
- Merge commit: `fdc4b984a64592a15f35821023d7dbdb8655f2f9`
- Exact-main CI: [run 35968319517](https://github.com/Aoacademy2025/AI_content_Mew_social/actions/runs/35968319517), in progress when this report was finalized.

## Incident and root cause

The first production deployment attempt compiled in about 7.5 minutes with a 4096 MB parent V8 heap and 512 MB worker heap, but the build process tree exceeded 22 GB RSS while host available memory fell to about 1 GB. The operator terminated only the build before the staged output swap. The old application remained live. A second attempt with a 3072 MB parent heap ended in V8 heap OOM.

The installed Next 16.3 source proves the control-path defect:

- `next/dist/build/index.js` selects `useBuildWorker=false` when a custom webpack hook exists unless `experimental.webpackBuildWorker` is explicitly true.
- The existing application config has a custom webpack hook for native/WASM handling, so the documented default worker did not apply.
- The non-worker path calls `webpackBuildImpl` in the long-lived build process.
- The worker path in `next/dist/build/webpack-build/index.js` runs the server, edge-server, and client compilers serially in distinct one-worker processes and calls `worker.end()` after each compiler.

This establishes why the intended compiler isolation was disabled and how the selected flag changes the build lifecycle. The production observation establishes a memory-related release blocker, but it does not attribute the 22 GB peak to a specific compiler, the parent process, filesystem tracing, or concurrent host load. The fix therefore does not claim a guaranteed production peak.

Next's bundled documentation also identifies `experimental.webpackBuildWorker: true` as the supported opt-in when a custom webpack configuration is present: <https://nextjs.org/docs/app/guides/memory-usage#webpack-build-worker>.

## Change

`next.config.ts` now sets `experimental.webpackBuildWorker: true` with a comment explaining why the opt-in is required. It retains:

- `experimental.cpus: 1` and `workerThreads: false`;
- production TypeScript checking;
- Sentry's wrapped webpack hook;
- the existing native server externals;
- WASM and text webpack rules;
- runtime render/stock trace exclusions;
- the existing upload proxy setting and every deployment gate.

`scripts/verify-build-worker-config.ts` resolves the production config through Next's config loader, then executes the Sentry-wrapped webpack hook. It verifies worker isolation and the constraints above through the resolved configuration and rule behavior rather than source-text matching. CI runs this regression before the existing application checks.

No schema, provider budget, application behavior, media-isolation routine, dependency, or deployment script changed.

## TDD evidence

RED on exact main, before the config edit:

```text
AssertionError [ERR_ASSERTION]: production webpack compilers must run in isolated workers
+ actual - expected

+ undefined
- true
```

GREEN after the one-flag change:

```text
PASS isolated webpack compiler and wrapped build config contract
```

## Verification

Passed:

- GitHub CI Build [run 35967039226](https://github.com/Aoacademy2025/AI_content_Mew_social/actions/runs/35967039226) on exact head `e5b6b303bf8297c61e9957f9958245b355f54aa4`
- `npm run verify:build-worker-config`
- `npx tsc --noEmit`
- `npm run verify:upload-proxy-limit`
- `npm run verify:deploy-maintenance`
- `npm run verify:deploy-render-gate`
- `npm run verify:deploy-health-rollback`
- `bash -n deploy/deploy.sh`
- `npx tsx scripts/verify-output-file-tracing.ts .next`

The tracing verification confirmed that the completed build contains no traced runtime render/stock media while other public assets remain traceable.

## Secret-free production-shaped build

The successful local build used:

```text
DATABASE_URL=file:./ci.db
BUILD_HEAP_MB=4096
BUILD_WORKER_HEAP_MB=512
BUILD_NO_LINT=1
NEXT_DISABLE_ESLINT=1
CI=true
npm run build
```

Orca had copied an ignored `.env` into the new worktree. An initial attempt was stopped after 19.87 seconds when Next reported loading that file. Its partial generated output was moved out of the way. For the counted build, the file was temporarily disabled, the shell contained no provider/Sentry/database secret variables, and a trap restored the file afterward. The build emitted the expected no-Sentry-token warnings and performed no release upload.

Result:

- exit code: 0;
- wall time: 73.28 seconds;
- webpack compile: 31.4 seconds;
- TypeScript: 15.3 seconds;
- static generation: 193 pages with one worker;
- build ID: `Q6Z9oHsn81qv5vBIiEDBW`;
- diagnostics: `.next/diagnostics/build-diagnostics.json` recorded `"useBuildWorker": "true"`;
- worker evidence: separate server, edge-server, and client worker profile files were emitted;
- sampled process-tree peak: 3,690,608 KiB RSS (about 3.52 GiB), dominated by the active compiler worker at 3,493,200 KiB;
- `/usr/bin/time -lp` maximum resident set size: 3,946,708,992 bytes (about 3.68 GiB);
- swaps: 0.

The local build ran with Node 26.7.0 on macOS, unlike the production Linux host. These numbers prove local worker compatibility and provide bounded resource evidence, but they are not a production capacity guarantee.

## Remaining gates

Do not merge or deploy solely from this report. Required next gates are:

1. Exact-main CI green for merge commit `fdc4b984a64592a15f35821023d7dbdb8655f2f9`.
2. Separately authorized production deployment through the existing CI, render-drain, hidden-media, staged-build, empty-queue, health, and rollback gates.
3. During that deployment, measure the build process tree and host available memory. Treat the production peak as unknown until that evidence exists.

Rollback is a revert of `e5b6b303` if the custom webpack/Sentry pipeline proves incompatible with isolated compiler workers.
