# Public MCP media choice and user-approved spending

## Goal and approved scope

Deliver code, regression tests and a reviewed PR in AI_content_Mew_social. Fix the ordinary-user AutoMix receipt failure while preventing surprise spending through both AutoMix and Hero AI Image. Before creation, ask whether media comes from stock, Hero AI Image, AutoMix or the customer's own agent/tools. External media incurs no Hero image-generation credits; render minutes/overflow and external-service charges remain separately disclosed.

Mew approved the design in chat on 2026-10-13, after reviewing the credit-confirmation proposal and adding the external-agent option. Preserve this authorization; do not re-interview the settled four options, human Studio confirmation, hard spending ceiling or no silent paid fallback. Implementation details below make that approved behavior executable. No deployment, production writes, customer communication or Linear synchronization was requested.

Baseline: `4c2461805dcc2633675996a82ce391cfe706ff60`.
Orca worktree: `/Users/mewsocialmacmini/orca/workspaces/AI_content_Mew_social/mcp-media-budget-20261013`.
Evidence: `/Users/mewsocialmacmini/orca/workspaces/AI_content_Mew_social/mcp-prelive-review-20261013/docs/audits/2026-10-13-mcp-prelive-review.md`.

## Existing evidence and reuse

- Production USER job `cmv6nb0hj00hnlcxlgkrtyjdd` on 13 October has auto-mix, AI providers, and no maxAiImages; fetch-stock rejects it with render_receipt_required, later flattened to stock_unknown. The guard exempts admins. Reproduce locally before fixing; never remove the guard or extend its admin exception.
- `src/lib/mcp/broll-source.ts:mcpBrollJobFields` supplies no approved image cap. The MCP route immediately creates a job and returns queued. There is no authoritative pre-spend approval object.
- Reuse `video-editor/_v2/receipt.ts`, `estimate.ts`, `credit-costs.ts`, existing entitlement/balance APIs, and the authoritative image/render reservation and settlement functions. Prices must be read from the shared catalog, not copied into MCP text.
- `src/lib/mcp/billing-receipt.ts` accounts for the render chain, not all image charges. Preserve its once-per-video invariant; add image totals from durable generation funding records, never from tool-call counts.
- `reconcileVideoJobFunding` currently tops up a longer actual duration automatically. Quote-bound MCP work must enforce the approved cap through this path too, without silently changing existing web-job behavior.
- Reuse Media Import (ADR 0065), Held Preview/Pending Edit Draft (ADR 0064), chain export (ADR 0063), and shared edit semantics (ADR 0066, one-edit-model-two-front-ends).
- External presenter fillYourself already exists. Script-only external media must also work: do not assume stockSource=none alone exposes editable placeholder windows. Prove this end to end and extend the shared window model only if needed.

## Architecture and interfaces

### Source selection

Add `external` to the public brollSource vocabulary. Stock remains the omitted-field compatibility default, but onboarding must ask explicitly before ordinary new creation. `external` means no Hero image provider and no automatic stock retrieval: the agent imports owned/usable media through existing URL/upload tools. External service availability, rights and charges are the customer's responsibility; never claim every client can generate images.

### Render Receipt and approved budget

Add `prepare_video_job` with the shared normalized create-input fields and `get_video_quote({quoteId})`. Preparing performs local deterministic estimation/reads and persists a bounded owner-scoped quote; it must not create a VideoJob, call paid providers, reserve money or import media. For a remote presenter whose duration is unknown, state that fact and require a validated owned import before producing an executable quote; reuse the existing presenter upload/import preparation path without generation charges. Never pretend an unknown duration has an exact cost.

Quote reply: quoteId, status, expiresAt, source, image count ceiling, image credit ceiling, included render minutes, render-credit ceiling, total Hero-credit ceiling, available/reserved balance snapshot, separate trial image allowance when applicable, external-charge disclosures, confirmationUrl and next. Keep schemas agent-neutral and errors code/message/next shaped.

Persist one additive `McpVideoQuote` model, unless the executor finds an existing equivalent owner-scoped approval record. Required semantics: owner, normalized immutable input snapshot/hash, versioned pricing snapshot, displayed ceilings, expiry (30 minutes before first use), approval time, terminal state, and resulting root job linkage. Draft/approved/consumed/rejected/expired states may be derived where appropriate. Store private inputs only in protected records; no scripts, media URLs or tokens in logs/Linear/GitHub.

Studio page `/mcp/confirm/[quoteId]` displays the receipt and explicit approve/reject actions. Authentication is the user's Clerk browser session; ownership is checked on reads and writes. MCP tokens/service-actor auth must never approve. GET is side-effect-free; approval is a same-origin protected POST. A quote ID in a link is not a bearer approval credential. Use existing app controls and receipt display conventions. The approve button is labeled with the total ceiling, not a generic Continue.

`create_video_job` gains `quoteId`. An unquoted new call returns confirmation_required plus a prepared quote/confirmationUrl instead of doing paid work. It must remain helpful to old clients, not silently skip the gate. Quoted execution loads approved input server-side; caller changes cannot override the snapshot. Retry of a consumed quote returns the original job; different payload/owner/stale approval fails closed. Do not send a boolean confirmed field as proof of human consent. Do not register any MCP approval tool.

Approval alone does not reserve balances. At consumption, atomically recheck entitlement, available funding and current price policy. If cost/terms changed or funding is insufficient, return a clear refusal/new quote before providers. Reserve once through existing billing infrastructure. Keep approval consumption and root-job/funding creation atomic, so crashes, concurrent requests or new idempotency keys cannot multiply spending. Avoid holding a SQLite transaction across network/provider work.

### Enforced spending

Persist an immutable budget reference on quote-bound roots; descendants and every consuming image/render operation resolve it. A quote's image and render sublimits plus total limit are authoritative. All reservations, in-flight attempts, retry/refund accounting and settlement use the existing ledger; no parallel wallet. Do not double-count an image reservation as both a reservation and settled charge. Never free ambiguous provider charges merely to make another retry fit.

For AutoMix derive/pass numeric maxAiImages from the approved quote. Hero AI Image needs the same enforceable ceiling, not just copy. If actual timing/planning requires more work than approved, stop before the next disallowed spend and return confirmation_required with the retained checkpoint/preview and a new incremental quote; resume must reuse completed voice/media rather than regenerate. Do not auto-top-up quote-bound render credits beyond the approved amount. A changed image rate is not permission to spend the same number of images at a higher price.

At a smaller available image budget, AutoMix may plan stock only if the user approved that mix in the receipt. External must never switch to Hero-generated media or an unapproved external provider. Technical retries must not multiply net charges beyond the ceiling; creative rerolls outside the approved work require a new receipt.

### External agent media

Normalize external to no-provider media planning and a Held Preview. Expose usable shared edit windows for both script and presenter inputs; respect actual presenter-hook protection, not a blanket index-zero ban. Agent obtains media through its own capabilities, then uses create_upload_url/PUT or public HTTPS import and replace_broll_window. Get edit state explains required/pending windows. Export refuses pending/failed or unfilled required external B-roll slots with an actionable response; presenter-owned spans remain valid. Preserve source, pending edits, and rendered results when opening in the web editor. No new import daemon or provider connector.

### User-facing copy

Source question: “อยากใช้ภาพประกอบแบบไหน: สต็อก, Hero AI Image, AutoMix หรือให้ AI ที่คุณคุยอยู่สร้าง/หาภาพและวิดีโอแล้วนำเข้าให้?”

External disclosure: “ไม่ใช้ Hero credits สำหรับการสร้างภาพ · การเรนเดอร์ยังใช้นาทีตามแผนหรือเครดิตส่วนเกิน · เครื่องมือภายนอกของคุณอาจมีค่าใช้จ่ายของตัวเอง”

Receipt must show counts × current unit prices, separate render/AI components, maximum total and projected remaining balance. Approved button: “ยืนยันวงเงินไม่เกิน {total} Hero credits”. Zero-credit work still shows included minutes and external-service disclosures accurately.

When agent lacks media tools: “เครื่องมือที่เชื่อมต่ออยู่ยังสร้างหรือค้นหาสื่อนี้ไม่ได้ คุณส่งไฟล์/ลิงก์ให้ผม หรือเลือกแหล่งสื่ออื่นได้” — never silently choose a paid alternative.

After completion: actual included minutes, image credits, render credits, settled total, outstanding reservations/refunds and current available balance. Never label pending refunds as returned, or call the entire video free when only the image component is free.

## Global Constraints

- The four sources are stock, hero-ai-image, automix, external. Ask before new creation; no silent paid fallback.
- User approval is authenticated in Studio and bound to one owner, exact work and displayed spending ceiling; an agent-supplied boolean is not authorization.
- No paid provider/generation/render reservation before approval. Preparing a quote never creates a render job.
- Enforce image, render and total Hero-credit ceilings server-side across roots, descendants, concurrent calls, retries and actual-duration reconciliation.
- Use existing price, entitlement, wallet and reservation/settlement logic; do not fork billing or weaken existing receipt/SSRF/ownership guards.
- External media uses zero Hero image-generation credits, but still discloses render use and external charges. Support both script-only and presenter jobs.
- Existing approved/queued historical jobs keep their original semantics; do not impose a retroactive quote that strands them.
- Preserve once-per-video render billing, free eligible edit/export, identity/ownership isolation and shared web/MCP edit behavior.
- Public tool schemas remain agent-neutral; errors include actionable next steps; never leak private content or credentials.
- Tests first. Reproduce ordinary USER AutoMix failure; ADMIN-only tests are insufficient.
- No production writes/deploy/restart/cleanup, customer replies or Linear mutation under this approval.

## Tasks

### 1. Quote → authenticated Studio approval → MCP observation

Owner: new quote domain/service, additive Prisma schema, preparation/status MCP registration, Studio confirmation page and API. Read installed Next documentation before code.

Files: prisma/schema.prisma; new src/lib/mcp/video-quote.ts and video-quote.server.ts; src/lib/mcp/create-video-input.ts; src/app/api/[transport]/route.ts; new src/app/(dashboard)/mcp/confirm/[quoteId]/page.tsx and src/app/api/mcp-quotes/[quoteId]/route.ts; shared receipt/estimate helpers only as needed.

- [x] First failing checks: owner/foreign quote isolation, GET cannot approve, MCP credential cannot approve, expiry, changed input/price, quote has no paid side effects.
- [x] Reuse shared estimates/prices; distinguish image allowance, credit balance and included minutes.
- [x] Implement durable quote, approved/rejected state, same-origin approval, responsive existing-style receipt UI and tool replies.
- [x] Verify browser signed-out/wrong-owner/approve/reject behavior and capture sanitized UI evidence.

Task 1 verification: reviewed at `2a8bbd7`; browser checks used synthetic fixture sessions. Live Clerk/proxy integration remains an advisory for final evidence, not a live-readiness claim.

### 2. Approved execution and AutoMix/Hero AI Image budget enforcement

Owner: consumption + funding/provider seams. Depends on 1.

Files: src/app/api/[transport]/route.ts; src/lib/mcp/{broll-source,chain-export,video-job,video-job-funding,orchestrator,clip-video-job}.ts; src/app/api/videos/fetch-stock/route.ts; existing image funding admission and render settlement modules as identified by scoped recon.

- [x] Failing production-shaped USER AutoMix fixture without cap; paired ADMIN test demonstrates why old testing missed it.
- [x] Atomically consume approval/create/fund once. Replay returns same root even after crash/retry; changed inputs fail.
- [x] Pass approved cap, enforce Hero-image and render credit sublimits at authoritative reservation seams, including actual-duration growth and provider retry/refund paths.
- [x] Preserve work when additional approval is required; no repeat TTS/image spending on resume.
- [x] Test race for final credits across two jobs; retry with a different idempotency key; worker restart; stale/expired quote; price change; in-flight ambiguous provider; failure/cancel; trial allowance; exact-boundary and over-budget cases. Existing web jobs retain semantics.

Task 2 verification: accepted at `23039d07` after independent HTTP-boundary and recovery probes. Actual provider endpoints remain stubbed; final export composition belongs to Task 5. Unknown provider outcomes stay held; no per-window creative-reroll quote UI is claimed.

### 3. External media selection → held preview → import → export

Owner: public external source and existing shared editor/import flow. Depends on 2.

Files: src/lib/mcp/{broll-source,create-video-input,orchestrator,edit-tools,video-options}.ts; shared B-roll window planner and pending-edit model as needed; web editor readers if shared state changes.

- [x] Failing end-to-end script-only and presenter fixtures using external source, with provider spies asserting zero image-generation and stock retrieval calls.
- [x] Create usable placeholder B-roll windows and held state; reuse existing Media Import. Preserve presenter ownership semantics.
- [x] Import one image and one video via both URL and upload fixtures; export reflects the assets and no Hero image credits.
- [x] Pending/missing/failed required assets give actionable refusal; failed imports never trigger paid fallback; web opens the same pending edits.
- [x] Preserve SSRF/byte budgets/token expiry/ownership/CAS checks; do not add another media-fetch path.

Task 3 verification: independently accepted at `f62f532a`, external integration 81 assertions with real import normalization/shared API/worker paths and stubbed TTS/render/composite. Legacy edit fixture migration and browser lifecycle advisory remain Task 5 obligations.

### 4. Complete cost receipt and conversational guidance

Owner: reporting and Thai tool instructions. Depends on 2 and 3.

Files: src/lib/mcp/{billing-receipt,video-job-status,tools,onboarding,video-options}.ts; existing credit ledger read helpers; scripts/verify-mcp-onboarding.ts and new scoped billing summary tests.

- [x] Derive image actuals and reservations/refunds from durable ledger links and aggregate the chain without double counting.
- [x] Expose approved vs actual totals, included minutes and external-cost disclaimers; preserve existing receipt response compatibility where possible.
- [x] Teach choose source → prepare → send Studio link → observe approval → create → edit/import → export. Never tell agent to self-approve or invent tool capabilities.
- [x] Structured expected-failure replies keep receipt_required / confirmation_required specific rather than stock_unknown.
- [x] Verify all four choices, external tool unavailable, stock still has render usage, insufficient balance and pending-refund wording.

Task 4 verification: independently accepted at `2430fab9` after actual terminal-refund and mixed-funding corrections. Scoped receipt/guidance/settlement checks pass; full legacy fixture migration remains Task 5.

### 5. Integrated verification and reviewed delivery

Owner: integration fixtures, CI coverage, rollout notes, reviewed PR. Depends on 1–4.

- [x] Wire all new verify scripts into CI; run meaningful regression suites for quote/auth/budget, MCP creation/edit/import, billing/settlement and existing web receipts.
- [x] Use isolated throwaway SQLite and installed dependency setup; never point tests at production or a shared mutable worktree DB.
- [ ] TypeScript, lint changed files, production build, MCP CI-coverage; record commands, exit codes and any excerpts on failure.
- [x] Four ordinary-user E2E paths and malicious-client bypass tests; no real provider charge needed for regression tests. Production rehearsal remains separately authorized.
- [x] Independent whole-branch correctness and security reviews, resolve blockers, then open PR with additive-schema and rollback instructions. A rollback must drain new quote-bound jobs or retain enforcement; disabling a gate must not authorize unpaid/unapproved work.
- [x] No live-readiness claim merely because CI passes. Report actual test coverage and the unresolved separate HERO-70 database risk.

Task 5 verification: code candidate `24a7b170` passed independent correctness and security reviews. Full 56-invocation regression selection plus 13 correction checks, build, TypeScript, changed-file lint and CI coverage passed; PR [#602](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/602) is draft: final GitHub CI exposed the reproduced maintenance-response regression; see maintenance-regression.md. No merge or deployment.

## Assurance and Budget

- Profile: high-assurance.
- Risk: high — human spending approval, credits/reservations, auth/ownership, external-media boundary and additive durable schema.
- Automatic fix rounds per task: 2.
- Execution ruling after Task 2 round 2: one explicitly bounded, session-directed correction of known-result resume readiness for confirmed-refunded historical attempts, followed by scoped independent review. The automatic ceiling remains 2; no general extra fix round is authorized. See execution ledger for evidence and rationale.
- Maximum subagent runs: 30 (Mew approved run 25 for independent security completion, then explicitly approved five additional Astra medium runs on 2026-10-14 to finish the maintenance regression and final verification while away). At the ceiling, report achieved/unmet criteria rather than silently weakening gates.
- Concurrency: fill only live harness slots; one agent per Orca worktree. Separate worker/reviewer worktrees; integrate reviewed branches sequentially where files overlap.
- Usage checkpoints: before execute, after each frontier wave, before final gate.

## Execution Directive

| # | Task | Agent | Mode | Blocked by | Review gates |
|---|------|-------|------|-----------|--------------|
| 1 | Quote and human approval | mew-worker-heavy | subagent | — | failing tests then implementation, auth/UI tests, mew-reviewer |
| 2 | Execution and hard budget | mew-worker-heavy | subagent | 1 | failing tests then implementation, billing/race/recovery tests, mew-reviewer |
| 3 | External-media path | mew-worker-heavy | subagent | 2 | E2E/import guards/web parity, mew-reviewer |
| 4 | Receipts and guidance | mew-worker | subagent | 2, 3 | ledger/source-choice tests, mew-reviewer |
| 5 | Integration and PR | mew-worker-heavy | subagent | 1–4 | build+tsc+scoped suites; independent mew-reviewer-heavy correctness and security |

Execution override from Mew, 2026-10-13: every worker, reviewer and explorer uses gpt-6-astra at medium effort for this task. This overrides the original adapter routing (heavy gpt-6-sol xhigh; standard gpt-6-astra high), without reducing review gates. Use a configurable agent role where built-in role definitions fix a different model. Every dispatch names its model, uses fresh context and includes this plan's Global Constraints. Reports ≤150 words with full evidence written to disk.

## Acceptance Criteria

- [x] AC1: Onboarding offers all four sources before creation and accurately distinguishes image charges, render usage and external charges.
- [x] AC2: Preparing/reading a quote incurs no generation/render charge; an ordinary authenticated owner can review and approve it in Studio; agents/other users cannot approve it.
- [x] AC3: Unapproved/changed/expired/replayed/racing calls cannot create extra paid work. Replays of a consumed quote identify the original job.
- [x] AC4: Ordinary USER AutoMix successfully reaches export with a valid approved cap; Hero AI Image uses the same approval/budget protection; receipt guards are preserved.
- [x] AC5: Actual duration, additional AI slots, retries and concurrent jobs cannot exceed the approved ceilings. Reapproval resumes completed work without duplicate charges.
- [x] AC6: External source works for script-only and presenter flows through URL/upload imports and shared edits, with zero Hero image-generation charges and no automatic paid fallback.
- [x] AC7: Final receipts reconcile image/render credits and reservations/refunds to durable billing evidence; free eligible edits/export remain free.
- [x] AC8: Existing web creation, historical jobs, ownership, safe-fetch/import limits and flat tool schemas retain required behavior.
- [ ] AC9: Required tests/build pass with recorded exit codes; independent security/correctness blockers resolved; reviewed PR and deployment notes delivered without deployment.

## Out of scope

- Fixing SQLite lock contention (HERO-70/HERO-10): separate root-cause work, not remedied by this feature.
- Building customer agents' image/search tools or using internal Mew/Grok subscription resources for public customers.
- Changing credit prices, plan entitlements, grant amounts or global web duration top-up policy.
- Public bulk load testing, production migration/deploy, ticket replies and Linear changes without separate authority.

## Status

interviewed 2026-10-13 | approved: 2026-10-13 (chat: cost disclosure + human approval + capped spending, then four sources including external agent media; latest “ok approve”) | executed: in progress; code candidate `24a7b170` passes integrated checks and independent correctness, final independent security PASS after explicitly approved run25/25; reviewed PR delivered; ledger docs/plans/reports/2026-10-13-mcp-media-source-budget/progress.md | delivered: 2026-10-14, [PR #602](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/602); no merge/deploy; GitHub CI failed on maintenance-response compatibility; not ready to merge

The approved product scope is settled. The mew-kickoff skill requires production execution in a fresh session; do not request another approval for the same scope.
