# Independent maintenance security review

**PASS for the reviewed maintenance delta; no material security blocker found.** Prior whole-branch security PASS at `24a7b170239a81fde00694bb30857c1f92db5e94` remains the baseline. This scoped review does not certify production or live providers.

- Production candidate: `1505b2e907cda1fb22fde90ad122159c101ad4fa`.
- Final reviewer head: `f6781c66f27b8b5a914e0ca9461708707a58e1be`, including preflight followup `5a141bb4` cherry-picked as `46a30ce8`, scene-harness followup `6a08095a` cherry-picked as `8975d5a6`, and upload-verifier invocation followup `7c41e149` cherry-picked as `f6781c66`. Production code remains `1505b2e9`.
- Reviewer: run 28/30, independently assigned Astra medium; no agents spawned.
- Worktree: `/Users/mewsocialmacmini/orca/workspaces/AI_content_Mew_social/mcp-maintenance-security`.

## Isolation

Removed Orca-copied `.env` and `.env.r2.production` without opening either before imports/setup. Initial `rm -f` was rejected; explicit Python `Path.unlink(missing_ok=True)` succeeded, exit 0. No policy was disabled. Compared Prisma schemas with `mcp-budget-task5` (identical, exit 0) before symlinking its installed dependencies. All application commands explicitly set `DATABASE_URL=file:/tmp/mcp-maintenance-security-unused.db`; database fixtures create separate disposable SQLite files. No production, providers, push, deployment, restart or customer communication occurred.

## Findings

1. The sole production delta since the prior security PASS is the public `create_video_job` callback in `src/app/api/[transport]/route.ts`. It awaits the existing service and translates only `instanceof RenderDeployDrainError` into the shared maintenance message, stable error/code, retryable flag and same-quote retry guidance. Nonmatching errors are rethrown into the unchanged outer database-busy/internal-error handling. No credentials, quote inputs or internal exception text are returned.
2. The authoritative drain check remains inside `createVideoJobInTransaction`, before reservation/job insertion. The enclosing quote-consumption transaction still claims the approved quote and creates its project transactionally. The catch sits outside the awaited service, so rejection and rollback complete before the public maintenance response. No refund, alternate enqueue, reservation, network call or mutable bypass was added. Existing tool audit recording remains the same wrapper behavior.
3. Owner lookup, immutable execution/input validation, approval and price/expiry checks, conditional claim, funding admission, ceiling checks and consumed-quote replay paths are unchanged. The public ordinary-USER fixture independently proved maintenance leaves the complete quote, wallet/funding, jobs and projects unchanged, then the same quote creates exactly one root after maintenance and replays its identity.
4. Compatibility fixture changes do not weaken security guards: editor exact-replay and base-render imports throw if unexpectedly reached; ffmpeg hardening loads real external-media policy and supplies Prisma-shaped empty collections. Onboarding assertions now match approved creation and all four sources. New maintenance assertions add behavior coverage. The preflight followup changes only the inspected file to the actual approved-consumption service, preserving the deterministic gate assertions.
5. No changes to image/render budget enforcement, receipt calculations, external source behavior, ownership or SSRF admission were found in the reviewed production delta. Independent quote and budget fixtures confirm owner/auth/approval and zero-spend preparation, immutable inputs, prices, expiry, entitlement revocation, races, descendants, trial funding, ambiguous exposure, duration top-up and replay protections remain operative.
6. The final scene-error harness followup injects the actual `VideoBudgetHoldError` class into its evaluated worker scope and adds an identity-preserving rejection assertion. This repairs the missing lexical dependency and strengthens proof that budget refusals reach approval handling unchanged; it removes no assertions or production guards. Its independent run passed.
7. Final package-only upload-verifier followup adds `--import next/dist/server/node-environment-baseline.js` before the unchanged `--conditions=react-server --import tsx scripts/verify-media-import-upload.ts`. Inspected the installed Next module: it provides Node's actual `AsyncLocalStorage` and a lazy WebSocket global when absent. It introduces no auth/funding/SSRF mock, exception swallowing, disabled condition, test skip or exit-code suppression. No dependency version, test source or production source changes. The exact upload test execution is delegated to the independent correctness reviewer; this security addendum claims targeted package/runtime-bootstrap inspection only. `git diff --check HEAD^..HEAD` exited 0.

## Independent verification

Runtime command prefix (each script below appended):

```sh
DATABASE_URL=file:/tmp/mcp-maintenance-security-unused.db node --import ./scripts/register-server-only-node.mjs --import tsx scripts/
```

| Script/check | Exit | Result |
|---|---:|---|
| `verify-mcp-video-quote.ts` | 0 | Owner/auth/expiry/input/price/zero-spend/presenter checks passed |
| `verify-mcp-budget.ts` | 0 | USER reproduction and atomic admission/budget/race/recovery checks passed |
| `verify-mcp-edit-draft.ts` | 0 | 130 passed, 0 failed; actual public maintenance rollback and same-approval replay included |
| `verify-render-plan-preflight.ts` | 0 | Followup source-location assertions and deterministic gate checks passed |
| `verify-hero-image-scene-error.ts` | 0 | Actual budget-hold identity propagates; existing scene error checks passed |
| `git diff --check 24a7b170..HEAD -- src scripts` | 0 | No source/test whitespace errors |
| `git diff --check 24a7b170..HEAD` | 2 | Archived `maintenance-regression-probe.patch:6` has trailing whitespace (`+ `); advisory documentation artifact only |

Logs: adjacent `maintenance-security-evidence/`. First three runtime checks ran at `1505b2e9`; each followup check ran after its test-only cherry-pick. No verification failure was suppressed or assertion altered by this reviewer. Exploratory commands reported missing local `node_modules` before dependency setup, a nonexistent guessed `tool-runtime.ts` path and an unmatched package-script search; none was an application test.

Coordinator reports the archived probe whitespace has been corrected separately; that documentation change was not present in this reviewer head. This advisory does not affect the security verdict.

Full build, full CI, browser/Clerk integration and real paid-provider verification were not rerun. This gate supplements the previous whole-branch security review and is limited to the maintenance correction and compatibility-test delta.
