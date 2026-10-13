# Task 1 — quote and authenticated Studio approval

Status: implemented and scoped verification passed; ready for independent review. This is **Task 1 only**. It does not yet gate existing `create_video_job`, consume approvals, reserve approved budgets, or enforce spend during provider work. Those are Task 2. External execution/edit windows remain Task 3. No deployment or production readiness claim.

## Workspace and inputs

- Worktree: `/Users/mewsocialmacmini/orca/workspaces/AI_content_Mew_social/mcp-budget-task1`
- Branch: `codex/mcp-budget-task1`
- Baseline: `4c2461805dcc2633675996a82ce391cfe706ff60`
- Created with Orca (`orca worktree create --repo name:AI_content_Mew_social --name mcp-budget-task1 --base-branch 4c2461805dcc2633675996a82ce391cfe706ff60 --setup skip --json`); renamed Orca-generated branch locally. No other worktree edited.
- Read complete approved plan in coordinator worktree, CLAUDE.md, relevant CONTEXT vocabulary and ADRs 0063–0066. Read installed Next route-handler, page-params and Server/Client Component documentation before implementation.
- Applied frontend-design and Browser skills. UI follows Studio's existing colors/components.

## Delivered

- Additive `McpVideoQuote`: owner, submitted normalized input/hash, resolved execution snapshot/hash, versioned shared pricing/hash, displayed receipt/subceilings, 30-minute expiry, approval/rejection/consumption dates and root job linkage. `rootJobId` is indexed but deliberately not unique: later incremental receipts may refer to the same retained root.
- `prepare_video_job` and `get_video_quote`, with owner isolation and actionable error/message/next replies. Preparation does not create a VideoJob, import media, call providers, or reserve image/render credits. Public replies omit private script and execution configuration. Preparation audit records only source/content-presence flags, not title/script/media URLs.
- Shared `buildReceipt`, duration estimate, minute-rounding and credit catalog calculations. Trial image allowance, available/reserved wallet balance and included minutes stay separate. Existing VideoJob funding reservations are included in the balance snapshot in addition to shared AI/render reservation totals.
- Snapshot-only quota reads avoid invoking the quota-sync path that can issue a monthly grant. Consumption must refresh entitlement/quota/funding. Existing entitlement/balance helpers may materialize a trial allowance or expired-credit accounting; neither is generation spending or a reservation.
- Resolved protected `QuoteExecution` pins voice/provider, Gemini style, avatar/engine/layout, subtitle design (including selected/sole brand), music, presenter import and export mode. Later account preference changes cannot mutate the saved work.
- Unknown remote presenter duration refuses with `presenter_import_required`, directing the agent to the existing presenter upload/import flow. Only an owned ready presenter import with a positive validated duration can produce an executable quote. Preparing never downloads the remote URL.
- `/mcp/confirm/[quoteId]` and `/api/mcp-quotes/[quoteId]`: direct Clerk `session_token` + `sessionId`, owner lookup, suspended-account refusal, no service-actor fallback. HTTP adapter rejects Authorization and service-actor headers, missing/foreign Origin and cross-site POST. GET derives status without approving or writing expiry. POST uses an owner/status/expiry conditional update inside a transaction.
- Receipt shows counts × shared unit price, included minutes, overflow credits, total ceiling, projected balance and external-service disclosures. Zero-credit quotes still require explicit approval. Approval alone reserves nothing. Rejection is terminal; approved-but-unconsumed quotes can be rejected.

## Task 2 integration contract

- `prepareVideoJobInputShape`/`PrepareVideoJobInput` extend the existing create shape with `external`. The original create schema remains unchanged until execution is ready, avoiding an interim external-to-stock fallback.
- `inputJson`/`inputHash` represent submitted normalized work, excluding transport idempotency keys. Explicit/omitted stock normalize identically. Changed payload fails closed.
- `executionJson`/`executionHash` contain `QuoteExecution { jobInput, exportMode, presenterImportId }`. Execute this resolved snapshot; do not re-resolve user/brand preferences and overwrite it.
- `quoteExecutionRefusal` checks owner, snapshot integrity, requested input, current pricing/flags, expiry and approved state. Consumed quotes with a root remain replayable after expiry and return that root. It is a validation helper, **not atomic consumption**.
- Task 2 must invoke validation within its create/funding transaction, recheck current entitlement/funding/pricing, atomically mark consumed/create once, attach the immutable budget to the root, and pass `imageCountCeiling` as `maxAiImages`. It must prevent all unquoted creation before provider preflights. Subsequent incremental approvals and retained checkpoints are not implemented here.
- `get_video_quote`/receipt copy describes the final approved flow; the branch must be integrated with Task 2 before deployment. No MCP approval tool is registered.
- Quota snapshots are deliberately conservative when stale; execution refresh must never expand displayed credit/minute ceilings without new approval.

## Tests-first evidence and fixes

First command, before implementation:

```sh
NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-video-quote.ts
```

Exit **1**: `ERR_MODULE_NOT_FOUND` for `src/lib/mcp/video-quote`. Full initial output: [task-1-red.txt](task-1-red.txt).

Intermediate implementation checks caught and corrected:

- A test assumed ceiling-minute rounding; existing billing intentionally rounds 61 seconds to 1 minute. Expectation corrected to preserve shared billing semantics.
- A zero-side-effect check observed an extra monthly-grant ledger entry when calling quota sync. Preparation now reads the current quota snapshot without that grant-producing sync.
- Prisma generate initially caught an unintended extra index in another model; corrected before successful generation.
- Lint caught `Date.now()` during React render and an unused local; removed both. Expiry remains authoritative in the server decision.

Final verification (all run in this worktree):

| Command | Exit | Evidence |
| --- | --- | --- |
| `npm ci --ignore-scripts` | 0 | Installed isolated dependencies; no environment file or database copied |
| `DATABASE_URL=file:/tmp/hero-task1-generate-only.db npx prisma generate` | 0 | Generated Prisma client from additive schema; no database query |
| `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-video-quote.ts` | 0 | Owner/foreign isolation; agent boolean does not approve; GET no approval/expiry mutation; direct HTTP bearer/service rejection; Origin/cross-site refusal; expiry; changed input/price; revoked/consumed state; account-default drift; zero provider/network/job/render/import/reservation side effects; ordinary USER paid/trial quotes; zero-credit external; unknown/missing/owned-ready presenter |
| `npx tsx scripts/verify-render-receipt.ts` | 0 | Existing shared receipt regression suite passed |
| `npx tsx scripts/verify-mcp-create-input.ts` | 0 | All 17 existing create-input/source compatibility checks passed |
| `npx tsc --noEmit --pretty false` | 0 | No preexisting or new TypeScript errors |
| `npx eslint` with the changed TS/TSX and two new scripts listed below | 0 | No warnings/errors |
| `git diff --check` | 0 | No whitespace errors |
| Browser fixture process and interactions | 0 on controlled termination | Signed-out/wrong-owner denied; paid approval persists on reload; external zero-credit rejection; desktop and 390 × 844 mobile view verified |

Exact lint command:

```sh
npx eslint src/lib/mcp/video-quote.ts src/lib/mcp/video-quote.server.ts src/lib/mcp/video-quote-http.ts src/lib/mcp/video-quote-browser-auth.server.ts src/lib/mcp/create-video-input.ts 'src/app/(dashboard)/mcp/confirm/[quoteId]/page.tsx' 'src/app/(dashboard)/mcp/confirm/[quoteId]/quote-confirmation.tsx' 'src/app/api/mcp-quotes/[quoteId]/route.ts' 'src/app/api/[transport]/route.ts' scripts/verify-mcp-video-quote.ts scripts/serve-mcp-video-quote-fixture.ts
```

## Reproduction and isolation

Install dependencies with `npm ci --ignore-scripts`, then generate Prisma as above. Do not copy `.env`, `.env.local`, shared `node_modules` or a mutable SQLite database. The test script overwrites `DATABASE_URL` with its own `mkdtemp` SQLite path, pushes the schema only there, seeds synthetic `.test` users and deletes that database on completion. It sets local pricing flags explicitly and replaces fetch with a throwing function to prohibit provider/network calls. No production credentials are required.

Browser fixture:

```sh
node --import ./scripts/register-server-only-node.mjs --import tsx scripts/serve-mcp-video-quote-fixture.ts
```

Open `http://127.0.0.1:4319/fixture/signed-out`, then use visible Signed out / Wrong owner / Owner approve / Owner reject links. The fixture listens only on loopback and creates its own disposable SQLite. It bundles the actual production receipt component and calls the actual quote services/HTTP adapter. Only Clerk identity is replaced with synthetic fixture sessions. Stop with SIGTERM or Ctrl-C; database cleanup is automatic. No fixture bypass exists in production auth or Next routes.

Browser evidence proves UI behavior, owner enforcement in the shared service, HTTP action handling and persistence with fixture auth. It does **not** prove live Clerk sign-in/cookie/proxy integration or the real dashboard shell. Production Clerk credentials/sign-in and real spending were not used. The real Clerk adapter is typechecked and source-reviewed; independent reviewer should assess that boundary.

Sanitized screenshots contain synthetic content only:

- [Desktop paid receipt](task-1-receipt-desktop.png)
- [Approved paid receipt](task-1-approved.png)
- [Mobile external zero-credit receipt](task-1-external-mobile.png)
- [Rejected mobile receipt](task-1-rejected-mobile.png)
- [Signed out](task-1-signed-out.png)
- [Wrong owner](task-1-wrong-owner.png)

## Remaining verification and review concerns

- Independent Task 1 review pending. Pay particular attention to the direct Clerk browser-only boundary, same-origin handling behind the existing proxy, and safe Task 2 consumption of pinned execution settings.
- Full production build and CI wiring are deliberately deferred to integrated Task 5, as directed. New verify script must be added to CI/coverage there.
- USER AutoMix generation failure reproduction, atomic consumption/concurrency, durable budget accounting, checkpoint/reapproval and actual-duration growth tests belong to Task 2 and were not represented as passed here.
- The intermediate commit must not be deployed alone: old create calls retain existing semantics until Task 2 installs the gate.
- No production writes/deploy/restart, paid provider calls, customer messages or Linear mutations. HERO-70 database contention remains separate and unresolved.

## Independent-review fix round 1 of 2

The reviewer reproduced two medium blocking omissions in the exact-work snapshot: an unresolved ElevenLabs voice could later pick up a newly saved voice, and a stored music mood/title could resolve to a different newly added track. A bounded sibling-default inspection also found that `/api/videos/tts` reads the current account's `elevenlabsModel` at provider time.

Tests were added before fixes. Running `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-video-quote.ts` exited **1** with all three independent failing regression names:

```text
missing ElevenLabs voice fails before a quote: undefined !== voice_setup_required
music selector is pinned before library changes: chill !== /music/approved.mp3
ElevenLabs model is pinned and setting drift refused: undefined !== v3
```

Fixes:

- Preparation refuses unresolved/blank ElevenLabs voices with `voice_setup_required` and an actionable `voiceId`/Studio setup next step. It does not create a quote whose voice falls through to a future account default.
- Music resolution uses the existing pure `resolveBgm` against local Music and owner-scoped UserMusic queries with the same ordering as `/api/music`. The execution snapshot contains the concrete selected path and explicit default volume 0.12. None selections contain no music field. Unresolved or unavailable/foreign resource selections refuse with `bgm_not_found`; preparation never fetches a URL or a provider. Human review shows the resolved track title.
- The execution snapshot now includes the normalized shared `elevenlabsModel` value (`v3`/`v4`), shown in human review. Approval rechecks it against the owner row. `quoteExecutionRefusal` accepts an additional sixth argument, `currentAccount?: { elevenlabsModel: string }`, and fails closed with `quote_settings_changed` for approved ElevenLabs work when the current model is missing or differs. Gemini and original-root replay remain unaffected.
- Exported `quoteAccountDefaultsRefusal(row, currentAccount)` for the consuming/provider seam. **Task 2 must repeat the model check immediately at the provider seam, or pass the trusted pinned model through to it. A consume-time check alone does not close mid-flight settings changes.** The coordinator received this explicit handoff; this Task 1 fix does not claim to implement Task 2 provider enforcement.
- Corrected the service comment to acknowledge existing trial-allowance/credit-expiry bookkeeping during shared reads, as the reviewer advised.

The new regression covers missing voice refusal, pinned path and volume, a newer matching music entry, unresolved/none selections, pinned model, approval-time and execution-time model drift, missing model evidence, and preservation of the explicit voice after account updates. Existing quote/auth/no-network/no-spend cases run in the same isolated SQLite suite.

Final commands after the fixes:

| Command | Exit |
| --- | --- |
| `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-video-quote.ts` | 0 |
| `npx tsc --noEmit --pretty false` | 0 |
| `npx eslint src/lib/mcp/video-quote.ts src/lib/mcp/video-quote.server.ts 'src/app/(dashboard)/mcp/confirm/[quoteId]/quote-confirmation.tsx' scripts/verify-mcp-video-quote.ts` | 0 |
| `git diff --check` | 0 |

No full build or unrelated suite was repeated. Previous fixture screenshots remain the original Task 1 evidence; this round changes the expanded voice/music labels and server snapshot behavior, verified by the regressions and type/lint checks. No live Clerk, production database, external provider, or other worktree was used or modified.
