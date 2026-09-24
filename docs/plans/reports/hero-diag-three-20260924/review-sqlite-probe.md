# Tier 1 re-review — HERO-10 SQLite probe

Reviewed privacy-only delta `b504590e...8dfe4347`.

## Spec / correctness

**Cleared.** `FixedErrorArgumentParser.error()` converts parser failures to the fixed `invalid command line` error before output. New blank-environment fixture canaries cover invalid duration and interval, unknown argument, missing required argument, and invalid PID class; each requires exit 2, empty stdout, exact fixed stderr, and no sentinel. Independent invalid-duration and unknown-argument invocations also emitted only that fixed message.

No application code, natural observation, or SSH action appears in this delta.

## Standards

No applicable documented-standard breach or actionable baseline smell found.

Validation: blank-environment privacy fixture and Python compilation passed. Previous Linux evidence was not rerun locally.
