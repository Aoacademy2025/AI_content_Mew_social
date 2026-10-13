# Independent final security review

**PASS — no confirmed material security blocker remains in the reviewed candidate.** This completes the local authorization/billing-integrity security gate; it does not certify production deployment or live provider readiness.

- Baseline: `4c2461805dcc2633675996a82ce391cfe706ff60`.
- Reviewed candidate: `24a7b170239a81fde00694bb30857c1f92db5e94`, including the round-1 correction delta from `aad67fbb`.
- Reviewer: independently dispatched `gpt-6-astra`, medium, run 25/25; no further agents or functionality changes.
- Worktree: `/Users/mewsocialmacmini/orca/workspaces/AI_content_Mew_social/mcp-budget-security-completion`.

## Isolation and scope

Read the approved plan, candidate changes, task-5 round-1 evidence and independent correctness report. Inspected the quote/auth/consume, shared image/render funding, descendant/export, provider recovery, external import/policy and receipt boundaries. Independently executed the focused fixtures below. Existing broader build/lint/TypeScript/CI evidence is coordinator/worker evidence, not claimed as rerun here.

Orca copied `.env` and `.env.r2.production`; both were removed only from this new worktree, without reading their contents, before dependency setup, Prisma generation or application imports. The initial `rm -f` command was rejected by the tool's safe-command rule; ordinary explicit `rm .env .env.r2.production` succeeded, exit 0. No restriction was disabled. Every application/setup command received explicit disposable `DATABASE_URL`; fixtures replace it with their own temporary SQLite and propagate it to subprocesses. No production interaction, credential inspection, paid provider call, external attack, release, workflow execution or deployment was performed. Only review artifacts were written.

## Security conclusions

1. **Human approval and owner isolation.** `video-quote-browser-auth.server.ts:6` explicitly requests Clerk session tokens and requires both user and session IDs plus an unsuspended persisted owner. `video-quote-http.ts:12` rejects authorization/service headers; POST requires matching Origin, rejects cross-site fetch metadata and accepts only approve/reject JSON. GET only reads. Quote reads/decisions are owner-filtered; MCP registers preparation/status/consumption, no approval tool. Fixture-based HTTP checks pass, including foreign owners and agent credentials. This is not a real Clerk/proxy rehearsal.

2. **Immutable work and atomic admission.** `video-quote.server.ts` resolves owned presenter imports, narration settings, brand and music into persisted work; public views omit the private work snapshot. `video-quote.ts:94` validates input/execution hashes, price, expiry and approval. `video-budget.server.ts:17` consumes and creates/funds the root in one transaction with conditional claim, rechecks entitlement/funding and identifies replays by quote rather than transport idempotency key. Preparing quotes creates no jobs, renders, imports or generation reservations. The tests exercise ordinary USER behavior, changed inputs/settings/prices, expiry, concurrent consume, different-key replay and entitlement revocation.

3. **Shared ceilings and derivatives.** `video-budget-admission.ts:13` resolves persisted owner/consumed-quote/root linkage and serializes admission on that root; `:33`, `:40`, `:59` account for image/render exposure and enforce component/total limits and approved provider prices. Actual duration reconciliation calls the shared check before top-up. Descendants inherit attribution in `video-job.ts`; browser render hints cannot consume an original queued execution reservation (`render/route.ts:430`). Eligible paid-source burns/rerenders retain their existing free behavior. Public HTTP and transactional fixtures cover exact/over limits, final-wallet and image-versus-render contention, trial funding, derivative attribution and creative-reroll refusal. Historical unquoted work retains its separate existing semantics.

4. **Unknown provider exposure and recovery.** Image submission/poll/cancel uncertainty retains the reservation and attempt identity; generic cancellation/refund does not release outstanding provider exposure. `video-budget-checkpoint.ts:14` caches completed work and refuses ambiguous narration/render replay; `:119` resumes only known owned results and does not release an approval hold. Both AutoMix and Hero fixtures reach final export after late BURN recovery with unchanged quote, render/provider attempt, TTS, wallet and minute counts. Unknown submissions remain held without fabricated reapproval.

5. **External media and resolved B1.** `external-media.server.ts:16` derives policy from persisted owner/project lineage and immutable quote root. Required slots are checked against owned ready imports at `:46`; replacement edits use the same identity boundary at `:90`. `:104` and `render/route.ts:331` now resolve actual source bytes through canonical render URLs and persisted outputs/render parents before BURN enqueue, even when IDs are omitted. The independent external run passed six public denial cases across script/presenter, supplied/omitted IDs and canonical URL aliases, with no extra render, plus two valid free public burns. Initial placeholders remain valid; final export cannot waive missing/pending/failed/foreign media. Shared web/MCP edits preserve revision checks and presenter-owned spans.

6. **Imports, settlement and disclosure.** External work reuses existing Media Import URL/upload paths. No new remote fetching path or weakening of the existing HTTPS/DNS/redirect/byte protections was introduced. Reviewed existing fetch/token guards and their regression coverage; the independent external fixture exercises actual upload PUT, one-use token refusal, owned/missing/foreign import projection, real ffmpeg normalization and no stock/image calls. It stubs URL transport and does not independently rerun the standalone SSRF suite. `reservation-settlement.ts:85` refunds through the existing mixed-bucket helper atomically and only confirms the root mirror for the matching complete return. Receipt checks pass for pending, partial, rolled-back and historical ambiguous refunds, with owner-scoped durable ledger reporting and no foreign asset path disclosure.

## Advisory, not a reachable public blocker

`video-budget-admission.ts:40–48` checks input/key parent disagreement after resolving the selected parent's budget; an unbudgeted selected parent returns early. Moving disagreement validation before that early return would strengthen this internal helper. It is not evidence of a public approval bypass: the actual fetch-stock route authenticates service provenance before minting video image work, public forged owned-historical/foreign IDs and body provenance fail with 403 before image/ledger creation, and existing service callers derive both identities together. The independently executed `verify-mcp-image-parent-boundary.ts` confirms that public boundary. No production source change is required by this review.

## Independent commands and evidence

Working directory is the reviewer worktree above. Common test prefix:

```sh
DATABASE_URL=file:/tmp/mcp-security-completion-unused.db node --import ./scripts/register-server-only-node.mjs --import tsx scripts/
```

The prefix is followed by the script filename (without a separating space after `scripts/`). For the Hero variant, `BUDGET_FIXTURE_SOURCE=hero-ai-image` was additionally set before `node`. Each test creates its own disposable database. Logs are in adjacent `security-completion-evidence/`.

| Command/script | Exit | Evidence |
|---|---:|---|
| `DATABASE_URL=file:/tmp/mcp-security-completion-unused.db npm ci --ignore-scripts` | 0 | Tool output; dependency setup only |
| `DATABASE_URL=file:/tmp/mcp-security-completion-unused.db ./node_modules/.bin/prisma generate` | 0 | Tool output |
| `verify-mcp-video-quote.ts` | 0 | `verify-mcp-video-quote.txt` |
| `verify-mcp-budget.ts` | 0 | `verify-mcp-budget.txt` |
| `verify-mcp-budget-orchestrator.ts` (AutoMix) | 0 | `verify-mcp-budget-orchestrator.txt` |
| Same script, Hero AI Image variant | 0 | `verify-mcp-budget-orchestrator-hero.txt` |
| `verify-mcp-external-media.ts` | 0 | `verify-mcp-external-media.txt` |
| `verify-mcp-image-parent-boundary.ts` | 0 | `verify-mcp-image-parent-boundary.txt` |
| `verify-mcp-spending-summary.ts` | 0 | `verify-mcp-spending-summary.txt` |
| `git diff --check 4c2461805dcc2633675996a82ce391cfe706ff60..HEAD` | 0 | Tool output |

All seven focused runtime invocations passed. No runtime failure was suppressed or assertion altered. Two exploratory searches had nonzero exits (one unmatched package-script name search and one guessed nonexistent token-module path); these are not verification failures. Dependency installation printed the repository dependency vulnerability summary; this review did not run a dependency audit or claim dependency-wide security certification.

## PR delivery safety and remaining limits

The repository has two GitHub workflows. `ci.yml:3` runs CI on PRs targeting main and pushes to main; inspected jobs contain verification/build, not production deployment. `hero-voice-clone-canary-image.yml:4` is limited to a different named branch and paths, and its publication job is additionally disabled with `if: ${{ false }}`. No repository-defined production deployment is triggered by pushing this feature branch or opening its PR. External hosting hooks/repository settings cannot be certified from this local inspection.

Live Clerk/browser proxy integration and real paid provider/render outputs remain unverified; providers/composites are stubbed, while billing and import normalization are real local fixtures. HERO-70 SQLite contention remains separately unresolved. New creative rerolls are refused; there is no per-window creative-reroll quote UI, and none is claimed. Rollout/rollback notes correctly require keeping enforcement for quote-bound and uncertain work. The coordinator still owns reviewed PR delivery; this PASS does not authorize production changes.
