# Public MCP media approval rollout and rollback

This is a reviewable operational plan, not deployment authorization. No migration, production write, restart or provider rehearsal was performed for this change.

## Behavior and compatibility

New public MCP creations prepare an owner-scoped receipt before work starts. The authenticated Studio owner approves exact resolved work and its spending ceiling. Agent-supplied approval booleans do not authorize execution. Approval itself reserves nothing; quote consumption atomically creates/funds one root. Stock, Hero AI Image, AutoMix and external media share the gate. External media uses zero Hero image-generation credits and still discloses render use and external charges.

Historical jobs without a quote retain their original reservation and waiting-import semantics. Quote-bound descendants inherit approval and retain image/render/total caps through retries and settlement. Unknown provider outcomes retain exposure. Supported continuation is exact-work cap approval/resume; a changed creation needs a new approved job. Imported replacements use the shared editor. There is no per-window creative-reroll receipt UI.

## Additive schema, before application/worker enablement

The Prisma delta adds `McpVideoQuote`, the User relation, optional `VideoJob.budgetQuoteId` and `budgetCheckpointJson`, `budgetCheckpointRevision` with default zero, optional `AiGenerationJob.budgetQuoteId`, and lookup indexes. It removes or renames no existing columns. No backfill assigns quotes to historical jobs.

After separate deployment authorization:

1. Follow the existing backup/change-control procedure and verify recoverability. Review the exact candidate and green CI.
2. Apply the additive schema using this repository's established `prisma db push` deployment path **before** starting any route or worker compiled against these fields. Generate the matching Prisma client. Do not run an old worker concurrently against newly admitted quote-bound work.
3. Enable the matched application and worker build together. Verify signed-out and foreign-owner receipt denial, same-origin owner approval, read-only quote observation, one-time consume/replay, and one owned canary through export. A real provider rehearsal requires its own authorized spending ceiling.
4. Observe confirmation holds, failed/replayed consume, reservations versus settlements/refunds, required external slots, and worker failures. Use identifiers and codes, not scripts, private media URLs or credentials in logs.

HERO-70 SQLite contention remains separate and unresolved. Passing the isolated tests does not establish production concurrency or live Clerk/proxy readiness.

## Safe rollback

Do not remove only the public approval gate or budget admission checks. That could authorize unapproved spend or strand reserved work.

Stop admitting new quote-bound work, while retaining this build's approval and budget enforcement for existing roots, descendants and in-flight image/render operations. Drain and reconcile those jobs, including `confirmation_required` holds and ambiguous provider submissions, before reverting to code unaware of quotes. Alternatively retain the enforcement/settlement code in the rollback build until all such work is terminal and reconciled. Use the existing cancellation/refund paths; never clear unknown exposure merely to permit retry.

Keep the additive columns/table and their receipts/checkpoints during rollback. Do not drop quote/ledger records or rewrite old jobs as historical/unbound. If safe drain is not possible, keep the enforcing build stopped from new admission and investigate before reverting.

## Verified boundary

The integration suite uses disposable SQLite, actual quote/owner-service/consume logic, the orchestrator, funding/settlement, shared editor/export, and real ffmpeg media-import normalization. Paid TTS/image/provider endpoints and video render/composite outputs are stubbed. Preview-frame regression does render local synthetic media with Remotion. Browser receipt sessions are explicit test-only identities; real Clerk session/proxy behavior was not rehearsed. No live-readiness claim follows from these results.
