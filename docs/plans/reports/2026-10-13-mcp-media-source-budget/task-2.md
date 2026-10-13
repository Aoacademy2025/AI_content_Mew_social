# Task 2 — approved execution, authoritative ceilings and retained checkpoints

Worktree: `mcp-budget-task2`; branch: `codex/mcp-budget-task2`; baseline: `2a8bbd7a2d7bf9a4c49f0c3d3ca4980b8ead6e44`. No production writes, external providers, copied environment, or shared databases. Dependencies installed locally with `npm ci --ignore-scripts`; integration fixtures create and remove throwaway SQLite databases.

## Implemented

- Public create now prepares a confirmation when unquoted. Quote-ID-only execution uses the protected execution snapshot. Optional changed work fails. Quote consumption, project/root creation, and existing render funding share one transaction; transport idempotency keys cannot create another root. Current owner, expiry, prices, account suspension, MCP/image/voice entitlement and wallet funding are checked before consuming. Replays return the owned original job's actual state.
- Persisted quote references on video/image rows establish authority. Descendants inherit through owner-checked source jobs. Root locking serializes image admission and actual-duration top-ups; reserved and settled exposure are disjoint. Count, image credits, render credits, and total ceilings apply at the existing image reservation and render funding boundaries. Existing wallet/allowance/ledger logic is reused. Client hints and idempotency/root strings cannot raise ceilings.
- The existing AutoMix receipt guard stays intact. Approved input carries its numeric count. Hero-only jobs cannot silently demote to stock; approved AutoMix may. External source maps to no stock; full import/window work belongs Task 3.
- Narration, caption/planning calls and completed media selections have persistent checkpoints. A budget hold preserves funding and artifacts, excludes automatic worker claiming and deploy-drain runnable counts, and exposes confirmation-required status. Recovery parks uncertain in-flight quote jobs rather than generically replaying them. Incremental receipts link immutable original approval, retained job and checkpoint revision/hash; they distinguish additional ceiling from cumulative exposure. Expired/rejected incremental quotes can be renewed through `prepare_video_job({resumeJobId})`.
- Unknown image/TTS submission outcomes fail closed. Generic failure/cancel cleanup cannot refund ambiguous image reservations. Known provider terminal outcomes permit reconciliation; pending-refund flags converge through settlement retry. Cancellation stays idempotent. Existing historical jobs without a quote reference retain their prior behavior.
- ElevenLabs submission reads the server-persisted approved voice/model; a changed account model cannot alter a job mid-flight. Shared render transfer cannot fall back to a fresh charge on quote-bound jobs. Shared broll rerolls refuse unapproved new creative work.
- Additive Prisma columns/indexes only; no migration/deployment executed. `prisma generate` and fixture `db push` ran locally. Runtime rollout requires normal schema rollout before new code.

## Tests-first evidence and layers

`verify-mcp-budget.ts` first executes the real source-extracted receipt guard with the real worker source mapping: ordinary USER returns `render_receipt_required` when maxAiImages is missing; ADMIN bypasses it. This is guard-level evidence, not full provider integration. Its initial atomic-consume test failed because the new service did not exist, before implementing it. A regression then proved generic image refund incorrectly released an ambiguous submitting attempt; the authority seam now retains it. Final entitlement verification initially failed at `assert.ok("jobId" in first)` / `plan_required`: the fixture had only a plan label, so existing synchronization downgraded it. The fixture now supplies actual PAID evidence and an active term; a paired revoked-entitlement test verifies refusal without consumption.

The same script uses real Prisma, quote approval/consumption, image reservation, existing credit ledger, render funding and cancellation/reconciliation against SQLite. It verifies unquoted zero-job behavior, approval/hash/owner/expiry checks, replay under different keys, concurrent consume, exact and over image ceilings, final-wallet concurrency, descendants, unapproved rerolls, trial allowance, shared total image-versus-duration race, retained TTS/planning/media across fresh callers, unknown TTS restart refusal, incremental approval/renewal, ambiguous cancellation and eventual pending-refund convergence.

`verify-mcp-budget-orchestrator.ts` runs an ordinary paid USER's prepare/approve/consume and the real orchestrator through held preview. Media/provider and render HTTP endpoints are stubs; the render stub executes the actual funding transfer and charged-clip recording. It asserts numeric AutoMix cap propagation, retained preview and settled funding once. Its initial red exposed protected `avatarMode: "none"` being treated as a presenter request; fixed by excluding `none` from the presenter branch.

## Verification

Commands run locally, exit 0 unless the intentional red failures above are noted:

- `npm ci --ignore-scripts`
- `DATABASE_URL=file:/tmp/task2-generate-only.db npx prisma generate`
- `npx tsc --noEmit --pretty false`
- Scoped ESLint across every changed/new TypeScript file (warnings only in existing route/worker code; no errors).
- `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-budget.ts`
- `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-budget-orchestrator.ts`
- `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-mcp-video-quote.ts`
- `npx tsx scripts/verify-mcp-create-input.ts` (17 cases)
- `npx tsx scripts/verify-render-receipt.ts`
- `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-minute-credits.ts` (9 cases)
- `NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-render-reservation-settlement.ts`
- `git diff --check`

## Explicit limits / downstream composition

No paid provider was called. Full real-fetch-stock → AutoMix final-export HTTP/browser composition and full build/suite remain Task 5; the new fixture demonstrates the real worker through held preview with provider stubs, not full end-to-end export. Task 3 must implement complete external import/window composition. Task 4 owns complete public guidance, billing summaries and broader Studio status presentation; basic hold status/receipt/resume hooks are present.

Unknown submissions without a provider ID remain retained for support reconciliation; incremental approval never authorizes implicitly retrying them. A known-outcome reconciliation can settle/refund image exposure, but no automatic resume is supplied for an unknown-outcome hold. Likewise an uncertain render transfer crash parks rather than initiating another paid render. A shared creative reroll outside the protected work refuses and requires a new workflow; this task does not add a creative-reroll quote UI. These fail-closed limits preserve ceilings but require review against desired recovery UX. No screenshot/visual claim is made for the small incremental receipt paragraph.
