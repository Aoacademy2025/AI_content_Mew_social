# Final security and privacy review — HERO-10 / HERO-41 / HERO-51

## Verdict

**Clear: no open high-confidence medium-or-higher security, privacy, or data-integrity findings at the final integrated head.**

Reviewed integrated range:

- Base: `3d2c27a65a96f88435bc4e9df45c26b493df0b35`
- Final head: `e639dca1839dcd74a89cf96ac783eb8e86b52edd`
- Integrated commits: `cf531596` (HERO-10), `0da464c7` (HERO-41), `b57d26ed` plus `e639dca1` (HERO-51)

The issue-worktree changes are patch-identical to their integrated commits:

| Issue | Issue head | Integrated commit | Stable patch ID |
| --- | --- | --- | --- |
| HERO-10 | `9aec6657755dbea458d20f172e73b24377ae2b1a` | `cf531596` | `532be11f91ffe54294f21326cdab426022508d01` |
| HERO-41 | `f75ff386ae011873cba2733488cb0ee52e286c0f` | `0da464c7` | `a95e77d975568488683b914e1b6e49d2b9baad7a` |
| HERO-51 initial | `2f1a1df0d6d8d49c3fb7d7666c5ca3a570aabc15` | `b57d26ed` | `333aebd54a58391e65dc826cd3744b11c242763e` |
| HERO-51 fix | `431ce583a424b4e5267e0b9f6f2d28efba87bbc5` | `e639dca1` | `17a4569f00f8b13e2adee58831b2864d59c64188` |

Authority reviewed: `docs/plans/2026-09-24-hero-diag-three.md`, `docs/plans/reports/hero-diag-three-20260924/review-criteria.md`, ADR 0006, ADR 0056, the three task reports/packages/reviews, and the complete integrated diff.

## Finding disposition

### M1 — resolved — incomplete acoustic evidence could be labelled `aligned`

**Affected range:** HERO-51 initial head `2f1a1df0...`; integrated head `b57d26ed...`; former `scripts/subtitle-alignment/long_benchmark.py:212-214`.

The initial acceptance predicate required pinned identity, monotonic timing, and duration tolerance, but did not require complete eligible-character coverage or complete known-boundary evidence. A child result containing only the first timing for a two-word synthetic fixture therefore produced `coveragePermille=167` and `boundariesComplete=false` while satisfying the old `aligned` predicate.

**Reproduction:** the direct `validate_result` probe returned `acceptedByCurrentPredicate=true`, `coveragePermille=167`, and `boundariesComplete=false`. The permanent public-seam regression also captured the old `run_case` result as `status=aligned` before the fix.

**Resolution:** issue head `431ce583...`, integrated as `e639dca1`, adds `is_aligned_result` at `long_benchmark.py:49-53`, exact ordered eligible-span comparison and numeric missing/duplicate/unexpected counts at lines 97-116, and applies the strengthened predicate at line 233. `aligned` now requires exact span completion and a nonempty complete boundary set. The seven-test harness covers the positive case, missing spans, duplicate spans, absent boundaries, real-child incomplete output, timeout privacy, and venv launcher preservation. The real-child negative now returns `invalid`.

No open finding remains from M1.

## Security and privacy assessment

### HERO-10 — Prisma transaction diagnostics

`src/lib/prisma.ts:83-101` reduces stack provenance to `app/...:line`, `src/...:line`, or `scripts/...:line`, and otherwise emits `unknown`; it does not retain an absolute deployment path. The log at lines 143-154 contains only a sequence number, total/phase milliseconds, the static relative source, transaction kind, and callback-entry bit. It does not include transaction arguments, SQL, models, rows, error objects, database URLs, or customer identifiers.

The wrapper keeps batch and interactive forms separate, forwards callback arguments, callback `this`, and per-call options, and preserves result/error identity. Its diagnostic sink is caught inside `finally`, so logger failure cannot replace a transaction result or exception. A timeout before callback entry remains distinguishable without claiming lock ownership. No retry, schema, timeout, rollback, or transaction return behavior changed.

### HERO-41 — local media cleanup

The only production-path change is the forced activity poll before each whole apply unit at `src/lib/media-local-eviction.ts:459-465` and `src/lib/media-local-missing-reconcile.ts:296-310`. A positive gate therefore returns before the next quarantine or catalog transition begins. It cannot return while `evictOne` has an object quarantined or while restoration is pending.

The existing object path still performs fresh catalog inspection, manifest/checksum validation, quarantine, staged-file size/mtime/SHA-256 verification, remote post-quarantine verification, catalog compare-and-set, unlink, and restoration on every failure after quarantine. Missing-local reconciliation still rechecks canonical-path absence immediately before its catalog compare-and-set. Rollout, scope, retention, object/byte caps, R2-delete prohibition, runtime-budget precedence, and latched-yield semantics are unchanged. No production cleanup was run.

### HERO-51 — fixture, subprocess, output, and offline boundaries

The benchmark invokes Python and the engine with an argument array rather than a shell. It restricts report IDs to a fixed safe alphabet, passes transcript and local audio path to the child through stdin, ignores arbitrary stderr text, accepts only fixed phase names, validates audio/text hashes, and retains fixed/numeric report fields. The timeout path kills and waits for the direct child. Output directories are created privately when new, and the numeric report is chmod `0600`. Generated audio, manifests, weights, transcripts, and result JSON are absent from the repository.

Runtime sets `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`; the exact reviewed engine also calls both model loaders with `local_files_only=True` during normal inference. Model download remains a separate explicit preparation command. No provider call, production inference, paid retry, TTS regeneration, subtitle gate, export realignment, budget change, or production engine change is present.

The committed plan/reports contain aggregate counts, durations, hashes/revisions, issue links, and local synthetic-artifact paths. The review scan found no secret, API credential, customer/record identifier, transcript/prompt/media content, media URL, SQL argument, or row data.

## Non-blocking limits

- Offline enforcement is at the library/environment level, not an operating-system network sandbox. For the exact reviewed engine this is reinforced by `local_files_only=True`; the conclusion does not extend to an untrusted replacement passed through `--engine`.
- Timeout cleanup is proven for the direct engine child, not an arbitrary descendant process tree. The reviewed engine does not intentionally fork, so this is advisory for any future expansion of the harness.
- The acoustic measurements are synthetic host-local operational evidence. They are not deployment latency evidence, ASR acceptance, or human Thai timing acceptance.

## Independent verification at final head

| Command | Exit | Evidence |
| --- | ---: | --- |
| `npm run verify:prisma-slow-tx` | 0 | Callback, pre-entry timeout, batch, bundled callers, disabled mode, result/error identity, and content-free grammar passed. |
| `npm run verify:media-local-eviction` | 0 | Eviction, rollback, busy-yield, and exit-code checks passed. |
| `npx tsx scripts/verify-media-local-missing-reconcile.ts` | 0 | Checksum-gated, fail-closed reconciliation and safe object-boundary deferral passed. |
| `python3 scripts/subtitle-alignment/test_prepare_long_fixtures.py` | 0 | One fixture/boundary test passed. |
| `python3 scripts/subtitle-alignment/test_long_benchmark.py` | 0 | Seven harness, privacy, deadline, and strengthened-invariant tests passed. |
| Python `py_compile` on the four new Python files | 0 | Passed. |
| `git diff --check 3d2c27a...e639dca1` | 0 | Passed. |

No full build was run in this review; the combined verification worker owns that gate. No production action or production/code edit was performed by this reviewer.
