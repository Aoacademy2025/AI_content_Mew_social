# HERO-10 / HERO-41 / HERO-51 — approved follow-up delivery

Date: 2026-09-24 (Asia/Bangkok). Status: deployed and smoke-verified at `fdc4b984` (14:38 Bangkok); parent issue outcomes remain open. See [release follow-up](release-followup.md).

Latest approved evidence pass (19:39 Bangkok): [natural observations and VPS acoustic matrix](observation-followup.md). Cleanup safe busy-yield is now observed; the bounded acoustic matrix completes with three long-case emissions timeouts. Parent outcomes remain open.

| Task | Deliverable | Independent task review | Parent issue outcome |
| --- | --- | --- | --- |
| SQLite — HERO-10 | [PR #543](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/543), issue head `9aec6657`; [evidence](task-1.md) | [Clear](task-1-review.md) | New diagnostic separates before-callback and callback time; actual lock holder still unknown. |
| Cleanup — HERO-41 | [PR #544](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/544), issue head `f75ff386`; [evidence](task-2.md) | [Clear](task-2-review.md) | Reproduced/fixed late busy polling in both apply loops; production 90-minute cost remains unresolved. |
| Long acoustic — HERO-51 | [PR #545](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/545), issue head `431ce583`; [evidence](task-3.md) | [Clear after one fix round](task-3-rereview.md) | Exact engine succeeds locally on synthetic long Thai speech; no production algorithm/budget change or perceptual acceptance. |

## What changed

SQLite preserves the existing slow-transaction prefix/source and appends invocation-specific phase timings. Real disposable SQLite tests separate delayed entry and callback work, cover rejection before entry and independently bundled callers, and preserve array/interactive semantics, results, errors and logging privacy. These phases are not exact SQLite lock-hold duration.

Cleanup now forces the existing customer-activity gate at safe boundaries before each independent apply object/row. A complete object finishes its integrity/quarantine/restore work before the next check. Default-cadence RED/GREEN covers both local eviction and missing-local reconciliation. The benchmark measures local phase and operation cost. Its polling-suppressed comparison arm uses the same head, not a checkout of the previous revision; added 326 activity queries cost 32–35ms locally, without proving production speed.

The acoustic deliverable is an offline actual-engine harness, synthetic Thai speech fixture generator and CI regressions. One-time isolated preparation downloaded public dependencies and the exact pinned CTC revision; all inference used offline flags. On Apple M4, approximately 121/200/272/302 seconds of synthetic audio completed in 11.35/17.71/23.75/28.09 seconds, with sampled peak RSS about 3.4GB. The synthetic timing result is not varied-natural-speech or human onset acceptance. Production timeouts were not reproduced, so chunking and budget changes would be speculative and were not made.

Independent review found that the original benchmark could accept incomplete character/boundary evidence. A public-seam baseline regression demonstrated the wrong aligned result with 1/6 eligible spans and 1/2 boundaries. The fix requires exact, ordered eligible spans with no missing/duplicate/unexpected spans plus complete nonempty known boundaries. Raw rounded coverage is diagnostic only. Stored successful matrix evidence was revalidated against the stricter checks; no full inference repeat was needed.

## Verification and release boundary

Integrated verification head: `e639dca1839dcd74a89cf96ac783eb8e86b52edd` on the local control branch, based on deployed `3d2c27a6`. The three issue branches remain separate; the control branch is not a release request.

Scoped combined checks pass: Prisma options/slow-transactions/transient retry; TypeScript and changed-file lint; subtitle audio/provider/partial/deadline/acoustic suites; Python engine/fixture/harness; and full media integrity chain. The media chain's first detached run lacked a captured exit, so it was rerun with retained completion and exit 0. A preview progress assertion failed once in a wider worker run; exact base and issue-head isolated replays passed108/108, and combined broader verification passed.

CI for PR543 passed14m12s ([run](https://github.com/Aoacademy2025/AI_content_Mew_social/actions/runs/35961159893)); PR544 passed13m38s ([run](https://github.com/Aoacademy2025/AI_content_Mew_social/actions/runs/35961174487)). PR545 final-head CI passed10m54s ([run](https://github.com/Aoacademy2025/AI_content_Mew_social/actions/runs/35962090913)). Final integrated build passed once at e639dca1 (exit0), and final security/privacy review is clear. Whole-branch correctness review is also clear; no medium-or-higher blockers remain.

## Remaining work

- HERO-10: after an authorized release, correlate natural before-callback/callback timings with concurrent events; preserve the seven-day production acceptance gate.
- HERO-41: verify natural busy yield after an authorized release, and investigate remaining production per-phase costs. Local benchmark cannot account for 90 minutes or certify elimination of shared-lock starvation.
- HERO-51: run the same noncustomer harness on deployment-equivalent hardware/load before choosing an acoustic performance change. No customer media was copied or processed; the original long-output timing complaint remains open.

The original implementation sign-off preceded merge/deploy; the release follow-up above records subsequent authorized actions. No production cleanup was manually triggered, and no provider replay, customer reply, financial mutation or parent-issue Done transition occurred. No new support-ticket correlation or Sentry-clearance claim. The three canonical Linear issues remain the tracking links.

## Review records and advisories

- [Combined verification](combined-verification.md): one full build, captured exit0; scoped suites pass.
- [Final correctness](final-correctness.md) and [final security/privacy](final-security.md): clear at exact integrated e639dca1.
- Nonblocking: cleanup comparator is a same-head polling-suppressed control; acoustic offline flags constrain libraries rather than providing an OS network sandbox, and timeout controls the trusted direct child rather than arbitrary descendant commands.
- Execution: one independent implementation wave, one acoustic fix/review round;9 initial agent runs plus2 followups.
- Fresh Linear reads retained HERO10 InProgress, HERO41 ReadyToDeploy and HERO51 InProgress. HERO41's prior-release verification state does not mean PR544 has shipped.
