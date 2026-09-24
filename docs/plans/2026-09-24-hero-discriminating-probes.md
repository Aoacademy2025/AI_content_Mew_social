# Approved discriminating probes — HERO-10 / HERO-41 / HERO-51 / build

## Authorization and deliverables
Mew approved the next steps in `reports/hero-diag-three-20260924/observation-followup.md` and its linked reports: “approve ทำตามที่แนะนำเลย”. Continue the approved diagnosis without another interview. Deliver narrow tested tools/diagnostics and PRs where warranted, numerical experiment evidence and this report trail. Base: origin/main fdc4b984. No product tradeoff or production acoustic/heap/timeout policy change is inferred.

## Global Constraints
- Root checkout is read-only. Each code task owns a fresh Orca worktree from fdc4b984, its branch and PR. Do not revert other work.
- Written spec requires failing regression before implementation. Use existing helpers and standard-library tools; no new dependency unless unavoidable.
- Never expose secrets, env dumps, customer identities, transcript/media content or URLs, SQL parameters, raw logs or process command lines. Diagnostics emit numeric/fixed static fields only.
- No paid generation/retry, customer media copy, financial mutation, customer communication, manual production cleanup, or schema/retention change.
- Preserve Prisma semantics/options/error/return behavior; timing and caller attribution are not lock ownership.
- Preserve per-object graph freshness, checksum, remote pre/post verification, catalog CAS, quarantine/restore and safe busy yield. No shared stale graph optimization.
- Preserve ADR0056 and existing180s verification/60s acoustic budgets, exact pinned model, quality thresholds and production two-thread config. Experiments may change only their private copies and temporary unit controls.
- SSH and bounded private synthetic host experiments are authorized. Root serializes host workloads. No automatic retry if customer/cleanup arrives. No diagnostic build solely to produce memory data.

## Tasks and acceptance
1. **HERO-10 / SQLite:** add only missing generated caller column with privacy/semantic regressions if justified; provide a minimal bounded Linux read-only lock observer and disposable WAL known-holder regression. Prove inode/range interpretation against writer/read-only/checkpoint cases as applicable; fail closed for unsupported formats/modes. Distinguish OS holder PID/process class from business operation. First validate on synthetic Linux data, then root may run a bounded read-only natural observation; zero events is valid and not a holder finding.
2. **HERO-41 / cleanup:** add minimal aggregate operation timers/counts for reference-graph rebuilding versus hash/remote/catalog/other apply costs, using existing report path. Prove phase presence/attribution RED then GREEN with injectable monotonic clock or actual isolated runner and synthetic data. Demonstrate graph-build repetition at representative synthetic scale. No performance optimization until measured; safety outcomes unchanged. Natural measurement requires later diagnostic deployment; no forced cleanup.
3. **HERO-51 / acoustic:** prepare a private copy of the approved package for one 400% CPU quota control with unchanged two threads and60s deadline. Short+120 must preserve exact spans/known boundaries and memory/resource gates before200. Capture per-case CPU throttle deltas; same customer/cleanup abort/no network/private cache/6G/480s bounds. If still timing out and idle, one private geometry A/B (20s vs40s interiors, same2s context), no production engine edit. Stop that variant on quality failure, customer arrival, or resource gate. After quota and geometry have been separated, the linked approved acoustic report also permits one separate private two-versus-four-thread control under the same400% cap and original20s geometry; use the same progressive gates and fresh idle admission. This clarification preserves the user's approved third experiment and does not authorize a production thread change or retries of aborted runs. Report results and limits; no production tuning.
4. **Build sampler:** prepare a standalone, opt-in stdlib Linux sampler for the next necessary build, private0600 JSONL with PID+starttime, allowlisted role/stage/effective numeric heap, PSS/private/RSS/swap and host available RAM. Persist through SSH loss when operator launches under systemd/nohup. Fixture tests RED/GREEN for PID reuse/exits, parser privacy, lifecycle/bounds; synthetic Linux smoke only. No deploy integration/default activation or heap change.

## Execution Directive
| Task | Agent | Mode | Blocked by | Gates |
| --- | --- | --- | --- | --- |
| 1 | mew-worker-heavy | subagent | — | TDD, Linux fixture, Tier1, security/correctness |
| 2 | mew-worker-heavy | subagent | — | TDD, integrity suites, Tier1, security/correctness |
| 3 | mew-worker | subagent | — | private package review, controlled run, numeric review |
| 4 | mew-worker | subagent | free slot | parser/lifecycle TDD, Linux fixture, Tier1 |

## Assurance and Budget
High assurance for cleanup integrity and root-host diagnostic privacy. Maximum12 new agent runs plus2fix rounds per task; reuse workers. Three worker slots, root coordinates approved host execution. Fresh independent reviewers. Scoped checks per task, then one combined TypeScript/build if application code changes. No duplicated full builds. Usage dashboard unavailable; record run counts in follow-up report.

## Status
approved:2026-09-24 | executing:2026-09-24 | delivered:2026-09-24 (tools, reviewed PRs and evidence; four-thread host control deferred on customer activity)
