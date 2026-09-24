# Approved diagnostic follow-up: HERO-10 / HERO-41 / HERO-51

Goal: deliver bounded reproducers, phase/operation evidence, and narrow review-ready PRs for demonstrated defects. Parent issues are not Done merely because diagnostic code or synthetic tests pass.

## Authorization and format
Mew approved all three recommendations on 2026-09-24: SQLite queue/callback separation, cleanup phase-cost and busy-yield investigation, and long acoustic offline evaluation; deliver code/tests and Markdown evidence, with PRs only for changes supported by an observed failing regression. This records the already approved scope, not a new interview. Prior production approval permits bounded read-only SSH evidence refresh; no generation, customer media download, cleanup run, production configuration change, merge/deploy or customer communication is authorized. No extra approval gate is inferred for local reversible diagnosis and PR preparation.

## Global Constraints
- Root checkout remains read-only; one Orca worktree/branch/PR per issue. Do not revert other work.
- Observe RED before implementation using test-driven-development; reuse repository verification patterns. Do not inflate mocks into proof of production performance.
- Keep existing Prisma retry, timeout, schema, transaction return/error/rollback semantics.
- Preserve cleanup checksum, catalog freshness/CAS, remote pre/post verification, quarantine/restore, scope and retention semantics. Never run production cleanup.
- Preserve ADR 0056: no subtitle gate, TTS regeneration, automatic paid retry or export realignment; existing 180s verification/60s production acoustic budgets and quality thresholds remain unchanged.
- No secrets, customer identifiers, transcript/prompt/media content, media URLs, SQL arguments or row data in committed logs/reports. Use synthetic offline fixtures; do not copy the two customer clips.
- Report uncertainty honestly: invocation is not a lock holder, local benchmark is not live latency, ASR is not human timing acceptance.

## Architecture and references
Use CONTEXT.md for terms; docs/adr/0056-subtitle-qa-is-a-report-not-a-gate.md and docs/adr/0006-media-retention-and-recovery-lifecycle.md remain binding. Current production-derived aggregate evidence is reports/hero-diag-three-20260924/evidence-refresh.md. Base is origin/main 3d2c27a65a96f88435bc4e9df45c26b493df0b35.

## Task 1 — HERO-10 transaction phases
Own src/lib/prisma.ts, directly relevant diagnostics helpers and scripts/verify-prisma-slow-tx.ts/fixtures; avoid unrelated application transactions. Seam: actual Prisma interactive transactions against disposable SQLite, including concurrent invocations through independently bundled callers. Establish missing phase distinction RED, add minimal content-free numeric queue/callback/total diagnostics, and demonstrate delayed callback entry versus slow callback work separately. Preserve callback context/options/results/errors and array transaction behavior; never call callback duration exact SQLite lock hold time. Include concurrency and rejection/timeout-before-entry, disabled instrumentation, bounded privacy tests. Existing 20,065 ms render invocation is evidence of a slow call only.

## Task 2 — HERO-41 cleanup cost and busy yield
Own cleanup planner/eviction/missing-local-reconcile/yield/activity code and directly related verification/benchmark scripts; avoid Prisma instrumentation. Seam: actual planner and runner with disposable SQLite/local files and fake remote I/O only. First measure per-phase/operation costs and demonstrate work arriving during expensive apply iterations. Compare default polling behavior, not just forced test settings. Create RED for an observed deferral defect and fix the narrow root cause. Evaluate catalog, manifest, hashing and remote work using representative scales and clearly label fixture limitations. Preserve every integrity and recovery safeguard. Target: after active work becomes observable at a safe boundary, cleanup defers before starting the next independent object; no mid-object stranding. If unavailable or no regression exists, deliver bounded evidence rather than inventing a speed fix. May add minimal phase counters necessary for natural production observation; no new profiler dependency or budget increase.

## Task 3 — HERO-51 offline long acoustic evaluation
Own scripts/subtitle-alignment, acoustic worker/clock modules, directly related tests/benchmark only; no general orchestrator behavior/quality changes unless explicitly justified and reviewed. Seam: real engine emissions path using local synthetic/noncustomer fixtures, process deadline/phase diagnostics and output timing invariants. Inspect available offline runtime/model first; no provider calls or production inference. A dedicated local venv and one-time download of public dependencies/exact pinned official model are permitted as necessary preparation; inference itself must run offline, without shared-environment mutation. Test 120/approximately200/approximately270/300 second inputs with bounded runs. Separate cold load, decoding, emissions, alignment, memory and timeout behavior. Evaluate bounded chunk processing as an experiment, measuring timestamp coverage/monotonicity/boundaries and comparison against short known timing fixtures. Accept production change only when actual failing mechanism is reproduced and fixed with quality preserved; otherwise deliver runnable harness + measured recommendation and environment limits. Do not claim silence or fake models prove Thai speech quality. Recent long jobs failed verification with incomplete_alignment/text_mismatch and timed out in emissions; not both verification timeouts.

## Assurance and Budget
- Profile: high-assurance
- Risk: high — transaction wrapper and media cleanup integrity paths; changes remain isolated/local until review.
- Automatic fix rounds per task: 5; escalate after 3 if needed.
- Maximum subagent runs: 15 initial runs; at ceiling adjudicate without silent expansion.
- Concurrency: three independent workers in the three available slots, then reviewers.
- Usage checkpoints: before execute, after frontier wave, before final gate; token dashboard unavailable, record agent runs and checkpoints.

## Execution Directive
| # | Task | Agent | Mode | Blocked by | Review gates |
|---|---|---|---|---|---|
| 1 | SQLite phase diagnostics | mew-worker-heavy | subagent | — | RED/GREEN, scoped tests, Tier 1, final correctness/security |
| 2 | Cleanup cost and safe deferral | mew-worker-heavy | subagent | — | RED/GREEN, benchmark, integrity suites, Tier 1, final correctness/security |
| 3 | Long acoustic offline experiment | mew-worker-heavy | subagent | — | runtime evidence, timing regression if changed, Tier 1, final correctness/security |

## Acceptance Criteria
- [x] Three reports identify exact commands, inputs, RED/GREEN where applicable, numerical findings, limits and next gate.
- [x] SQLite phase data distinguishes queue from callback without changing transaction semantics or exposing content.
- [x] Cleanup has bounded cost evidence and either a verified busy-yield fix preserving integrity or a precise unresolved finding.
- [x] Acoustic has a runnable offline experiment, actual model results when environment permits, and no unsupported quality claim.
- [x] Relevant regressions/types/lint/build pass for resulting code; baseline failures are separated.
- [x] Independent task review and profile-required final correctness/security review clear blockers.
- [x] Supported changes have issue-scoped PRs; no merge/deploy or parent Done claim.

## Out of scope
Production execution, tuning budgets, DB migration, paid replay, customer media processing, UI changes and support communication.

## Status
approved: 2026-09-24 (explicit approval of all three recommendations) | executed: 2026-09-24 | delivered: 2026-09-24 (PR543/544/545; all CI and review gates pass)
