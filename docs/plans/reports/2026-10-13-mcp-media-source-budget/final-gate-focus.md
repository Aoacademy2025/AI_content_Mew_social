# Integration and independent final gate focus

Baseline: `4c2461805dcc2633675996a82ce391cfe706ff60`.
Final candidate: `24a7b170239a81fde00694bb30857c1f92db5e94` (Task5 round1 corrections; independent correctness PASS, final security resumed with approved run25). Task5 report records resolved hook/fixture obligations and public image-boundary probe; independent final review remains pending.

## Verification obligations carried forward

- Legacy `verify-mcp-edit-draft.ts` failed 21 pass / 13 fail at Task 3 because fixtures assume unquoted immediate creation. Migrate through actual prepare/approve/consume, preserving behavior assertions; do not suppress failures.
- Probe Task 2 image parent/body mismatch advisory for public reachability; authoritative budget resolution must not be bypassable by a historical/unbound parent.
- Probe Task 3 mounted web lifecycle when `pendingEdit` becomes null after Apply/export. `pendingRevisionRef` must not strand the next valid mutation with stale CAS; no finding is considered reproduced yet.
- Legacy `verify-mcp-chain-export.ts` has 145 passing checks but two obsolete source-string assertions about direct createMcpVideoJob routing/reserved-key copy; migrate to requestVideoJob behavior checks.
- Legacy `verify-mcp-audit-status.ts` exits1 on source-location assertion for VIDEO_JOB_INFLIGHT_STATUSES moved into the shared service; replace with real overlap-refusal behavior.
- CI must reach every new verification script, including external-policy/native-upload scripts without the MCP name prefix.
- Four ordinary USER source paths must reach final export; provider/render output stubs must be stated precisely. Script and presenter external paths need real import normalization and required-slot ownership checks.
- Run meaningful full regression selection, TypeScript, changed-file lint, production build and MCP CI coverage once after integration fixes. Repeat scoped checks only for subsequent changes or unresolved failures.
- UI evidence must distinguish browser fixture sessions from real Clerk/proxy integration. Passing fixtures do not establish live production readiness.

## Correctness review

Fresh independent reviewer, own worktree, gpt-6-astra medium. Check plan/spec and whole baseline-to-candidate delta. Concentrate on durable checkpoints and known-result recovery, incremental approvals, ordinary USER AutoMix final export, external required-slot web/MCP parity, mutation CAS and final activation, receipt reconciliation across funding transfers/refunds/trial allowances, historical/free export compatibility and CI coverage. Independently run focused checks; do not repeat the full build without new evidence.

## Security review

Fresh independent reviewer, separate own worktree, gpt-6-astra medium. Check Clerk-only approval/same-origin POST/owner/expiry and immutable input identity, concurrent consume/replay atomicity, authoritative quote attribution across shared routes and descendants, total and component ceilings under retries/ambiguity/cancellation, malicious service-body omissions/mismatches, import ownership/SSRF/token/byte limits, non-bypassable required external policy at final export, privacy and agent-neutral public errors. Reproduce reachable bypasses; label source-only defenses separately.

## Isolation and delivery

Orca copied `.env` and `.env.r2.production` even with `--setup skip`. Every new worktree must remove its own copied env files before imports/tests and force disposable `DATABASE_URL` before Prisma generation or importing application modules. Never inspect or print env contents. No production writes, provider charges, deployment, restart, customer replies or Linear mutation.

Deliver an independently reviewed PR with additive schema instructions. Rollback must drain quote-bound work or retain enforcement; removing gates cannot permit unapproved or unpaid operations. HERO-70 SQLite contention remains a separate unresolved risk.
