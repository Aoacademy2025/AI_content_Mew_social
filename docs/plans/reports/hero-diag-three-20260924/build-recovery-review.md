# Build recovery review

**Reviewed range:** `bf0fbf82cfde823dbcf146872be1817ec3a6fb00..e5b6b303bf8297c61e9957f9958245b355f54aa4`  
**Exact reviewed head:** `e5b6b303bf8297c61e9957f9958245b355f54aa4`  
**Scope:** correctness and security of the isolated production-webpack-worker recovery only. No production, customer-data, provider, SSH, merge, or deployment access was used.

## Verdict

**Approved: no blockers found.** The one production configuration change is scoped to enabling Next 16.3's documented `experimental.webpackBuildWorker` override. It preserves the existing serial/process-worker controls, custom webpack rules, Sentry wrapper, TypeScript checking, media trace exclusions, deployment safeguards, and runtime code because none of those production paths changed.

The conclusion is limited to the configuration mechanism. A resource-constrained full production build is still the required empirical confirmation that this recovery fits the target host; this review does not claim that the build's underlying memory cause is fully diagnosed.

## Correctness and specification

- `next.config.ts:44` sets `webpackBuildWorker: true` while retaining `workerThreads: false` and `cpus: 1` at `next.config.ts:46-47`. In the installed Next `16.3.0` implementation, a custom webpack hook otherwise disables the worker; a true override selects `webpackBuildWithWorker`. That implementation creates one child-process worker per `server`, `edge-server`, and `client` compiler and calls `worker.end()` after each. This matches the requested sequential compiler-memory release behavior.
- No changed app, runtime, schema, dependency, provider, maintenance, render-drain, health, or rollback code was found. The existing deployment staging/health rollback and operational scripts therefore remain intact.
- The new CI command is correctly placed after dependency installation and Prisma generation in `.github/workflows/ci.yml:35-36`. It loads the effective production config through `loadConfig(PHASE_PRODUCTION_BUILD)` and invokes the Sentry-wrapped webpack hook, rather than inspecting source text.
- `scripts/verify-build-worker-config.ts:12-24` rejects the base behavior: the base `next.config.ts` leaves `webpackBuildWorker` unset and Next's default is `undefined`, so the new strict assertion at line 13 would fail on the baseline. At the reviewed head, `npm run verify:build-worker-config` passed.
- The execution is deterministic and meaningful: it asserts the worker flag, serial/process controls, active type checking, media trace exclusions, selected native/server externals, both custom asset rules, and a Sentry `DefinePlugin` injection from the wrapped hook (`scripts/verify-build-worker-config.ts:12-72`). `git diff --check` also passed.

## Security

No security blocker found. The gate has no HTTP client, provider client, database access, credentials output, or customer-data input. It only evaluates the local Next configuration and an in-memory webpack configuration. The CI environment supplies no Sentry auth token, and the project's Sentry config has telemetry disabled; no network or provider call was observed during the bounded check.

## Advisory

1. **Non-blocking — partial external-package regression coverage.** `scripts/verify-build-worker-config.ts:26-40` asserts eight critical entries but not the complete existing `serverExternalPackages` contract (for example `puppeteer-core`, `@prisma/engines`, the platform-specific ffmpeg packages, and platform-specific esbuild packages). The reviewed diff preserves every entry, so this is not a current regression. If the intended CI contract is to protect all native externals named in the requirement, compare the resolved array with the full expected list or add the omitted entries.

## Checks run

- `git rev-parse HEAD` → `e5b6b303bf8297c61e9957f9958245b355f54aa4`
- `npm run verify:build-worker-config` → pass
- `git diff --check bf0fbf82cfde823dbcf146872be1817ec3a6fb00 e5b6b303bf8297c61e9957f9958245b355f54aa4` → pass

No full production build was run by this reviewer; the requested independent review was limited to the bounded configuration gate and source-level mechanism check.
