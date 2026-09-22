# HERO-51 bounded subtitle verification
## Goal and authorization
Deliver a review-ready PR implementing the existing bounded-deadline/validated-partial-result proposal. Mew explicitly selected the proposal and requested both PRs on 2026-09-23, with unattended completion. This resumes the handoff proposal; no repeated interview or new-session gate is needed. Production release remains outside scope.
## Architecture and references
Private source brief (read only; do not commit): /Users/mewsocialmacmini/orca/workspaces/AI_content_Mew_social/hero-ops-investigation-20260923/artifacts/investigation-20260923/HERO-51-PROPOSAL.md.
Read ADR 0056, current transcribe timeline/quality/partial-clock code and pipeline authentication. Existing domain terms in CONTEXT.md.
## Global Constraints
- Root checkout stays read-only. Work only in the assigned Orca worktree, based on 671fe0250f33cb282f726da8617939711198bead (fresh origin/main).
- No merge, deployment, paid provider calls, customer replay, customer communication, financial adjustment or historical backfill.
- Private customer text/media/identifiers and secrets must never enter tracked files, PRs, Linear or logs. Use synthetic fixtures.
- Read CLAUDE.md, CONTEXT.md, relevant ADRs and local Next docs. Follow existing narrow verification patterns; failing behavioral test before implementation.
- No changes to subtitle timeout budgets, timing quality thresholds, provider fallback order, TTS regeneration or export realignment. QA stays a report (ADR 0056).
- Separate PR per issue. Commit explicit source/test/plan paths only; never artifacts, .orca, media, environment files.
## Assurance and Budget
- Profile: high-assurance
- Risk: high — cancellation/accounting boundaries for HERO-51; telemetry privacy boundaries for HERO-46.
- Automatic fix rounds per task: 5
- Maximum subagent runs: 12 across both issue branches; reuse implementers for fixes.
- Concurrency: 4 live slots including session.
- Usage checkpoints: before execute, after frontier, before final gate; unavailable exact usage is reported as unavailable.

## Execution Directive
| # | Task | Agent | Mode | Blocked by | Review gates |
|---|------|-------|------|-----------|--------------|
| 1 | Implement bounded internal transcribe mode, partial words and acoustic phase telemetry with regressions | mew-worker-heavy | subagent | — | scoped tests, TS, build, independent spec/standards and security review |
## Task 1
Own src/lib/mcp/pipeline-client.ts, src/lib/mcp/orchestrator.ts, src/app/api/videos/transcribe/route.ts, minimal related transcribe/acoustic files and scripts/subtitle-alignment/engine.py, and meaningful verification scripts. Discover exact neighboring paths before changes; avoid speculative service abstractions.
- Add optional trusted internal cancellation/deadline seam. Derive/clamp route deadline on authenticated server path; public callers cannot extend budgets or bypass accounting.
- Preserve 180s verification / 60s acoustic budgets; reserve 2s response margin inside outer budget, with injected/deterministic-clock tests.
- All internal fetches/backoff/recovery stop launching new work at deadline. Abort supported in-flight operations and bound late rejection. Cleanup and existing quota/usage settlement remain correct.
- Return only validated completed chunk words with explicit incomplete warning; apply unchanged HERO-13 eligibility. Keep transcribe_desynced/chunk_recovery_exhausted disqualifying. No usable chunk uses current fallback.
- Add bounded numeric/fixed-code phase timing for lock wait, model load, decode, emissions, alignment, timeout phase and coarse audio bucket. No raw errors/content/URLs/identity. Cannot affect render success.
## Acceptance Criteria
- [ ] Observed RED then GREEN at actual route/caller behavior: 3 chunks, first complete, second stalls/aborts, third/retry never starts; validated completed words retained.
- [ ] Zero completion, invalid words, disqualifying warnings, sufficient/insufficient partial coverage, late rejection, cleanup and quota settlement covered.
- [ ] Successful alignment, ElevenLabs, direct/upload transcription, fallback and no export realignment regressions remain green.
- [ ] Acoustic phase instrumentation has bounded privacy-safe output and timeout attribution; no host benchmark or claimed measured dominant cause.
- [ ] TypeScript and production build pass; independent review blockers resolved.
- [ ] PR clearly distinguishes functional tests from real customer timing/perceptual improvement, which remains unverified.
## Verification seams
Approved proposal's pipeline-to-transcribe behavior; partial clock selection; acoustic worker diagnostics output. Use synthetic/mock provider responses, no live DB/provider calls. Prefer existing fixture harness.
## Out of scope
Larger timeouts, persistent model workers, deployment-host benchmarks, paid regeneration, historical subtitle rewrite, human perceptual sign-off.
## Status
interviewed 2026-09-23 | approved: 2026-09-23 (existing proposal explicitly selected) | executed: complete | delivered: pending PR
