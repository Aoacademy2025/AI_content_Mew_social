# Task 1 independent correctness/spec/security review

Latest verdict at `2a8bbd7a2d7bf9a4c49f0c3d3ca4980b8ead6e44`: **Task 1 passes scoped re-review; both original medium blockers resolved.** The original review and reproductions below are retained as history. See the fix-round section at the end for the current evidence and remaining integration obligations.

Reviewed base `4c2461805dcc2633675996a82ce391cfe706ff60` through head `e08b628f682e0ace927b2ea2591577be1923e4a5`. Reviewer: gpt-6-astra, medium effort, per approved override. Independent Orca worktree: `/Users/mewsocialmacmini/orca/workspaces/AI_content_Mew_social/mcp-budget-review1`, branch `mewic/mcp-budget-review1`. No production code edited, no subagents, no production data or credentials used.

Scope is Task 1 only. Missing create gating, atomic consumption, provider budget enforcement, USER AutoMix execution reproduction, and external edit windows belong to later tasks and are not findings against this incremental commit. This review does not approve standalone deployment.

## Blocking findings

### R1 — Medium: a missing ElevenLabs voice is left mutable after approval

Location: `src/lib/mcp/video-quote.server.ts:129` (`resolveQuoteExecution`).

When the selected provider is ElevenLabs and neither the request nor the account has a voice, preparation succeeds and stores no `voiceId`. The Studio page explicitly shows that no voice is selected, yet permits approval. The existing orchestrator at `src/lib/mcp/orchestrator.ts:2372` resolves `input.voiceId ?? user.elevenlabsVoiceId ?? undefined`, so adding a saved voice after approval changes the effective work without changing either stored hash. `quoteExecutionRefusal` still accepts the approved quote. The original create route already refuses this missing-voice configuration at `src/app/api/[transport]/route.ts` using `missingVoiceIdError`; the quote path omits that guard.

Independent isolated reproduction:

1. Prepare and approve `{ script: "Approved exact voice fixture", voiceProvider: "elevenlabs" }` with `elevenlabsVoiceId: null`.
2. Read protected execution: `voiceId === undefined`.
3. Change saved voice to `later-unapproved-voice`.
4. Apply the existing orchestrator resolution expression: the effective voice is `later-unapproved-voice`; the approved snapshot validator returns `null` (accepted).

This is a Task 1 snapshot omission, not a claim that Task 2's pending gate has already been bypassed. The documented integration contract says the saved execution is fully resolved and safe to execute without re-resolving account preferences; that is false for this case.

Required fix: refuse preparation with an actionable missing-voice response until a concrete voice exists, or deliberately resolve and disclose a concrete supported provider default. Never persist an executable ElevenLabs snapshot that relies on a later account default. Add a regression proving missing defaults cannot silently acquire a different voice after approval.

### R2 — Medium: a music title/mood is stored instead of the resolved track

Location: `src/lib/mcp/video-quote.server.ts:135` (`resolveQuoteExecution`).

`bgmFile` supports track titles and mood words, not only paths. The snapshot copies the raw string, while `src/lib/mcp/orchestrator.ts:1433` fetches the current music library and calls `resolveBgm` later. `/api/music` orders system and owner tracks newest first. A new matching track can therefore change the actual audio used by the same approved snapshot. A music lookup failure can also remove a non-path selection. The worker's report claims music is pinned, but only the unresolved selector is pinned.

Independent isolated reproduction uses the production `resolveBgm` and the actual database ordering:

1. Seed `Lofi approved track` at `/music/approved.mp3`; prepare and approve a quote with `bgmFile: "chill"`.
2. Protected execution still contains `"chill"`; existing resolution yields `/music/approved.mp3`.
3. Insert a newer `Lofi newly added track` at `/music/later.mp3`.
4. The same saved execution now resolves `/music/later.mp3`, and `quoteExecutionRefusal` still accepts it.

Required fix: resolve title/mood inputs against the existing local system/owner music catalog during preparation, persist the actual resource path (and explicit no-music state where appropriate), and show the resolved choice in human review. This needs only local reads, not provider/network work. Refuse unresolved selections with an actionable response. Add a regression showing later matching library entries cannot change the selected track.

## Independent verification

All commands ran in the review worktree. Tests created and cleaned their own temporary SQLite databases; Prisma generation used a separate placeholder URL and did not query that database. No `.env`, shared `node_modules`, or mutable database was copied.

| Command | Exit | Result |
| --- | --- | --- |
| `orca worktree create --repo name:AI_content_Mew_social --name mcp-budget-review1 --base-branch e08b628f682e0ace927b2ea2591577be1923e4a5 --setup skip --json` | 0 | Isolated review checkout created |
| `npm ci --ignore-scripts` | 0 | Local dependencies installed |
| `DATABASE_URL=file:/tmp/hero-review1-generate-only.db npx prisma generate` | 0 | Additive Prisma model generated |
| `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-video-quote.ts` | 0 | Owner/auth/expiry/input/price/no-spend/presenter checks passed |
| `npx tsx scripts/verify-render-receipt.ts` | 0 | Shared receipt suite passed |
| `npx tsx scripts/verify-mcp-create-input.ts` | 0 | All 17 compatibility checks passed |
| `NODE_OPTIONS=--conditions=react-server npx tsx scripts/review-task1-probes.ts` | 0 | Both snapshot defects reproduced; repeated approval timestamp, cross-site POST, bearer GET checks passed |
| `git diff --check 4c2461805dcc2633675996a82ce391cfe706ff60 HEAD` | 0 | No whitespace defects |

The reviewer probe script is retained at `scripts/review-task1-probes.ts` in this worktree. It is a copy of the submitted isolated suite plus the described assertions, not production code. Its exit 0 means the defect reproductions succeeded, not that the snapshot behavior is correct. Output:

```text
REPRO voice: approved voiceId undefined; later effective voice = later-unapproved-voice ; snapshot validator still accepts
REPRO music: saved selector chill changes from /music/approved.mp3 to /music/later.mp3; snapshot validator still accepts
PASS independent repeated approval timestamp, cross-site POST and bearer GET checks
PASS quote owner/auth/expiry/input/price/zero-spend and presenter checks
```

No full build or broad suite was run, as requested. Worker-reported TypeScript/lint success was read but is not presented as independently rerun.

## Boundaries that passed review

- The new browser adapter directly calls Clerk `auth({ acceptsToken: "session_token" })`, requires both `userId` and `sessionId`, resolves the local owner, and rejects suspended accounts. It deliberately bypasses service-aware `getCurrentUser`. The HTTP adapter additionally rejects Authorization/service-actor headers; no MCP approval tool exists.
- Page/service/API owner filters do not expose another owner's private work. Public quote replies omit scripts, private input configuration, and media URLs. Registration audit fields contain source/content-presence flags rather than the private work.
- POST requires the configured origin and rejects cross-site requests, validates JSON/action, and uses owner/status/expiry CAS inside a transaction. Repeated approve preserves the original approval timestamp. Reject is terminal; approved-but-unconsumed quotes can be rejected. Consumed quotes cannot be rejected. GET derives expiry without mutating records or approving.
- Submitted normalized work and protected execution are separately hashed; idempotency keys do not change work identity. Default stock normalization is shared. Gemini voice/provider/style, resolved avatar identity/engine/layout, and selected/sole-brand subtitle design are concretely copied into the execution snapshot by source inspection. The two exceptions above prevent an unconditional immutable-input conclusion.
- Quote estimates reuse shared receipt logic, duration estimation, minute rounding, AI image credit price, minute credit price, and AutoMix weights. Wallet availability, in-flight reservations, trial image units, included minutes and overflow credits remain distinct. Render reservation sums include reserved VideoJob funding; transferred funding no longer has that state, so the design does not inherently double count the subsequent render reservation.
- Unknown URL presenter duration refuses without importing; an owned ready presenter import and positive duration are required. The resulting execution uses that import's stored source. Missing/foreign/not-ready imports receive the same refusal shape.
- Preparation creates no VideoJob, render, AI generation, media import, or reservation. Synthetic USER paid/trial paths and external zero-image-credit receipts pass. Existing queued/historical job paths were not changed by this increment.

## Advisories and evidence limits

1. **Live Clerk integration remains unverified.** All six committed screenshots were visually inspected: desktop receipt/approved, mobile external/rejected, signed-out and wrong-owner. They use synthetic content and show the expected UI states. The fixture bundles the actual component and exercises the shared HTTP/services, but replaces Clerk identity with fixture sessions; it does not exercise real Clerk cookies, login redirects, the dashboard layout, or reverse-proxy origin behavior. The source boundary is sound on review; a real authenticated Studio integration check remains necessary before live-readiness claims. Some captures include stitched/repeated fixture navigation and do not cleanly show every action in a single capture, so they should not be treated as production-shell evidence.
2. **“Reads only” needs qualification.** Shared `getStarterAiImageAllowanceStatus` may materialize the preexisting trial grant, and `getBalance` may materialize expired promotional-credit bookkeeping. Neither reserves generation/render funding or initiates paid work; this does not violate the specific no-generation/no-reservation rule. However, the service's “reads/local deterministic calculations only” comment is broader than the implementation. The worker report correctly discloses the exception. The original no-ledger-side-effect assertion covers an ordinary wallet fixture, not expired promotional balances. Keep this qualification and add focused coverage when expanding integrated tests; do not fork entitlement accounting merely to make a broad comment literally true.
3. Atomic consume/root creation, price/funding refresh, immutable caps across descendants and retries, actual-duration reconciliation, and refusal before provider calls remain Task 2 integration obligations. `quoteExecutionRefusal` alone is not atomic authorization or budget enforcement. This review does not treat those pending obligations as Task 1 regressions.

No production writes, deployment, restart, cleanup, customer communication, or Linear mutation occurred.

## Fix round 1 — independent re-review

Reviewed `e08b628f682e0ace927b2ea2591577be1923e4a5..2a8bbd7a2d7bf9a4c49f0c3d3ca4980b8ead6e44` after fast-forwarding this same isolated reviewer checkout. Original untracked report and reproduction script were preserved. Read the updated worker report and all five changed files; inspected the existing ElevenLabs model normalization and actual TTS provider route to assess the added model field. No production code was edited.

**Verdict: pass for Task 1, with no remaining medium-or-higher blockers in the reviewed fix.**

- **R1 resolved.** Non-presenter ElevenLabs preparation now trims the effective explicit/saved voice, refuses absent or blank values with `voice_setup_required`, and persists a concrete voice when valid. Independent checks confirm refusal creates no quote and a later account voice change cannot replace the saved voice. Presenter jobs correctly avoid irrelevant ElevenLabs voice requirements.
- **R2 resolved.** Preparation resolves title/mood/path through the shared pure selector using local system and owner music queries with the same ordering as `/api/music`. It checks the result exists in that usable catalog, pins the resource path, preserves explicit volume zero, supplies default volume 0.12, and records the resolved title for human review. Newer matching tracks do not replace a pinned path. None resolves to absent music; unresolvable, foreign, missing-path and remote-URL selections refuse before a quote is persisted or network work occurs.
- **Sibling model default is handled soundly within Task 1.** Execution records the shared-normalized ElevenLabs `v3`/`v4` model and human review displays it. Approval reads current model evidence inside its transaction and refuses changed settings. The execution helper requires current model evidence for approved/unconsumed ElevenLabs work and refuses absent/mismatched evidence. Normalization matches `elevenLabsSpeechModel` in the actual TTS route. Consumed replay intentionally returns before the new model check: additional tests confirm absent/different current model cannot strand the original root, while foreign owner and changed input still refuse before replay acceptance.
- The service comment now accurately acknowledges shared allowance/expiry bookkeeping. No new auth path, provider request, funding reservation, or billing implementation was introduced.

### Commands independently run after the fix

| Command | Exit | Evidence |
| --- | --- | --- |
| `git merge --ff-only 2a8bbd7a2d7bf9a4c49f0c3d3ca4980b8ead6e44` | 0 | Isolated checkout advanced; original review artifacts preserved |
| `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-video-quote.ts` | 0 | Existing quote/auth suite plus missing voice, music pin/none/refusal, model pin/drift/missing-evidence regressions passed |
| `NODE_OPTIONS=--conditions=react-server npx tsx scripts/review-task1-fix1-probes.ts` | 0 | Additional reviewer cases below passed |
| `git diff --check e08b628f682e0ace927b2ea2591577be1923e4a5 2a8bbd7a2d7bf9a4c49f0c3d3ca4980b8ead6e44` | 0 | Fix diff clean |

Additional probe script retained at `scripts/review-task1-fix1-probes.ts` in this worktree. It copies the current isolated suite and adds assertions for blank explicit voice/no persisted quote, saved voice pinning despite later changes, v4 model normalization, consumed replay with missing/different model evidence, replay owner/input isolation, owner music selection/display title, zero volume preservation, and foreign/missing/remote music refusal. Output:

```text
PASS independent fix-round blank voice/no persisted quote, saved voice pin, v4 normalization, consumed replay isolation, owned music/zero volume and foreign/missing/remote music refusal
PASS quote owner/auth/expiry/input/price/zero-spend and presenter checks
```

No full build or unrelated suite was repeated. Worker-reported typecheck/lint success is not claimed as independently rerun.

### Remaining nonblocking advisories / Task 2 contract

The actual `/api/videos/tts` route still reads the account model at provider time. Task 2 must either deliver the trusted pinned model to that route or enforce the quote's model at the authoritative provider seam, closing changes after enqueue/consumption. Passing the optional sixth `currentAccount` argument into `quoteExecutionRefusal` with current server-owned evidence is now mandatory for approved ElevenLabs consumption. A consume-time check alone does not cover later account changes; the worker report and code explicitly document this. This is pending Task 2 integration, not a new Task 1 blocker.

The previous fixture/live-Clerk limitation remains. No new browser capture was produced for the expanded music-title/model labels; their data and rendering expressions were source-reviewed and server values regression-tested. Shared bookkeeping may still materialize trial/expired-credit state without reserving paid work. Original Task 2–5 obligations, standalone-deployment restriction, and no-live-readiness qualification remain unchanged.
