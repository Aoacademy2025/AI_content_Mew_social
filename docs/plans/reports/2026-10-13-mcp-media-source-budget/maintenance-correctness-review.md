# Independent maintenance correctness delta review

Status: **PASS — no correctness blocker in reviewed application/test delta.** Final hosted CI remains a separate delivery gate.

Reviewed baseline: `24a7b170`. Initial candidate: `1505b2e907cda1fb22fde90ad122159c101ad4fa`.
Additional reviewed test commits: `5a141bb4` and `6a08095a`.
Exact reviewer HEAD: `1ae4ba4a244f11cb469f15fff82b5036ac095427`; application and script trees match coordinator `88f87d0e` (`git diff 88f87d0e HEAD -- src scripts`, exit 0, empty).
Worktree: `/Users/mewsocialmacmini/orca/workspaces/AI_content_Mew_social/mcp-maintenance-review`.

## Scope and isolation

Read the approved plan, maintenance review package, reproduced regression and previous whole-branch correctness review. Independently inspected every changed application/script path since the previous reviewed candidate. Removed only this worktree's copied `.env` and `.env.r2.production` without reading them before application imports; used explicit disposable DATABASE_URL values and sibling dependency symlink. Database fixtures create fresh temporary SQLite. No provider, production data, deployment or external mutation. No full build repeated.

## Public maintenance behavior

The only production delta catches `RenderDeployDrainError` around awaited `requestVideoJob` in the registered public create callback, returning shared customer text, stable `render_maintenance` error/code, `retryable: true`, and actionable same-quote retry guidance. Other errors propagate unchanged. The authoritative transactional drain gate, quote claim and billing code are unchanged.

The independent probe executes the actual HTTP MCP route with real PAT authentication and an ordinary USER. Clerk/network preflight are stubbed; quote preparation, approval persistence, consumption, database and funding logic are real. It verifies:

- Approved unconsumed quote during drain returns the shared maintenance envelope and next action.
- Full quote, job, project and wallet snapshots plus minute usage/charged clips/render reservations/credit-ledger counts remain unchanged; no network call occurs.
- Removing drain lets the exact approval create one root and consume the quote.
- Re-enabling drain and replaying that consumed quote with a fresh idempotency key returns the same root with `replayed: true`; all captured funding/creation state remains unchanged.
- Removing drain again and replaying preserves that same state and one-root identity.

Sensitivity control: a second local probe disables only the new catch mapping in its in-memory compiled route. It exits **1**, failing exactly the specific error, shared message and actionable next assertions (`132 passed, 3 failed`). Rollback and replay assertions continue to pass. This independently reproduces the original regression and demonstrates the green probe is sensitive to the actual correction.

## Test compatibility review

No behavioral assertions were removed from the editor replay, B-roll render or ffmpeg security coverage. Editor local variable cleanup is semantic-preserving; new external-policy stubs throw if incorrectly reached. FFmpeg empty-table mocks now return Prisma-shaped arrays for `findMany`, and use the real external-media policy. Onboarding assertions follow the already-reviewed validated presenter/quote/four-source description; the brand-only source-text assertion was replaced with ceiling guidance, without changing product behavior. Preflight source checks now inspect the real approved consumption service and preserve the web check. Scene error harness receives the actual `VideoBudgetHoldError` class and adds identity-preserving rejection coverage; existing error assertions remain intact.

## Independently executed verification

All application commands used `DATABASE_URL=file:/tmp/mcp-maintenance-correctness-*.db node --import ./scripts/register-server-only-node.mjs --import tsx <script>`; ffmpeg additionally uses `--experimental-test-module-mocks`. Logs are `/tmp/mcp-maintenance-correctness-*.log`.

| Command/script | Exit | Result |
|---|---:|---|
| `scripts/verify-mcp-edit-draft.ts` | 0 | 130 passed, 0 failed |
| `scripts/.maintenance-correctness-probe.ts` | 0 | Independent extension: 135 passed, 0 failed |
| `scripts/.maintenance-correctness-red-probe.ts` | 1 expected | Mapping disabled: exactly 3 maintenance-envelope failures |
| `scripts/verify-customer-error-copy.ts` | 0 | ALL PASS |
| `scripts/verify-mcp-onboarding.ts` | 0 | 118 assertions |
| `scripts/verify-editor-project-recovery-hook.ts` | 0 | All checks passed |
| `scripts/verify-broll-render-route.ts` | 0 | All checks passed |
| `scripts/verify-render-plan-preflight.ts` | 0 | ALL PASS, web and approved MCP checks |
| `scripts/verify-hero-image-scene-error.ts` | 0 | ALL PASS, including real budget refusal propagation |
| `scripts/verify-ffmpeg-input-hardening.ts` | 0 | Full real-process security fixture passes |
| `git diff --check 24a7b170..HEAD -- src scripts` | 0 | Application/test whitespace clean |
| `git diff --check 24a7b170..HEAD` | 2 | Existing archived patch line 6 whitespace; coordinator reports documentation-only repair pending |

The archived reproduction patch whitespace is advisory, not a runtime blocker. This report certifies the scoped delta, not a repeated whole-branch review or live-readiness claim. Previous approval/security/budget reviews remain the supporting evidence for unchanged behavior.

## Final package invocation correction recheck

**PASS.** Reviewed package-only commit `7c41e149`, cherry-picked as exact reviewer HEAD `72114889f923c1622e388be2f76b521d11888461`. `git diff 39496a58 HEAD -- src scripts package.json` exits 0 with no output, confirming reviewed runtime/test/package trees match the coordinator candidate.

The sole change prepends the installed Next `node-environment-baseline.js` import to `verify:media-import-upload`. Inspection of that installed module confirms it initializes missing global AsyncLocalStorage from Node async_hooks (and a lazy WebSocket accessor), as Next expects before its dependent imports. The existing `--conditions=react-server`, tsx loader, verifier and every assertion remain unchanged. No application source changes or weakened server-only guard.

Independently executed the exact package entry point:

```sh
DATABASE_URL=file:/tmp/mcp-maintenance-correctness-media-import-unused.db npm run verify:media-import-upload
```

Exit **0**, **161 passed, 0 failed**. Log: `/tmp/mcp-maintenance-correctness-media-import.log`. Copied env files remain absent; verifier uses its own throwaway SQLite and local two-process admission/ffmpeg fixtures. No broader suite repeated. Scoped PASS stands at this final package correction.
