# HERO-46 content-free editor diagnostics
## Goal and authorization
Deliver an independently reviewed instrumentation PR for the confirmed production React maximum-update-depth incident (Sentry WEB-13, 7746833693). Root cause remains unknown; do not invent a fix or mark incident resolved. Mew explicitly requested preparation of both HERO-51 and HERO-46 PRs on 2026-09-23 and unattended completion.
## Architecture and references
Private brief (read only; do not commit): /Users/mewsocialmacmini/orca/workspaces/AI_content_Mew_social/hero-ops-investigation-20260923/artifacts/investigation-20260923/HERO-46-INSTRUMENTATION.md.
Read CONTEXT.md editor lifecycle, docs/ops/linear-sentry-observability.md, existing sentry-config and EditorV2Shell/recovery hooks. Existing NO_REPRO probes and Next fixture are in the private investigation worktree.
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
| 1 | Attach bounded content-free editor state only to existing relevant depth exception | mew-worker-heavy | subagent | — | privacy envelope, render/autosave probes, TS/build, independent spec/standards and security review |
## Task 1
Own narrowly scoped editor diagnostic helper/hook, EditorV2Shell/input/recovery integrations, existing Sentry sanitization only where necessary, and regression scripts. Do not patch persistence behavior or claim root cause.
- Snapshot lives in mutable refs; collection never sets React state or adds rendering/effect loops.
- Allow only fixed enums: editor phase, lifecycle new/loading/ready/recovery-conflict, recovery validity/version, server/local revision relation same/older/newer/unknown, save-state, standard input-type allowlist (unknown => other), composition boolean, focus target enum, mount count capped at 10. Optional last 8 enum transitions.
- Attach snapshot only to existing matching depth exception, only while editor mounted. Clear on unmount, avoid global data across routes/users. Bound per-mount attachment/capture strictly without duplicating the app's exception.
- Exclude script/transcript/clipboard/HTML/selectors/IDs/URLs/arbitrary properties/localStorage/raw errors; no replay or broadening Sentry privacy defaults.
## Acceptance Criteria
- [ ] RED then GREEN privacy test seeds forbidden synthetic canaries and checks final beforeSendSentryEvent output/envelope, unknown values bucketed.
- [ ] Input/recovery collection changes no render counts, autosave calls, draft values or recovery choices; strict per-mount bound.
- [ ] Matching error has allowed facts and existing release; unrelated errors and unmounted/other routes have no editor context.
- [ ] Existing full-shell recovery and real Next hydration/router probes pass; native IME/full production layout limits stated honestly.
- [ ] TS and production build pass; independent blockers resolved; no production root-cause fix asserted.
## Verification seams
Actual editor hooks/input/autosave plus final Sentry sanitization/capture boundary. Adapt existing synthetic harnesses; do not repeat NO_REPRO diagnosis without testing newly introduced collection.
## Out of scope
Root-cause patch without observed reproduction, changing autosave/recovery decisions, production deployment, customer replies, enabling replay.
## Status
interviewed 2026-09-23 | approved: 2026-09-23 (both PRs explicitly requested) | executed: 2026-09-23 | delivered: -
